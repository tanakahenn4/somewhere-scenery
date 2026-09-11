const {initializeApp} = require("firebase-admin/app");
const {FieldValue, getFirestore} = require("firebase-admin/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
const {HttpsError, onCall} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {
  normalizeCreateMarkerInput,
  normalizeDeleteMarkerInput,
  normalizeUpdateMarkerInput,
  ValidationError,
} = require("./lib/validation");
const {hashEditPassword, verifyEditPassword} = require("./lib/password");

initializeApp();
const db = getFirestore();

setGlobalOptions({
  region: "asia-northeast1",
  minInstances: 0,
  maxInstances: 1,
  concurrency: 1,
  timeoutSeconds: 30,
  memory: "256MiB",
});

const callableOptions = {
  // Production calls must carry App Check. The local emulator has no
  // production attestation provider, so enforcement is disabled there only.
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
};

function asHttpsError(error) {
  if (error instanceof HttpsError) {
    return error;
  }
  if (error instanceof ValidationError) {
    return new HttpsError("invalid-argument", error.message);
  }

  logger.error("Marker function failed", {
    name: error?.name || "Error",
    code: error?.code || null,
  });
  return new HttpsError("internal", "処理に失敗しました。");
}

function accessDenied() {
  return new HttpsError(
    "permission-denied",
    "編集・削除を許可できませんでした。",
  );
}

exports.createMarker = onCall(callableOptions, async (request) => {
  try {
    const {marker, password} = normalizeCreateMarkerInput(request.data);
    const editPasswordHash = await hashEditPassword(password);
    const markerRef = db.collection("mapMarkers").doc();
    const credentialRef = db.collection("markerCredentials").doc(markerRef.id);
    const batch = db.batch();

    batch.create(markerRef, {
      ...marker,
      ownerUid: null,
      createdAt: FieldValue.serverTimestamp(),
      migratedAt: null,
    });
    batch.create(credentialRef, {
      editPasswordHash,
      createdAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return {markerId: markerRef.id};
  } catch (error) {
    throw asHttpsError(error);
  }
});

exports.updateMarker = onCall(callableOptions, async (request) => {
  try {
    const {markerId, password, title, memo} = normalizeUpdateMarkerInput(
      request.data,
    );
    const markerRef = db.collection("mapMarkers").doc(markerId);
    const credentialRef = db.collection("markerCredentials").doc(markerId);

    await db.runTransaction(async (transaction) => {
      const [markerSnapshot, credentialSnapshot] = await Promise.all([
        transaction.get(markerRef),
        transaction.get(credentialRef),
      ]);
      const storedHash = credentialSnapshot.data()?.editPasswordHash;
      const passwordMatches = await verifyEditPassword(password, storedHash);

      if (!markerSnapshot.exists || !credentialSnapshot.exists || !passwordMatches) {
        throw accessDenied();
      }
      transaction.update(markerRef, {title, memo});
    });

    return {markerId};
  } catch (error) {
    throw asHttpsError(error);
  }
});

exports.deleteMarker = onCall(callableOptions, async (request) => {
  try {
    const {markerId, password} = normalizeDeleteMarkerInput(request.data);
    const markerRef = db.collection("mapMarkers").doc(markerId);
    const credentialRef = db.collection("markerCredentials").doc(markerId);

    await db.runTransaction(async (transaction) => {
      const [markerSnapshot, credentialSnapshot] = await Promise.all([
        transaction.get(markerRef),
        transaction.get(credentialRef),
      ]);
      const storedHash = credentialSnapshot.data()?.editPasswordHash;
      const passwordMatches = await verifyEditPassword(password, storedHash);

      if (!markerSnapshot.exists || !credentialSnapshot.exists || !passwordMatches) {
        throw accessDenied();
      }
      transaction.delete(markerRef);
      transaction.delete(credentialRef);
    });

    return {markerId};
  } catch (error) {
    throw asHttpsError(error);
  }
});
