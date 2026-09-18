import crypto from "crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";

// Computed lazily, not at module load: a load-time Buffer.from(config.ENCRYPTION_KEY)
// broke every test that mocks config without that field (importing this module
// is now always safe, and the key is still validated on first use).
let cachedKey: Buffer | undefined;
function key(): Buffer {
  if (!cachedKey) cachedKey = Buffer.from(config.ENCRYPTION_KEY, "hex");
  return cachedKey;
}

export function encrypt(plaintext: string): Buffer {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decrypt(ciphertext: Buffer): string {
  const iv = ciphertext.subarray(0, 16);
  const authTag = ciphertext.subarray(16, 32);
  const encrypted = ciphertext.subarray(32);
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
