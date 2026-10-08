import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, closeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const REPOSITORY_URL = "https://github.com/j-poc/public-data-hub";
const descriptorSchema = z.object({
  schema_version: z.literal(1),
  scope: z.literal("same-local-user-and-host"),
  repository: z.string().min(1),
  repository_url: z.literal(REPOSITORY_URL),
  base_url: z.string().min(1),
  state_directory: z.string().min(1),
}).strict();

export interface SecFilingsHubInstallation {
  baseUrl: URL;
  token: string;
}

function fail(): never {
  throw new Error("hub_unavailable");
}

function openPrivateFile(pathname: string, uid: number, maximumBytes: number): number {
  if (typeof constants.O_NOFOLLOW !== "number") return fail();
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || realpathSync(pathname) !== pathname) return fail();
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximumBytes) return fail();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function secureDirectory(pathname: string, uid: number, privateDirectory: boolean): void {
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname || realpathSync(pathname) !== pathname) return fail();
  const metadata = lstatSync(pathname);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid
    || (metadata.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) return fail();
}

function privateToken(pathname: string, uid: number): string {
  const fd = openPrivateFile(pathname, uid, 128);
  try {
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail();
    return token;
  } finally {
    closeSync(fd);
  }
}

/** Resolve one explicitly selected, same-user local Hub installation. There is no fallback. */
export function loadSecFilingsHubInstallation(locatorPath: string): SecFilingsHubInstallation {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return fail();

  secureDirectory(path.dirname(locatorPath), uid, false);
  const descriptorFd = openPrivateFile(locatorPath, uid, 16_384);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(descriptorFd, "utf8"));
  } finally {
    closeSync(descriptorFd);
  }
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) return fail();
  const descriptor = parsed.data;
  if (!path.isAbsolute(descriptor.repository) || path.resolve(descriptor.repository) !== descriptor.repository
    || !path.isAbsolute(descriptor.state_directory) || path.resolve(descriptor.state_directory) !== descriptor.state_directory) return fail();

  const repository = descriptor.repository;
  const runtime = path.join(repository, ".runtime");
  const state = descriptor.state_directory;
  // Hub state is one direct, private child of .runtime; this keeps every path
  // component between the checked runtime and token directory explicit.
  if (path.dirname(state) !== runtime || state === runtime) return fail();
  secureDirectory(repository, uid, false);
  secureDirectory(runtime, uid, true);
  secureDirectory(state, uid, true);

  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/.test(descriptor.base_url)) return fail();
  const baseUrl = new URL(descriptor.base_url);
  const port = Number(baseUrl.port);
  if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535
    || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password
    || baseUrl.href !== descriptor.base_url) return fail();

  const token = privateToken(path.join(state, "client.token"), uid);
  return { baseUrl, token };
}
