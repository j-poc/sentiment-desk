import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, chmod, open, unlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";

export interface KeyringSecret {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
}

export interface CredentialVault {
  load(): Promise<string | null>;
  save(plaintext: string): Promise<void>;
}

type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

function normalizedVaultKey(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return value.byteLength === 32 ? Buffer.from(value) : null;
  // @napi-rs/keyring 2.1.0 declares Uint8Array but returns a number[] on macOS.
  if (Array.isArray(value) && value.length === 32 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(value);
  }
  return null;
}

/** AES-GCM local credential envelope; its key is held only by the OS credential store. */
export class ChatGPTPlanCredentialVault implements CredentialVault {
  private keyPromise: Promise<Buffer> | null = null;

  constructor(private readonly path: string, private readonly keyring: KeyringSecret = new AsyncEntry("sentiment-desk", "chatgpt-plan-vault-key")) {}

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

  async load(): Promise<string | null> {
    let raw: string;
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe file mode");
      raw = await readFile(this.path, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Saved ChatGPT credentials could not be read safely.");
    }
    try {
      const envelope = JSON.parse(raw) as Partial<Envelope>;
      if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") throw new Error("invalid envelope");
      const iv = Buffer.from(envelope.iv, "base64url");
      const tag = Buffer.from(envelope.tag, "base64url");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", await this.key(false), iv);
      decipher.setAAD(Buffer.from("sentiment-desk/chatgpt-plan/v1"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Saved ChatGPT credentials could not be unlocked safely.");
    }
  }

  async save(plaintext: string): Promise<void> {
    let encrypted: Envelope;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.key(true), iv);
      cipher.setAAD(Buffer.from("sentiment-desk/chatgpt-plan/v1"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      encrypted = { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
    } catch {
      throw new Error("ChatGPT credentials could not be protected by the OS credential store.");
    }
    const dir = dirname(this.path);
    const temp = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    let handle;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(encrypted), "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await chmod(temp, 0o600);
      await rename(temp, this.path);
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw new Error("ChatGPT credentials could not be saved securely.");
    }
  }
}
