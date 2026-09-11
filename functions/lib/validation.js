const MARKER_CATEGORIES = new Set([
  "cat",
  "interesting_scenery",
  "strange_funny",
  "creepy",
  "other",
]);

class ValidationError extends Error {}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("入力内容が正しくありません。");
  }
  return value;
}

function requireString(value, label, maximumLength, minimumLength = 1) {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    throw new ValidationError(`${label}が正しくありません。`);
  }
  return value;
}

function normalizeText(value, label, maximumLength, fallback = "") {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${label}が正しくありません。`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new ValidationError(`${label}が長すぎます。`);
  }
  return normalized || fallback;
}

function requireNumber(value, label, minimum, maximum, maximumExclusive = false) {
  const outOfRange = maximumExclusive ? value >= maximum : value > maximum;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    outOfRange
  ) {
    throw new ValidationError(`${label}が正しくありません。`);
  }
  return value;
}

function normalizeMarkerId(value) {
  const markerId = requireString(value, "マーカーID", 1500);
  if (markerId === "." || markerId === ".." || markerId.includes("/")) {
    throw new ValidationError("マーカーIDが正しくありません。");
  }
  return markerId;
}

function normalizeAccessPassword(value) {
  return requireString(value, "パスワード", 128);
}

function normalizeCreateMarkerInput(input) {
  const data = requireObject(input);
  const category = data.category ?? "cat";
  if (!MARKER_CATEGORIES.has(category)) {
    throw new ValidationError("ジャンルが正しくありません。");
  }

  const locationName = normalizeText(
    data.locationName,
    "地名",
    120,
    "名称未設定",
  );
  const title = normalizeText(data.title, "題名", 100, locationName);
  const memo = normalizeText(data.memo, "メモ", 2000);
  const password = requireString(data.password, "パスワード", 128, 8);

  return {
    password,
    marker: {
      category,
      title,
      memo,
      locationName,
      lat: requireNumber(data.lat, "緯度", -90, 90),
      lng: requireNumber(data.lng, "経度", -180, 180),
      pano: requireString(data.pano, "Pano ID", 512),
      heading: requireNumber(data.heading, "向き", 0, 360, true),
      pitch: requireNumber(data.pitch, "上下方向", -90, 90),
      zoom: requireNumber(data.zoom, "ズーム", 0, 5),
    },
  };
}

function normalizeUpdateMarkerInput(input) {
  const data = requireObject(input);
  const title = normalizeText(data.title, "題名", 100);
  if (!title) {
    throw new ValidationError("題名を入力してください。");
  }
  return {
    markerId: normalizeMarkerId(data.markerId),
    password: normalizeAccessPassword(data.password),
    title,
    memo: normalizeText(data.memo, "メモ", 2000),
  };
}

function normalizeDeleteMarkerInput(input) {
  const data = requireObject(input);
  return {
    markerId: normalizeMarkerId(data.markerId),
    password: normalizeAccessPassword(data.password),
  };
}

module.exports = {
  normalizeCreateMarkerInput,
  normalizeDeleteMarkerInput,
  normalizeUpdateMarkerInput,
  ValidationError,
};
