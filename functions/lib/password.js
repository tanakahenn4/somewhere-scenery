const {
  pbkdf2: pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const {promisify} = require("node:util");

const pbkdf2 = promisify(pbkdf2Callback);
const HASH_ALGORITHM = "pbkdf2-sha256";
const ITERATIONS = 600000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const SALT_LENGTH = 16;

async function hashEditPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return [
    HASH_ALGORITHM,
    ITERATIONS,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

function parseEditPasswordHash(storedHash) {
  if (typeof storedHash !== "string") {
    return null;
  }

  const [algorithm, iterationText, saltText, hashText, extra] =
    storedHash.split("$");
  const iterations = Number(iterationText);
  if (
    extra !== undefined ||
    algorithm !== HASH_ALGORITHM ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100000 ||
    iterations > 2000000
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(saltText, "base64");
    const hash = Buffer.from(hashText, "base64");
    if (salt.length < SALT_LENGTH || hash.length !== KEY_LENGTH) {
      return null;
    }
    return {iterations, salt, hash};
  } catch {
    return null;
  }
}

async function verifyEditPassword(password, storedHash) {
  if (typeof password !== "string") {
    return false;
  }
  const parsed = parseEditPasswordHash(storedHash);
  if (!parsed) {
    return false;
  }

  const candidate = await pbkdf2(
    password,
    parsed.salt,
    parsed.iterations,
    parsed.hash.length,
    DIGEST,
  );
  return timingSafeEqual(candidate, parsed.hash);
}

module.exports = {
  hashEditPassword,
  verifyEditPassword,
};
