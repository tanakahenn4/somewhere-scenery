const assert = require("node:assert/strict");
const test = require("node:test");
const {getApps, initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const projectId = process.env.GCLOUD_PROJECT || "nekocatsmap";
const functionBaseUrl =
  `http://127.0.0.1:5001/${projectId}/asia-northeast1`;

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST is required.");
}

if (getApps().length === 0) {
  initializeApp({projectId});
}
const db = getFirestore();

async function callFunction(name, data) {
  const response = await fetch(`${functionBaseUrl}/${name}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({data}),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

const markerInput = {
  category: "interesting_scenery",
  title: "エミュレータテスト",
  memo: "保存と編集と削除を確認",
  locationName: "東京都千代田区",
  lat: 35.681236,
  lng: 139.767125,
  pano: "emulator-pano-id",
  heading: 120.5,
  pitch: -3.25,
  zoom: 2,
  password: "local-test-password",
};

test("callable marker lifecycle uses private credentials", async () => {
  const invalidCreate = await callFunction("createMarker", {
    ...markerInput,
    category: "not-a-category",
  });
  assert.equal(invalidCreate.status, 400);
  assert.equal(invalidCreate.body.error.status, "INVALID_ARGUMENT");

  const created = await callFunction("createMarker", markerInput);
  assert.equal(created.status, 200);
  const markerId = created.body.result.markerId;
  assert.ok(markerId);

  const markerRef = db.collection("mapMarkers").doc(markerId);
  const credentialRef = db.collection("markerCredentials").doc(markerId);
  const [markerSnapshot, credentialSnapshot] = await Promise.all([
    markerRef.get(),
    credentialRef.get(),
  ]);
  assert.equal(markerSnapshot.exists, true);
  assert.equal(credentialSnapshot.exists, true);

  const marker = markerSnapshot.data();
  const credential = credentialSnapshot.data();
  assert.equal(marker.title, markerInput.title);
  assert.equal(marker.category, markerInput.category);
  assert.equal(marker.ownerUid, null);
  assert.equal(marker.migratedAt, null);
  assert.ok(marker.createdAt);
  assert.equal("editPasswordHash" in marker, false);
  assert.match(
    credential.editPasswordHash,
    /^pbkdf2-sha256\$600000\$[^$]+\$[^$]+$/,
  );
  assert.notEqual(credential.editPasswordHash, markerInput.password);

  const wrongUpdate = await callFunction("updateMarker", {
    markerId,
    password: "wrong-password",
    title: "変更不可",
    memo: "変更不可",
  });
  assert.equal(wrongUpdate.status, 403);
  assert.equal(wrongUpdate.body.error.status, "PERMISSION_DENIED");

  const updated = await callFunction("updateMarker", {
    markerId,
    password: markerInput.password,
    title: "変更後の題名",
    memo: "変更後のメモ",
  });
  assert.equal(updated.status, 200);
  const markerAfterUpdate = (await markerRef.get()).data();
  assert.equal(markerAfterUpdate.title, "変更後の題名");
  assert.equal(markerAfterUpdate.memo, "変更後のメモ");
  assert.equal(markerAfterUpdate.lat, markerInput.lat);
  assert.equal(markerAfterUpdate.pano, markerInput.pano);

  const legacyRef = db.collection("mapMarkers").doc("legacy-without-credential");
  await legacyRef.set({title: "旧データ"});
  const legacyUpdate = await callFunction("updateMarker", {
    markerId: legacyRef.id,
    password: markerInput.password,
    title: "変更不可",
    memo: "",
  });
  assert.equal(legacyUpdate.status, 403);
  const legacyDelete = await callFunction("deleteMarker", {
    markerId: legacyRef.id,
    password: markerInput.password,
  });
  assert.equal(legacyDelete.status, 403);
  assert.equal((await legacyRef.get()).exists, true);
  await legacyRef.delete();

  const wrongDelete = await callFunction("deleteMarker", {
    markerId,
    password: "wrong-password",
  });
  assert.equal(wrongDelete.status, 403);
  assert.equal((await markerRef.get()).exists, true);

  const deleted = await callFunction("deleteMarker", {
    markerId,
    password: markerInput.password,
  });
  assert.equal(deleted.status, 200);
  const [markerAfterDelete, credentialAfterDelete] = await Promise.all([
    markerRef.get(),
    credentialRef.get(),
  ]);
  assert.equal(markerAfterDelete.exists, false);
  assert.equal(credentialAfterDelete.exists, false);
});
