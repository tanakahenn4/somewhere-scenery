import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(SCRIPT_DIR, "..", "index.html");
const LEGACY_DOCUMENT_PATH = "catsmap/markers";
const DESTINATION_COLLECTION = "mapMarkers";
const EXPECTED_LEGACY_COUNT = 11;
const REQUIRED_NUMBER_FIELDS = ["lat", "lng", "heading", "pitch", "zoom"];
const LEGACY_FIELDS = new Set([...REQUIRED_NUMBER_FIELDS, "pano"]);

function printHelp() {
  console.log(`Usage:
  node scripts/migrate-markers.mjs
  node scripts/migrate-markers.mjs --execute

Reads ${LEGACY_DOCUMENT_PATH}.items and prints a dry-run migration plan.
Without --execute, no Firestore writes are performed.
With --execute, validated markers are copied to ${DESTINATION_COLLECTION}.`);
}

function readFirebaseConfigValue(html, name) {
  const match = html.match(new RegExp(`${name}\\s*:\\s*["']([^"']+)["']`));
  return match ? match[1] : null;
}

function decodeFirestoreValue(value) {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [
        key,
        decodeFirestoreValue(child)
      ])
    );
  }

  throw new Error(`未対応のFirestore値形式です: ${Object.keys(value).join(", ")}`);
}

function decodeFirestoreDocument(document) {
  return Object.fromEntries(
    Object.entries(document.fields || {}).map(([key, value]) => [
      key,
      decodeFirestoreValue(value)
    ])
  );
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: "NULL_VALUE" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { doubleValue: value };
  }
  if (typeof value === "boolean") return { booleanValue: value };
  throw new Error(`Firestoreへ変換できない値です: ${String(value)}`);
}

function encodeFirestoreFields(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeFirestoreValue(value)])
  );
}

function validateLegacyMarker(marker, index) {
  const issues = [];

  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return [`items[${index}] がオブジェクトではありません`];
  }

  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (typeof marker[field] !== "number" || !Number.isFinite(marker[field])) {
      issues.push(`${field} が有限数値ではありません`);
    }
  }

  if (typeof marker.lat === "number" && (marker.lat < -90 || marker.lat > 90)) {
    issues.push("lat が -90〜90 の範囲外です");
  }
  if (typeof marker.lng === "number" && (marker.lng < -180 || marker.lng > 180)) {
    issues.push("lng が -180〜180 の範囲外です");
  }
  if (typeof marker.pano !== "string" || marker.pano.trim() === "") {
    issues.push("pano が空でない文字列ではありません");
  }

  const unexpectedFields = Object.keys(marker).filter(field => !LEGACY_FIELDS.has(field));
  if (unexpectedFields.length) {
    issues.push(`想定外のフィールドがあります: ${unexpectedFields.join(", ")}`);
  }

  return issues;
}

function createPlannedMarker(marker, index) {
  return {
    id: `legacy-${String(index + 1).padStart(6, "0")}`,
    data: {
      category: "cat",
      title: "",
      memo: "",
      lat: marker.lat,
      lng: marker.lng,
      pano: marker.pano,
      heading: marker.heading,
      pitch: marker.pitch,
      zoom: marker.zoom,
      ownerUid: null,
      createdAt: null,
      migratedAt: "<serverTimestamp()>"
    }
  };
}

async function readFirebaseConfig() {
  const html = await readFile(INDEX_PATH, "utf8");
  const projectId = process.env.FIREBASE_PROJECT_ID
    || readFirebaseConfigValue(html, "projectId");
  const apiKey = process.env.FIREBASE_API_KEY
    || readFirebaseConfigValue(html, "apiKey");

  if (!projectId || !apiKey) {
    throw new Error("index.htmlまたは環境変数からFirebase設定を取得できませんでした");
  }

  return { projectId, apiKey };
}

