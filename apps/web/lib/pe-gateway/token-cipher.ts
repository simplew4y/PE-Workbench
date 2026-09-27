import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export class GatewayTokenCipher {
  private readonly key: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error("Gateway token cipher secret must contain at least 32 bytes");
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.from("pe-workbench-gateway-v1", "utf8"),
        Buffer.from("gateway-token-storage", "utf8"),
        32,
      ),
    );
  }

  encrypt(value: string, purpose: string): string {
    if (!value) throw new Error("Cannot encrypt an empty value");
    if (!purpose) throw new Error("Encryption purpose is required");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    return `${VERSION}.${encode(payload)}`;
  }

  decrypt(value: string, purpose: string): string {
    const [version, encoded, extra] = value.split(".");
    if (version !== VERSION || !encoded || extra !== undefined || !purpose) {
      throw new Error("Stored gateway credential is invalid");
    }
    try {
      const payload = decode(encoded);
      if (payload.length <= NONCE_BYTES + TAG_BYTES) throw new Error("invalid payload");
      const nonce = payload.subarray(0, NONCE_BYTES);
      const tag = payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ciphertext = payload.subarray(NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Stored gateway credential could not be decrypted");
    }
  }
}
