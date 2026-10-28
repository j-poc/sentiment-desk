import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, chmod, open, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";

export type ModelCredentialProvider = "openai" | "google_gemini" | "typesafe_jev";

export interface KeyringSecret {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
}

type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

const MAX_KEY_BYTES = 8 * 1024;
const MAX_ENVELOPE_BYTES = 24 * 1024;

function normalizedVaultKey(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return value.byteLength === 32 ? Buffer.from(value) : null;
  // @napi-rs/keyring's macOS runtime has returned number[] despite its Uint8Array declaration.
  if (Array.isArray(value) && value.length === 32 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(value);
  }
  return null;
}

/** Per-provider encrypted local API key storage; the AES key exists only in the OS credential store. */
export class ModelProviderCredentialVault {
  private keyPromise: Promise<Buffer> | null = null;

  constructor(
    private readonly directory: string,
    private readonly keyring: KeyringSecret = new AsyncEntry("sentiment-desk", "model-provider-vault-key"),
  ) {}

  private path(provider: ModelCredentialProvider): string {
    if (provider !== "openai" && provider !== "google_gemini" && provider !== "typesafe_jev") throw new Error("Unsupported model provider.");
    return join(this.directory, `${provider}.credential.json`);
  }

  private async key(create: boolean): Promise<Buffer> {
    if (!this.keyPromise) this.keyPromise = (async () => {
      const existing = await this.keyring.getSecret();
      if (existing !== undefined) {
        const normalized = normalizedVaultKey(existing);
        if (!normalized) throw new Error("Vault key is invalid.");
        return normalized;
      }
      if (!create) throw new Error("Vault key is unavailable.");
      const generated = randomBytes(32);
      await this.keyring.setSecret(generated);
      return generated;
    })().catch(error => { this.keyPromise = null; throw error; });
    return this.keyPromise;
  }

  async load(provider: ModelCredentialProvider): Promise<string | null> {
    const path = this.path(provider);
    let raw: string;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > MAX_ENVELOPE_BYTES) throw new Error("unsafe file");
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Saved provider credentials could not be read safely.");
    }
    try {
      if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("oversized envelope");
      const envelope = JSON.parse(raw) as Partial<Envelope>;
      if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") throw new Error("invalid envelope");
      const iv = Buffer.from(envelope.iv, "base64url");
      const tag = Buffer.from(envelope.tag, "base64url");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > MAX_KEY_BYTES) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", await this.key(false), iv);
      decipher.setAAD(Buffer.from(`sentiment-desk/model-provider/${provider}/v1`));
      decipher.setAuthTag(tag);
      const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (!key.length || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) throw new Error("invalid credential");
      return key;
    } catch {
      throw new Error("Saved provider credentials could not be unlocked safely.");
    }
  }

  async save(provider: ModelCredentialProvider, plaintext: string): Promise<void> {
    if (typeof plaintext !== "string" || !plaintext.trim() || Buffer.byteLength(plaintext, "utf8") > MAX_KEY_BYTES) {
      throw new Error("Provider credential is empty or too large.");
    }
    const path = this.path(provider);
    let encrypted: Envelope;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(true), iv);
      cipher.setAAD(Buffer.from(`sentiment-desk/model-provider/${provider}/v1`));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      encrypted = { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    } catch {
      throw new Error("Provider credentials could not be protected by the OS credential store.");
    }
    const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    let handle;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(encrypted), "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await chmod(temp, 0o600);
      await rename(temp, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw new Error("Provider credentials could not be saved securely.");
    }
  }

  async remove(provider: ModelCredentialProvider): Promise<void> {
    try { await unlink(this.path(provider)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Provider credentials could not be removed safely.");
    }
  }
}