function createFirestoreUrl(firebaseConfig, pathSuffix) {
  const endpoint = new URL(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}`
      + `/databases/(default)/${pathSuffix}`
  );
  endpoint.searchParams.set("key", firebaseConfig.apiKey);
  return endpoint;
}

async function requestJson(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body.error?.message || response.statusText;
    throw new Error(`Firestoreリクエストエラー (${response.status}): ${message}`);
  }

  return body;
}

async function readLegacyDocument(firebaseConfig) {
  const endpoint = createFirestoreUrl(
    firebaseConfig,
    `documents/${LEGACY_DOCUMENT_PATH}`
  );

  return decodeFirestoreDocument(await requestJson(endpoint));
}

async function readDestinationMarkers(firebaseConfig) {
  const documents = [];
  let pageToken = null;

  do {
    const endpoint = createFirestoreUrl(
      firebaseConfig,
      `documents/${DESTINATION_COLLECTION}`
    );
    endpoint.searchParams.set("pageSize", "100");
    if (pageToken) endpoint.searchParams.set("pageToken", pageToken);

    const body = await requestJson(endpoint);
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || null;
  } while (pageToken);

  return documents.map(document => ({
    id: document.name.slice(document.name.lastIndexOf("/") + 1),
    data: decodeFirestoreDocument(document)
  }));
}

async function commitMigration(firebaseConfig, plans) {
  const endpoint = createFirestoreUrl(firebaseConfig, "documents:commit");
  const databasePath = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const writes = plans.map(plan => {
    const { migratedAt, ...storedData } = plan.data;
    return {
      update: {
        name: `${databasePath}/${DESTINATION_COLLECTION}/${plan.id}`,
        fields: encodeFirestoreFields(storedData)
      },
      updateTransforms: [{
        fieldPath: "migratedAt",
        setToServerValue: "REQUEST_TIME"
      }],
      currentDocument: { exists: false }
    };
  });

  return requestJson(endpoint, {
    method: "POST",
    body: JSON.stringify({ writes })
  });
}

function verifyMigratedMarkers(plans, actualMarkers) {
  const issues = [];
  const expectedIds = plans.map(plan => plan.id);
  const expectedIdSet = new Set(expectedIds);
  const actualById = new Map(actualMarkers.map(marker => [marker.id, marker.data]));

  if (actualMarkers.length !== plans.length) {
    issues.push(`件数不一致: expected=${plans.length}, actual=${actualMarkers.length}`);
  }

  const unexpectedIds = actualMarkers
    .map(marker => marker.id)
    .filter(id => !expectedIdSet.has(id));
  if (unexpectedIds.length) {
    issues.push(`想定外ID: ${unexpectedIds.join(", ")}`);
  }

  const comparedFields = [
    "lat", "lng", "pano", "heading", "pitch", "zoom",
    "category", "ownerUid", "title", "memo", "createdAt"
  ];

  for (const plan of plans) {
    const actual = actualById.get(plan.id);
    if (!actual) {
      issues.push(`${plan.id}: ドキュメントがありません`);
      continue;
    }

    for (const field of comparedFields) {
      if (!Object.is(actual[field], plan.data[field])) {
        issues.push(
          `${plan.id}.${field}: expected=${String(plan.data[field])}, actual=${String(actual[field])}`
        );
      }
    }

    if (typeof actual.migratedAt !== "string" || Number.isNaN(Date.parse(actual.migratedAt))) {
      issues.push(`${plan.id}.migratedAt: サーバーTimestampではありません`);
    }
  }

  return { issues, expectedIds };
}

async function reportWrittenIdsAfterFailure(firebaseConfig, expectedIds) {
  try {
    const expectedIdSet = new Set(expectedIds);
    const writtenIds = (await readDestinationMarkers(firebaseConfig))
      .map(marker => marker.id)
      .filter(id => expectedIdSet.has(id))
      .sort();
    console.error(
      `書き込みが確認できたID: ${writtenIds.length ? writtenIds.join(", ") : "なし"}`
    );
  } catch (verificationError) {
    console.error(`書き込み済みIDを確認できませんでした: ${verificationError.message}`);
  }
}

async function executeMigration(firebaseConfig, plans) {
  console.log("");
  console.log("=== execute ===");
  console.log(`書込先: ${DESTINATION_COLLECTION}/{markerId}`);

  const existingMarkers = await readDestinationMarkers(firebaseConfig);
  if (existingMarkers.length) {
    throw new Error(
      `${DESTINATION_COLLECTION} が空ではありません。既存ID: `
        + existingMarkers.map(marker => marker.id).sort().join(", ")
    );
  }

  console.log(`${plans.length}件を単一のatomic commitで書き込みます`);
  try {
    await commitMigration(firebaseConfig, plans);
  } catch (error) {
    console.error(`atomic commitに失敗しました: ${error.message}`);
    await reportWrittenIdsAfterFailure(firebaseConfig, plans.map(plan => plan.id));
    throw error;
  }

  console.log(`書き込み完了ID: ${plans.map(plan => plan.id).join(", ")}`);

  const actualMarkers = await readDestinationMarkers(firebaseConfig);
  const verification = verifyMigratedMarkers(plans, actualMarkers);

  console.log("");
  console.log("=== verification ===");
  console.log(`期待件数: ${plans.length}`);
  console.log(`実件数: ${actualMarkers.length}`);
  console.log(`期待ID: ${verification.expectedIds.join(", ")}`);

  if (verification.issues.length) {
    console.log("照合結果: FAILED");
    for (const issue of verification.issues) console.log(`  - ${issue}`);
    process.exitCode = 3;
    return;
  }

  console.log("照合結果: SUCCESS");
  console.log("全IDおよび全比較フィールドが一致しました");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const execute = args.length === 1 && args[0] === "--execute";
  if (args.length && !execute) {
    throw new Error(`未対応の引数です: ${args.join(" ")}`);
  }

  console.log(`=== Firestore marker migration ${execute ? "execute" : "dry-run"} ===`);
  console.log(`読取元: ${LEGACY_DOCUMENT_PATH}.items`);
  console.log(`書込先（予定）: ${DESTINATION_COLLECTION}/{markerId}`);
  console.log(`書き込み: ${execute ? "検証成功後に実行" : "行いません"}`);
  console.log("");

  const firebaseConfig = await readFirebaseConfig();
  const legacyDocument = await readLegacyDocument(firebaseConfig);
  if (!Array.isArray(legacyDocument.items)) {
    throw new Error(`${LEGACY_DOCUMENT_PATH}.items が配列ではありません`);
  }

  const results = legacyDocument.items.map((marker, index) => ({
    marker,
    index,
    issues: validateLegacyMarker(marker, index)
  }));

  for (const result of results) {
    const plan = createPlannedMarker(result.marker, result.index);
    const status = result.issues.length ? "ERROR" : "OK";
    console.log(
      `[${status}] ${plan.id}`
      + ` category=${plan.data.category}`
      + ` ownerUid=${String(plan.data.ownerUid)}`
      + ` lat=${String(plan.data.lat)}`
      + ` lng=${String(plan.data.lng)}`
      + ` pano=${String(plan.data.pano)}`
    );
    for (const issue of result.issues) {
      console.log(`  - ${issue}`);
    }
  }

  const invalidResults = results.filter(result => result.issues.length);
  const countIsValid = results.length === EXPECTED_LEGACY_COUNT;
  console.log("");
  console.log("=== dry-run summary ===");
  console.log(`旧マーカー件数: ${results.length}`);
  console.log(`移行予定件数: ${results.length - invalidResults.length}`);
  console.log(`異常データ件数: ${invalidResults.length}`);
  console.log(`件数検証: ${countIsValid ? "OK" : `ERROR（期待=${EXPECTED_LEGACY_COUNT}）`}`);
  console.log("予定category: cat");
  console.log("予定ownerUid: null");
  console.log(
    `Firestoreへの書き込み: ${execute ? `検証成功時のみ${results.length}件` : "0件"}`
  );

  if (invalidResults.length || !countIsValid) {
    process.exitCode = 2;
    console.log("検証に失敗したため、書き込みは開始しません");
    return;
  }

  if (!execute) return;

  const plans = results.map(result => createPlannedMarker(result.marker, result.index));
  await executeMigration(firebaseConfig, plans);
}

main().catch(error => {
  console.error(`dry-runに失敗しました: ${error.message}`);
  process.exitCode = 1;
});
