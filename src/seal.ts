import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Encrypts and authenticates small JSON claims with AES-256-GCM. OAuth client IDs, codes and
// tokens are sealed values, so the server needs no database: they carry everything, including
// each user's Google tokens, which only this server can read.

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export const now = () => Math.floor(Date.now() / 1000);

export class Sealer {
  private key: Buffer;
  private macKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("MCP_SIGNING_SECRET must be at least 32 characters");
    this.key = createHmac("sha256", secret).update("seal").digest();
    this.macKey = createHmac("sha256", secret).update("mac").digest();
  }

  // `kind` is authenticated with the value, so a sealed value of one kind (say an authorization
  // code) can't be passed off as another (an access token)
  seal(kind: string, claims: object): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(kind));
    const body = Buffer.concat([cipher.update(JSON.stringify(claims)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  // Returns undefined if the value was tampered with, is of another kind, or has expired
  open<T extends { exp?: number }>(kind: string, sealed: string): T | undefined {
    try {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length <= IV_LENGTH + TAG_LENGTH) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_LENGTH));
      decipher.setAAD(Buffer.from(kind));
      decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
      const body = Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
      const claims = JSON.parse(body.toString()) as T;
      if (claims.exp !== undefined && claims.exp < now()) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }

  mac(value: string): string {
    return createHmac("sha256", this.macKey).update(value).digest("base64url");
  }
}
