import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTPlanCredentialVault, type KeyringSecret } from "../server/chatgpt-plan-credential-vault";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-vault-")); dirs.push(dir);
  const path = join(dir, "state", "credentials.json");
  let secret: Uint8Array | undefined;
  const keyring: KeyringSecret = { getSecret: async () => secret, setSecret: async value => { secret = Uint8Array.from(value); } };
  return { dir, path, keyring, vault: new ChatGPTPlanCredentialVault(path, keyring), getSecret: () => secret };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("ChatGPTPlanCredentialVault", () => {
  it("encrypts credentials with a keyring-held key and persists atomically with restrictive modes", async () => {
    const f = await fixture();
    const credentials = JSON.stringify({ accessToken: "access-sensitive-value", refreshToken: "refresh-sensitive-value", subject: "user" });
    await f.vault.save(credentials);
    const disk = await readFile(f.path, "utf8");
    expect(disk).not.toContain("access-sensitive-value");
    expect(disk).not.toContain("refresh-sensitive-value");
    expect(f.getSecret()).toHaveLength(32);
    expect(await f.vault.load()).toBe(credentials);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dir, "state"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(f.dir, "state"))).toEqual(["credentials.json"]);
  });

  it("returns an empty state only when no credential file exists", async () => {
    const f = await fixture();
    expect(await f.vault.load()).toBeNull();
    expect(f.getSecret()).toBeUndefined();
  });

  it("normalizes the native keyring's runtime number-array secret", async () => {
    const f = await fixture();
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nativeArrayKeyring: KeyringSecret = {
      getSecret: async () => Array.from(secret) as unknown as Uint8Array,
      setSecret: async value => { expect(value).toHaveLength(32); },
    };
    const vault = new ChatGPTPlanCredentialVault(f.path, nativeArrayKeyring);
    await vault.save("connected-state");
    expect(await vault.load()).toBe("connected-state");

    const malformedKeyring: KeyringSecret = {
      getSecret: async () => Array.from({ length: 31 }, () => 7) as unknown as Uint8Array,
      setSecret: async () => undefined,
    };
    await expect(new ChatGPTPlanCredentialVault(f.path, malformedKeyring).load()).rejects.toThrow("could not be unlocked safely");
  });

  it("fails closed for locked or unavailable keyring and never falls back to plaintext", async () => {
    const f = await fixture();
    await f.vault.save("secret-state");
    const locked: KeyringSecret = { getSecret: async () => { throw new Error("keychain locked"); }, setSecret: async () => { throw new Error("keychain locked"); } };
    await expect(new ChatGPTPlanCredentialVault(f.path, locked).load()).rejects.toThrow("could not be unlocked safely");
    const unavailable: KeyringSecret = { getSecret: async () => undefined, setSecret: async () => { throw new Error("keychain unavailable"); } };
    await expect(new ChatGPTPlanCredentialVault(join(f.dir, "other.json"), unavailable).save("plaintext-token")).rejects.toThrow("OS credential store");
    await expect(readFile(join(f.dir, "other.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupt and tampered ciphertext", async () => {
    const f = await fixture();
    await f.vault.save("secret-state");
    const original = JSON.parse(await readFile(f.path, "utf8"));
    original.ciphertext = `${original.ciphertext.slice(0, -2)}AA`;
    await writeFile(f.path, JSON.stringify(original));
    await expect(f.vault.load()).rejects.toThrow("could not be unlocked safely");
    await writeFile(f.path, "{broken");
    await expect(f.vault.load()).rejects.toThrow("could not be unlocked safely");
  });

  it("rejects a credential envelope whose permissions have been broadened", async () => {
    const f = await fixture();
    await f.vault.save("secret-state");
    const { chmod } = await import("node:fs/promises");
    await chmod(f.path, 0o644);
    await expect(f.vault.load()).rejects.toThrow("could not be read safely");
  });
});
