import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  boundClassificationInput, CATEGORICAL_JSON_SCHEMA, OPENAI_MODEL, OPENAI_PROMPT,
  validateCategoricalPayload, type OpenAIClassificationInput,
} from "./openai-classifier.js";

const CLI_VERSION = "0.162.1";
const PERMISSIONS = "sentiment-item";
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 120_000;
const DISABLED_FEATURES = [
  "shell_tool", "hooks", "apps", "memories", "view_image", "image_generation", "multi_agent",
  "browser_use", "browser_use_external", "browser_annotation_api", "computer_use", "in_app_browser",
  "shell_snapshot", "skill_mcp_dependency_install", "skill_search",
];
const sessionSchema = z.object({ auth_mode: z.literal("chatgpt"), tokens: z.object({
  access_token: z.string().min(1).max(32_768), account_id: z.string().min(1).max(512),
}) });
type Session = z.infer<typeof sessionSchema>;
const objectSchema = z.record(z.unknown());
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
  totalTokens: z.number().int().nonnegative().safe(), cachedInputTokens: z.number().int().nonnegative().safe(),
  reasoningOutputTokens: z.number().int().nonnegative().safe(),
}).refine((u) => u.totalTokens === u.inputTokens + u.outputTokens && u.cachedInputTokens <= u.inputTokens &&
  u.reasoningOutputTokens <= u.outputTokens);
export interface CodexLunaResult {
  modelRequested: typeof OPENAI_MODEL;
  modelConfigured: typeof OPENAI_MODEL;
  modelReturned: null;
  threadId: string;
  turnId: string;
  cliVersion: string;
  tokenUsage: z.infer<typeof usageSchema>;
  outputSha256: string;
  classification: ReturnType<typeof validateCategoricalPayload>;
  classifiedAt: number;
}
export class CodexLunaError extends Error {
  constructor(readonly code: string, readonly dispatched: boolean) {
    super(`Codex Luna classification failed: ${code}`);
    this.name = "CodexLunaError";
  }
}

async function loadSession(): Promise<Session | null> {
  try {
    const existingCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const bytes = await readFile(join(existingCodexHome, "auth.json"));
    if (bytes.length > 128 * 1024) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export async function readExistingCodexSessionStatus(): Promise<{ configured: boolean }> {
  return { configured: await loadSession() !== null };
}

interface RunnerOptions {
  command: readonly [string, ...string[]];
  loadSession: () => Promise<Session | null>;
  timeoutMs: number;
  localProviderUrl?: string;
  observeTemporaryRoot?: (root: string) => void;
}
const nativeOptions: RunnerOptions = { command: ["codex"], loadSession, timeoutMs: TIMEOUT_MS };

function record(raw: unknown): Record<string, unknown> {
  return objectSchema.parse(raw);
}
function identifier(raw: unknown): string { return z.string().min(1).max(512).parse(raw); }

class RpcRejected extends Error {
  constructor(method: string) { super(`rpc_${method.replaceAll("/", "_")}_rejected`); }
}
class Rpc {
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve: (raw: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private bytes = 0;
  private failed: Error | null = null;
  constructor(readonly child: ChildProcessWithoutNullStreams, readonly notify: (packet: Record<string, unknown>) => void,
    readonly failure: (code: string) => void) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      this.bytes += Buffer.byteLength(data);
      if (this.bytes > MAX_PROTOCOL_BYTES) { this.failure("protocol_size_exceeded"); return; }
      this.buffer += data;
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const packet = record(JSON.parse(line));
          if (typeof packet.method === "string") this.notify(packet);
          else if (typeof packet.id === "number") {
            const request = this.pending.get(packet.id);
            if (!request) { this.failure("unexpected_rpc_response"); return; }
            this.pending.delete(packet.id);
            if ("error" in packet) request.reject(new RpcRejected(request.method));
            else if ("result" in packet) request.resolve(packet.result);
            else this.failure("invalid_rpc_response");
          } else this.failure("invalid_rpc_packet");
        } catch { this.failure("invalid_protocol"); return; }
      }
    });
    // Drain diagnostics without storing or echoing source text, tokens, or provider responses.
    child.stderr.resume();
    child.on("error", () => this.failure("cli_unavailable"));
    child.on("exit", () => this.failure("cli_exited"));
    child.stdin.on("error", () => this.failure("cli_write_failed"));
  }
  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  send(packet: unknown): void {
    if (this.failed) throw this.failed;
    this.child.stdin.write(`${JSON.stringify(packet)}\n`);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ id, method, params });
    });
  }
}

export async function runCodexLuna(input: OpenAIClassificationInput, beforeDispatch: () => void): Promise<CodexLunaResult> {
  return run(input, beforeDispatch, nativeOptions);
}

