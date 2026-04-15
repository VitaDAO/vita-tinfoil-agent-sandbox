import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo");

const SECRETBOX_NONCE_BYTES = 24;
const CATEGORY_DEK_NONCE_BYTES = 24;
const ARGON2_OPS_LIMIT = 3;
const ARGON2_MEM_LIMIT = 67108864;

let sodiumReady;

export async function ensureSodiumReady() {
  if (!sodiumReady) {
    sodiumReady = sodium.ready;
  }
  await sodiumReady;
}

export function fromHex(hex) {
  if (hex instanceof Uint8Array) {
    return hex;
  }

  if (typeof hex !== "string") {
    throw new Error("Expected hex string");
  }

  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);

  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }

  return bytes;
}

export async function deriveKEK(passphrase, salt) {
  await ensureSodiumReady();
  return sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    ARGON2_OPS_LIMIT,
    ARGON2_MEM_LIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function unwrapDEK(wrapped, nonce, kek) {
  await ensureSodiumReady();

  try {
    return sodium.crypto_secretbox_open_easy(wrapped, nonce, kek);
  } catch {
    throw new Error("Failed to unwrap DEK. Incorrect passphrase or corrupted key data.");
  }
}

export async function unwrapCategoryDEK(wrapped, nonce, userDEK) {
  await ensureSodiumReady();

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrapped,
      null,
      nonce,
      userDEK,
    );
  } catch {
    throw new Error("Failed to unwrap category DEK. Key data may be corrupted.");
  }
}

export async function decryptRecord(ciphertext, nonce, categoryDEK) {
  await ensureSodiumReady();

  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      categoryDEK,
    );
    return JSON.parse(sodium.to_string(plaintext));
  } catch {
    throw new Error("Decryption failed. Key may be incorrect or data corrupted.");
  }
}

export async function zeroMemory(buffer) {
  if (!buffer || !(buffer instanceof Uint8Array) || buffer.length === 0) {
    return;
  }

  await ensureSodiumReady();
  sodium.memzero(buffer);
}

export async function destroyKeySession(session) {
  if (!session) {
    return;
  }

  await zeroMemory(session.userDEK);

  for (const dek of session.categoryDEKs.values()) {
    await zeroMemory(dek);
  }

  session.categoryDEKs.clear();
}

function splitWrappedValue(wrappedWithNonce, nonceLength = SECRETBOX_NONCE_BYTES) {
  if (!(wrappedWithNonce instanceof Uint8Array) || wrappedWithNonce.length <= nonceLength) {
    throw new Error("Wrapped value is malformed.");
  }

  return {
    nonce: wrappedWithNonce.slice(0, nonceLength),
    wrapped: wrappedWithNonce.slice(nonceLength),
  };
}

function latestCategoryRows(rows) {
  const byCategory = new Map();

  for (const row of rows || []) {
    const existing = byCategory.get(row.category);
    if (!existing || Number(row.key_version || 0) > Number(existing.key_version || 0)) {
      byCategory.set(row.category, row);
    }
  }

  return [...byCategory.values()];
}

async function unwrapCategoryKeys(categoryRows, userDEK) {
  const categoryDEKs = new Map();

  for (const row of latestCategoryRows(categoryRows)) {
    const nonce = fromHex(row.nonce);
    const wrappedCategoryDEK = fromHex(row.wrapped_category_dek);
    const categoryDEK = await unwrapCategoryDEK(wrappedCategoryDEK, nonce, userDEK);
    categoryDEKs.set(row.category, categoryDEK);
  }

  return categoryDEKs;
}

export async function unlockKeySessionFromRows({ passphrase, keyRow, categoryRows }) {
  if (!passphrase) {
    throw new Error("passphrase is required");
  }
  if (!keyRow) {
    throw new Error("No encryption keys found. Please set up encryption first.");
  }

  const salt = fromHex(keyRow.argon2_salt);
  const kek = await deriveKEK(passphrase, salt);

  try {
    const wrappedDEKWithNonce = fromHex(keyRow.wrapped_dek);
    const { nonce, wrapped } = splitWrappedValue(wrappedDEKWithNonce, SECRETBOX_NONCE_BYTES);
    const userDEK = await unwrapDEK(wrapped, nonce, kek);
    const categoryDEKs = await unwrapCategoryKeys(categoryRows, userDEK);
    return { userDEK, categoryDEKs };
  } finally {
    await zeroMemory(kek);
  }
}

export async function recoverKeySessionFromRows({ recoveryKey, recoveryRow, categoryRows }) {
  if (!recoveryKey) {
    throw new Error("recoveryKey is required");
  }
  if (!recoveryRow) {
    throw new Error("No recovery key found.");
  }

  const recoverySalt = fromHex(recoveryRow.recovery_salt);
  const recoveryKEK = await deriveKEK(recoveryKey, recoverySalt);

  try {
    const wrappedWithNonce = fromHex(recoveryRow.recovery_wrapped_dek);
    const { nonce, wrapped } = splitWrappedValue(wrappedWithNonce, SECRETBOX_NONCE_BYTES);
    const userDEK = await unwrapDEK(wrapped, nonce, recoveryKEK);
    const categoryDEKs = await unwrapCategoryKeys(categoryRows, userDEK);
    return { userDEK, categoryDEKs };
  } finally {
    await zeroMemory(recoveryKEK);
  }
}

export function getCategoryDEK(session, category) {
  const dek = session?.categoryDEKs?.get(category);
  if (!dek) {
    throw new Error(`No key for category: ${category}`);
  }
  return dek;
}

/**
 * Unlocks a key session from a raw userDEK (sent directly from VitaApp).
 * No passphrase derivation needed — VitaApp already unwrapped the DEK.
 */
export async function unlockKeySessionFromDEK({ userDEK, categoryRows }) {
  if (!userDEK || !(userDEK instanceof Uint8Array)) {
    throw new Error("userDEK must be a Uint8Array");
  }
  const categoryDEKs = await unwrapCategoryKeys(categoryRows, userDEK);
  return { userDEK, categoryDEKs };
}

export async function decryptHealthData({ session, category, encrypted_payload, encryption_nonce }) {
  const categoryDEK = getCategoryDEK(session, category);
  return decryptRecord(fromHex(encrypted_payload), fromHex(encryption_nonce), categoryDEK);
}
