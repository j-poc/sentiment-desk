import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecFilingsHubInstallation } from "../server/sec-filings-hub-installation.js";

const fixtures: string[] = [];
const token = "A".repeat(43);
const repositoryUrl = "https://github.com/j-poc/public-data-hub";

function installation() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sentiment-sec-hub-installation-"));
  fixtures.push(directory);
  const repository = realpathSync(directory);
  const runtime = path.join(repository, ".runtime");
  const stateDirectory = path.join(runtime, "state");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDirectory, "client.token"), token, { mode: 0o600 });
  const locatorPath = path.join(repository, "installation.json");
  const descriptor = {
    schema_version: 1,
    scope: "same-local-user-and-host",
    repository,
    repository_url: repositoryUrl,
    base_url: "http://127.0.0.1:8766/",
    state_directory: stateDirectory,
  };
  writeFileSync(locatorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { directory, repository, runtime, stateDirectory, locatorPath, descriptor };
}

function load(locatorPath: string) {
  return loadSecFilingsHubInstallation(locatorPath);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("loadSecFilingsHubInstallation", () => {
  it("loads a versioned same-user installation and its protected local token", () => {
    const fixture = installation();
    const result = load(fixture.locatorPath);
    expect(result.baseUrl.href).toBe("http://127.0.0.1:8766/");
    expect(result.token).toBe(token);
  });

  it("rejects a non-absolute locator path", () => {
    expect(() => load("relative/installation.json")).toThrow();
  });

  it("rejects a symlinked descriptor", () => {
    const fixture = installation();
    const linked = path.join(fixture.directory, "linked-installation.json");
    symlinkSync(fixture.locatorPath, linked);
    expect(() => load(linked)).toThrow();
  });

  it("rejects a descriptor with group or world permissions", () => {
    const fixture = installation();
    chmodSync(fixture.locatorPath, 0o644);
    expect(() => load(fixture.locatorPath)).toThrow();
  });

  it.each([
    ["unsupported schema version", (descriptor: any) => { descriptor.schema_version = 2; }],
    ["wrong installation scope", (descriptor: any) => { descriptor.scope = "shared"; }],
    ["wrong repository URL", (descriptor: any) => { descriptor.repository_url = "https://github.com/other/public-data-hub"; }],
    ["non-loopback host", (descriptor: any) => { descriptor.base_url = "http://192.168.1.4:8766/"; }],
    ["URL path", (descriptor: any) => { descriptor.base_url = "http://127.0.0.1:8766/api/"; }],
    ["URL query", (descriptor: any) => { descriptor.base_url = "http://127.0.0.1:8766/?token=secret"; }],
    ["URL without required trailing slash", (descriptor: any) => { descriptor.base_url = "http://127.0.0.1:8766"; }],
    ["state directory outside repository runtime", (descriptor: any, fixture: ReturnType<typeof installation>) => {
      const outside = path.join(fixture.directory, "outside-state");
      mkdirSync(outside, { mode: 0o700 });
      writeFileSync(path.join(outside, "client.token"), token, { mode: 0o600 });
      descriptor.state_directory = outside;
    }],
    ["nested state directory", (descriptor: any, fixture: ReturnType<typeof installation>) => {
      const nested = path.join(fixture.runtime, "nested", "state");
      mkdirSync(nested, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(nested, "client.token"), token, { mode: 0o600 });
      descriptor.state_directory = nested;
    }],
    ["relative repository path", (descriptor: any) => { descriptor.repository = "relative/repository"; }],
    ["repository path that escapes the actual installation", (descriptor: any, fixture: ReturnType<typeof installation>) => { descriptor.repository = path.dirname(fixture.repository); }],
    ["unknown schema field", (descriptor: any) => { descriptor.extra = true; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const fixture = installation();
    mutate(fixture.descriptor as any, fixture);
    writeFileSync(fixture.locatorPath, JSON.stringify(fixture.descriptor), { mode: 0o600 });
    expect(() => load(fixture.locatorPath)).toThrow();
  });

  it("rejects a repository reached through a symlink", () => {
    const fixture = installation();
    const alias = path.join(fixture.directory, "repository-alias");
    symlinkSync(fixture.repository, alias);
    fixture.descriptor.repository = alias;
    writeFileSync(fixture.locatorPath, JSON.stringify(fixture.descriptor), { mode: 0o600 });
    expect(() => load(fixture.locatorPath)).toThrow();
  });

  it("rejects a symlinked runtime or state directory", () => {
    const runtimeFixture = installation();
    const realRuntime = path.join(runtimeFixture.directory, "real-runtime");
    mkdirSync(path.join(realRuntime, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(realRuntime, "state", "client.token"), token, { mode: 0o600 });
    rmSync(runtimeFixture.runtime, { recursive: true });
    symlinkSync(realRuntime, runtimeFixture.runtime);
    runtimeFixture.descriptor.state_directory = path.join(runtimeFixture.runtime, "state");
    writeFileSync(runtimeFixture.locatorPath, JSON.stringify(runtimeFixture.descriptor), { mode: 0o600 });
    expect(() => load(runtimeFixture.locatorPath)).toThrow();

    const stateFixture = installation();
    const realState = path.join(stateFixture.directory, "real-state");
    mkdirSync(realState, { mode: 0o700 });
    writeFileSync(path.join(realState, "client.token"), token, { mode: 0o600 });
    rmSync(stateFixture.stateDirectory, { recursive: true });
    symlinkSync(realState, stateFixture.stateDirectory);
    expect(() => load(stateFixture.locatorPath)).toThrow();
  });

  it("rejects unsafe, linked, or missing token files", () => {
    const permissive = installation();
    const tokenPath = path.join(permissive.stateDirectory, "client.token");
    chmodSync(tokenPath, 0o644);
    expect(() => load(permissive.locatorPath)).toThrow();

    const linked = installation();
    const linkedTokenPath = path.join(linked.stateDirectory, "client.token");
    rmSync(linkedTokenPath);
    const externalTokenPath = path.join(linked.directory, "external-token");
    writeFileSync(externalTokenPath, token, { mode: 0o600 });
    symlinkSync(externalTokenPath, linkedTokenPath);
    expect(() => load(linked.locatorPath)).toThrow();

    const missing = installation();
    rmSync(path.join(missing.stateDirectory, "client.token"));
    expect(() => load(missing.locatorPath)).toThrow();
  });

  it("rejects malformed JSON and malformed descriptor fields", () => {
    const malformedJson = installation();
    writeFileSync(malformedJson.locatorPath, "{not-json", { mode: 0o600 });
    expect(() => load(malformedJson.locatorPath)).toThrow();

    const malformedSchema = installation();
    malformedSchema.descriptor.schema_version = "1" as any;
    writeFileSync(malformedSchema.locatorPath, JSON.stringify(malformedSchema.descriptor), { mode: 0o600 });
    expect(() => load(malformedSchema.locatorPath)).toThrow();
  });
});