/** Protocol tests may replace the executable or use an unauthenticated localhost provider; product configuration cannot. */
export async function runCodexLunaForTest(input: OpenAIClassificationInput, beforeDispatch: () => void,
  options: Partial<RunnerOptions>): Promise<CodexLunaResult> {
  if (process.env.NODE_ENV !== "test") throw new CodexLunaError("test_injection_disabled", false);
  if (options.localProviderUrl) {
    const url = new URL(options.localProviderUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash)
      throw new CodexLunaError("test_provider_must_be_local", false);
  }
  return run(input, beforeDispatch, { ...nativeOptions, ...options });
}

async function run(input: OpenAIClassificationInput, beforeDispatch: () => void, options: RunnerOptions): Promise<CodexLunaResult> {
  let dispatched = false;
  let temporaryRoot: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let rpc: Rpc | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveCompletion: (result: CodexLunaResult) => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const completion = new Promise<CodexLunaResult>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => undefined);
  const fail = (code: string) => {
    if (settled) return;
    settled = true;
    const error = new CodexLunaError(code, dispatched);
    rpc?.fail(error);
    rejectCompletion(error);
    child?.kill("SIGTERM");
  };
  try {
    const bounded = boundClassificationInput(input);
    const session = options.localProviderUrl ? null : await options.loadSession();
    if (!session && !options.localProviderUrl) throw new CodexLunaError("existing_session_unavailable", false);
    temporaryRoot = await mkdtemp(join(tmpdir(), "sentiment-codex-"));
    temporaryRoot = await realpath(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    options.observeTemporaryRoot?.(temporaryRoot);
    const cwd = join(temporaryRoot, "item");
    const isolatedCodexHome = join(temporaryRoot, "codex-state");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(isolatedCodexHome, { mode: 0o700 });
    const config = {
      default_permissions: PERMISSIONS, project_doc_max_bytes: 0, web_search: "disabled",
      "analytics.enabled": false,
      ...Object.fromEntries(DISABLED_FEATURES.map((flag) => [`features.${flag}`, false])),
    };
    const settings = [
      ...Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      'cli_auth_credentials_store="ephemeral"',
      `permissions.${JSON.stringify(PERMISSIONS)}={filesystem={"/"="deny",${JSON.stringify(cwd)}="read"},network={enabled=false}}`,
    ];
    const modelProvider = options.localProviderUrl ? "desk_test" : "openai";
    if (options.localProviderUrl) settings.push(`model_providers.desk_test={name="Local protocol test",base_url=${JSON.stringify(options.localProviderUrl)},wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`);
    // This file contains policy only. Existing credentials are passed in memory through the documented experimental host-app RPC.
    await writeFile(join(isolatedCodexHome, "config.toml"), settings.join("\n"), { mode: 0o600 });
    const childEnvironment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) if (process.env[key]) childEnvironment[key] = process.env[key];
    childEnvironment.CODEX_HOME = isolatedCodexHome;
    const [executable, ...prefix] = options.command;
    child = spawn(executable, [...prefix, "app-server"], { cwd, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    let threadId: string | null = null;
    let turnId: string | null = null;
    let cliVersion = "";
    let tokenUsage: CodexLunaResult["tokenUsage"] | null = null;
    const messages = new Map<string, string>();
    const queued: Record<string, unknown>[] = [];
    const readItem = (raw: unknown) => {
      const item = record(raw);
      if (item.type === "agentMessage") {
        if (item.phase === "commentary" || item.phase === "partial_answer") return;
        if (item.phase != null && item.phase !== "final_answer") throw new Error("invalid_output_phase");
        const text = z.string().max(MAX_OUTPUT_BYTES).parse(item.text);
        if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error("output_size_exceeded");
        messages.set(identifier(item.id), text);
      } else if (item.type !== "userMessage" && item.type !== "reasoning") throw new Error("unexpected_tool_or_item");
    };
    const notification = (packet: Record<string, unknown>) => {
      if (settled) return;
      const method = packet.method;
      if ("id" in packet) { fail(method === "account/chatgptAuthTokens/refresh" ? "session_refresh_required" : "unexpected_server_request"); return; }
      if (method === "model/rerouted") { fail("model_rerouted"); return; }
      if (method === "error") { fail("turn_provider_error"); return; }
      if (method !== "item/started" && method !== "item/completed" && method !== "thread/tokenUsage/updated" && method !== "turn/completed") return;
      if (!turnId) { queued.push(packet); return; }
      try {
        const params = record(packet.params);
        const notificationTurn = method === "turn/completed" ? record(params.turn).id : params.turnId;
        if (params.threadId !== threadId || notificationTurn !== turnId) throw new Error("receipt_identity_mismatch");
        if (method === "item/started") {
          const type = record(params.item).type;
          if (type !== "userMessage" && type !== "agentMessage" && type !== "reasoning") throw new Error("unexpected_tool_or_item");
        } else if (method === "item/completed") readItem(params.item);
        else if (method === "thread/tokenUsage/updated") tokenUsage = usageSchema.parse(record(params.tokenUsage).last);
        else {
          const turn = record(params.turn);
          if (turn.status !== "completed" || turn.error != null) throw new Error("turn_not_completed");
          for (const item of z.array(z.unknown()).parse(turn.items)) readItem(item);
          if (messages.size !== 1 || !tokenUsage) throw new Error("completion_receipt_incomplete");
          const text = messages.values().next().value;
          if (text == null) throw new Error("output_missing");
          const classification = validateCategoricalPayload(JSON.parse(text), bounded);
          settled = true;
          resolveCompletion({ modelRequested: OPENAI_MODEL, modelConfigured: OPENAI_MODEL, modelReturned: null,
            threadId: identifier(threadId), turnId: identifier(turnId), cliVersion, tokenUsage,
            outputSha256: createHash("sha256").update(text).digest("hex"), classification, classifiedAt: Date.now() });
        }
      } catch { fail("invalid_completion_or_capability"); }
    };
    rpc = new Rpc(child, notification, fail);
    timer = setTimeout(() => fail("timeout"), Math.min(TIMEOUT_MS, Math.max(1, options.timeoutMs)));
    const initialized = record(await rpc.request("initialize", {
      clientInfo: { name: "sentiment_desk", version: "0.1.0" }, capabilities: { experimentalApi: true },
    }));
    if (initialized.codexHome !== isolatedCodexHome || typeof initialized.userAgent !== "string") throw new CodexLunaError("isolation_not_confirmed", false);
    const version = /^sentiment_desk\/(\d+\.\d+\.\d+)\s/u.exec(initialized.userAgent)?.[1];
    if (version !== CLI_VERSION) throw new CodexLunaError("unsupported_cli_version", false);
    cliVersion = version;
    rpc.send({ method: "initialized", params: {} });
    if (session) {
      const login = record(await rpc.request("account/login/start", { type: "chatgptAuthTokens",
        accessToken: session.tokens.access_token, chatgptAccountId: session.tokens.account_id }));
      if (login.type !== "chatgptAuthTokens") throw new CodexLunaError("unexpected_auth_mode", false);
    }
    const skills = z.object({ data: z.array(z.object({ skills: z.array(z.object({ path: z.string().min(1) })) })) })
      .parse(await rpc.request("skills/list", { cwds: [cwd], forceReload: true }));
    const paths = [...new Set(skills.data.flatMap((entry) => entry.skills.map((skill) => skill.path)))];
    const started = record(await rpc.request("thread/start", { cwd, model: OPENAI_MODEL, modelProvider,
      ephemeral: true, allowProviderModelFallback: false, approvalPolicy: "never", permissions: PERMISSIONS,
      baseInstructions: OPENAI_PROMPT, developerInstructions: "Return only the required classification JSON. Use no tools or external context.",
      dynamicTools: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
      config: { ...config, "skills.config": paths.map((path) => ({ path, enabled: false })) },
    }));
    if (started.model !== OPENAI_MODEL || started.modelProvider !== modelProvider || started.cwd !== cwd ||
      !Array.isArray(started.instructionSources) || started.instructionSources.length !== 0 || started.approvalPolicy !== "never" ||
      (started.activePermissionProfile != null && record(started.activePermissionProfile).id !== PERMISSIONS))
      throw new CodexLunaError("thread_isolation_mismatch", false);
    threadId = identifier(record(started.thread).id);
    if (settled) return await completion;
    beforeDispatch();
    dispatched = true;
    const turn = record(record(await rpc.request("turn/start", { threadId, model: OPENAI_MODEL, permissions: PERMISSIONS,
      effort: "low", input: [{ type: "text", text: JSON.stringify(bounded) }], outputSchema: CATEGORICAL_JSON_SCHEMA,
    })).turn);
    turnId = identifier(turn.id);
    for (const packet of queued) notification(packet);
    return await completion;
  } catch (error) {
    if (error instanceof CodexLunaError) throw error;
    if (error instanceof RpcRejected) throw new CodexLunaError(error.message, dispatched);
    throw new CodexLunaError(dispatched ? "request_failed_or_outcome_unknown" : "preflight_failed", dispatched);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    rpc?.fail(new CodexLunaError("runner_closed", dispatched));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { child?.kill("SIGKILL"); resolve(); }, 1000);
        child.once("exit", () => { clearTimeout(kill); resolve(); });
      });
    }
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
