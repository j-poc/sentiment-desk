import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelProviderCredentialVault, type KeyringSecret, type ModelCredentialProvider } from "../server/model-provider-credential-vault";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "model-provider-vault-")); dirs.push(dir);
  let secret: Uint8Array | undefined;
  const keyring: KeyringSecret = { getSecret: async () => secret, setSecret: async value => { secret = Uint8Array.from(value); } };
  return { dir, keyring, vault: new ModelProviderCredentialVault(join(dir, "credentials"), keyring) };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const providers: ModelCredentialProvider[] = ["openai", "google_gemini", "typesafe_jev"];

describe("ModelProviderCredentialVault", () => {
  it("encrypts each provider key independently and persists owner-only files", async () => {
    const f = await fixture();
    const keys: Record<ModelCredentialProvider, string> = { openai: "sk-openai-sensitive", google_gemini: "AIza-gemini-sensitive", typesafe_jev: "sk-typesafe-sensitive" };
    for (const provider of providers) await f.vault.save(provider, keys[provider]);
    for (const provider of providers) {
      const path = join(f.dir, "credentials", `${provider}.credential.json`);
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain(keys[provider]);
      expect(JSON.parse(persisted)).toMatchObject({ version: 1 });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await f.vault.load(provider)).toBe(keys[provider]);
    }
    expect((await stat(join(f.dir, "credentials"))).mode & 0o777).toBe(0o700);
    expect(await f.vault.load("openai")).not.toBe(await f.vault.load("google_gemini"));
  });

  it("replaces and removes credentials without affecting the other provider", async () => {
    const f = await fixture();
    await f.vault.save("openai", "first-openai-key");
    await f.vault.save("google_gemini", "gemini-key");
    await f.vault.save("openai", "replacement-openai-key");
    await f.vault.save("typesafe_jev", "typesafe-jevv-key");
    expect(await f.vault.load("openai")).toBe("replacement-openai-key");
    await f.vault.remove("openai");
    expect(await f.vault.load("openai")).toBeNull();
    expect(await f.vault.load("google_gemini")).toBe("gemini-key");
    expect(await f.vault.load("typesafe_jev")).toBe("typesafe-jevv-key");
    await expect(f.vault.remove("openai")).resolves.toBeUndefined();
  });

  it("binds ciphertext authentication to its provider", async () => {
    const f = await fixture();
    await f.vault.save("openai", "provider-bound-key");
    const from = join(f.dir, "credentials", "openai.credential.json");
    const to = join(f.dir, "credentials", "google_gemini.credential.json");
    await writeFile(to, await readFile(from));
    await chmod(to, 0o600);
    await expect(f.vault.load("google_gemini")).rejects.toThrow("could not be unlocked safely");
  });

  it("rejects tampered ciphertext and files with unsafe permissions", async () => {
    const f = await fixture();
    await f.vault.save("google_gemini", "secret-gemini-key");
    const path = join(f.dir, "credentials", "google_gemini.credential.json");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(path, JSON.stringify(envelope));
    await expect(f.vault.load("google_gemini")).rejects.toThrow("could not be unlocked safely");
    await f.vault.save("google_gemini", "secret-gemini-key");
    await chmod(path, 0o644);
    await expect(f.vault.load("google_gemini")).rejects.toThrow("could not be read safely");
  });

  it("normalizes macOS keyring number arrays and enforces key bounds", async () => {
    const f = await fixture();
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nativeArrayKeyring: KeyringSecret = {
      getSecret: async () => Array.from(secret) as unknown as Uint8Array,
      setSecret: async () => undefined,
    };
    const vault = new ModelProviderCredentialVault(join(f.dir, "native"), nativeArrayKeyring);
    await vault.save("openai", "valid-key");
    expect(await vault.load("openai")).toBe("valid-key");
    await expect(vault.save("openai", "  ")).rejects.toThrow("empty or too large");
    await expect(vault.save("openai", "x".repeat(8193))).rejects.toThrow("empty or too large");
  });
});
