import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexLunaError, readExistingCodexSessionStatus, runCodexLunaForTest } from "../server/codex-luna-runner.js";
import { CATEGORICAL_JSON_SCHEMA, OPENAI_MODEL, OPENAI_PROMPT, type OpenAIClassificationInput } from "../server/openai-classifier.js";

const input: OpenAIClassificationInput = { company: { name: "Protocol Test Issuer", ticker: "TEST", sector: "Technology" },
  source: { collector: "test", publisher: "Protocol fixture", title: "Protocol Test Issuer reports revenue growth", excerpt: "Revenue increased during the reporting period." } };
const output = { sentiment: "positive", event_type: "results", takeaway: "results_beat", about: true, material: true,
  investor_relevant: true, evidence_sufficient: true, summary: "The source reports revenue growth.", supporting_excerpt: "Revenue increased" };
const session = { auth_mode: "chatgpt" as const, tokens: { access_token: "test-only-token", account_id: "test-only-account" } };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(scenario = "success") {
  const root = await mkdtemp(join(tmpdir(), "desk-runner-test-")); roots.push(root);
  const script = join(root, "rpc.mjs");
  const log = join(root, "calls.jsonl");
  await writeFile(script, `
import {createInterface} from 'node:readline';
import {appendFileSync,readdirSync,statSync,readFileSync} from 'node:fs';
const scenario=${JSON.stringify(scenario)}, log=${JSON.stringify(log)}, output=${JSON.stringify(output)};
const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=(method,params)=>send({method,params});
const respond=(id,result)=>send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line), p=q.params;
 const clean=q.method==='account/login/start'?{type:p.type}:p;
 appendFileSync(log,JSON.stringify({method:q.method,params:clean})+'\\n');
 if(q.method==='initialize') respond(q.id,{codexHome:process.env.CODEX_HOME,userAgent:'sentiment_desk/'+(scenario==='version'?'0.162.2':'0.162.1')+' (Protocol test)'});
 else if(q.method==='initialized') {}
 else if(q.method==='account/login/start') {
  if(scenario==='refresh_preflight') send({id:900,method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized'}});
  else respond(q.id,{type:'chatgptAuthTokens'});
 }
 else if(q.method==='skills/list') respond(q.id,{data:[{skills:[{path:'/test/global/skill.md'}]}]});
 else if(q.method==='thread/start') {
  appendFileSync(log,JSON.stringify({environment:{openai:process.env.OPENAI_API_KEY,provider:process.env.MODEL_PROVIDER_BASE_URL},stateFiles:readdirSync(process.env.CODEX_HOME),stateMode:statSync(process.env.CODEX_HOME).mode&511,rootMode:statSync(process.cwd()+'/..').mode&511,config:readFileSync(process.env.CODEX_HOME+'/config.toml','utf8')})+'\\n');
  respond(q.id,{model:'gpt-6-luna',modelProvider:'openai',cwd:p.cwd,approvalPolicy:'never',activePermissionProfile:{id:scenario==='permissions'?'wrong':'sentiment-item'},instructionSources:scenario==='instructions'?['/test/AGENTS.md']:[],thread:{id:'thread_protocol'}});
 }
 else if(q.method==='turn/start') {
  respond(q.id,{turn:{id:'turn_protocol',items:[],status:'inProgress'}});
  if(scenario==='timeout') return;
  if(scenario==='overflow') {process.stdout.write('x'.repeat(1024*1024+1));return;}
  if(scenario==='reroute') {notify('model/rerouted',{fromModel:'gpt-6-luna',toModel:'other'});return;}
  if(scenario==='refresh') {send({id:901,method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized'}});return;}
  if(scenario==='approval') {send({id:902,method:'item/commandExecution/requestApproval',params:{}});return;}
  if(scenario==='tool') {notify('item/started',{threadId:'thread_protocol',turnId:'turn_protocol',item:{id:'tool',type:'commandExecution'}});return;}
  const threadId=scenario==='identity'?'other_thread':'thread_protocol',turnId='turn_protocol';
  const usage={inputTokens:50,outputTokens:30,totalTokens:scenario==='usage'?90:80,cachedInputTokens:10,reasoningOutputTokens:5};
  if(scenario!=='no_usage') notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{last:usage,total:usage}});
  const result=scenario==='quote'?{...output,supporting_excerpt:'invented quotation'}:output;
  const item={id:'answer',type:'agentMessage',phase:'final_answer',text:JSON.stringify(result)};
  notify('item/completed',{threadId,turnId,item});
  if(scenario==='duplicate') notify('item/completed',{threadId,turnId,item:{...item,id:'another_answer'}});
  notify('turn/completed',{threadId,turn:{id:turnId,status:scenario==='failed'?'failed':'completed',items:scenario==='with_items'?[item]:[]}});
 }
});
`);
  let temporaryRoot = "";
  const run = (beforeDispatch = () => undefined) => runCodexLunaForTest(input, beforeDispatch, {
    command: [process.execPath, script], loadSession: async () => session, timeoutMs: scenario === "timeout" ? 2000 : 5000,
    observeTemporaryRoot: (value) => { temporaryRoot = value; },
  });
  const calls = async (): Promise<Array<Record<string, unknown>>> => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { run, calls, temporaryRoot: () => temporaryRoot };
}

describe("existing Codex Luna isolated runner", () => {
  it("reads only the explicitly selected local credential file, returning no credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "desk-status-test-")); roots.push(root);
    vi.stubEnv("CODEX_HOME", root);
    expect(await readExistingCodexSessionStatus()).toEqual({ configured: false });
    await writeFile(join(root, "auth.json"), JSON.stringify(session));
    expect(await readExistingCodexSessionStatus()).toEqual({ configured: true });
    await writeFile(join(root, "auth.json"), JSON.stringify({ ...session, auth_mode: "apikey" }));
    expect(await readExistingCodexSessionStatus()).toEqual({ configured: false });
    await writeFile(join(root, "auth.json"), "invalid json");
    expect(await readExistingCodexSessionStatus()).toEqual({ configured: false });
  });

  it.each(["success", "with_items"])("returns native receipt identity without inventing returned model or Responses id (%s)", async (scenario) => {
    const f = await fixture(scenario);
    const order: string[] = [];
    const result = await f.run(() => { order.push("dispatch"); });
    expect(order).toEqual(["dispatch"]);
    expect(result).toMatchObject({ modelRequested: OPENAI_MODEL, modelConfigured: OPENAI_MODEL, modelReturned: null,
      threadId: "thread_protocol", turnId: "turn_protocol", cliVersion: "0.162.1", tokenUsage: {
        inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedInputTokens: 10, reasoningOutputTokens: 5,
      }, classification: { sentiment: "positive", supportingExcerpt: "Revenue increased" } });
    expect(result).not.toHaveProperty("responseId");
    expect(result.outputSha256).toBe(createHash("sha256").update(JSON.stringify(output)).digest("hex"));
    expect(result.classifiedAt).toBeGreaterThan(Date.now() - 5000);
    const calls = await f.calls();
    const thread = calls.find((call) => call.method === "thread/start");
    expect(thread).toMatchObject({ params: { ephemeral: true, allowProviderModelFallback: false, baseInstructions: OPENAI_PROMPT,
      dynamicTools: [], selectedCapabilityRoots: [], config: { "skills.config": [{ path: "/test/global/skill.md", enabled: false }] } } });
    const turn = calls.find((call) => call.method === "turn/start");
    expect(turn).toMatchObject({ params: { effort: "low", outputSchema: CATEGORICAL_JSON_SCHEMA, input: [{ type: "text", text: JSON.stringify(input) }] } });
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await expect(stat(f.temporaryRoot())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps original environment unchanged, excludes keys, writes policy without credentials, and cleans isolated state", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-sentinel-secret");
    vi.stubEnv("MODEL_PROVIDER_BASE_URL", "https://untrusted.example");
    const originalCodexHome = process.env.CODEX_HOME;
    const originalHome = process.env.HOME;
    const f = await fixture(); await f.run();
    const calls = await f.calls();
    const state = calls.find((call) => "stateFiles" in call);
    expect(state).toMatchObject({ environment: {}, stateFiles: ["config.toml"], stateMode: 448, rootMode: 448 });
    expect(state?.config).toContain('cli_auth_credentials_store="ephemeral"');
    expect(state?.config).toContain('"/"="deny"');
    expect(state?.config).toContain('network={enabled=false}');
    expect(JSON.stringify(state)).not.toContain(session.tokens.access_token);
    expect(process.env.CODEX_HOME).toBe(originalCodexHome);
    expect(process.env.HOME).toBe(originalHome);
    expect(process.env.OPENAI_API_KEY).toBe("test-sentinel-secret");
    await expect(readdir(f.temporaryRoot())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["instructions", "permissions", "version", "refresh_preflight"])("does not dispatch when native isolation/auth preflight fails (%s)", async (scenario) => {
    const f = await fixture(scenario); const hook = vi.fn();
    await expect(f.run(hook)).rejects.toMatchObject({ dispatched: false });
    expect(hook).not.toHaveBeenCalled();
    expect((await f.calls()).some((call) => call.method === "turn/start")).toBe(false);
    await expect(stat(f.temporaryRoot())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves known-unsent status when final admission hook vetoes the request", async () => {
    const f = await fixture();
    await expect(f.run(() => { throw new Error("private-admission-sentinel"); })).rejects.toMatchObject({ dispatched: false });
    expect((await f.calls()).some((call) => call.method === "turn/start")).toBe(false);
  });

  it.each(["reroute", "refresh", "approval", "tool", "identity", "usage", "no_usage", "quote", "duplicate", "failed", "overflow", "timeout"])(
    "rejects unsafe or incomplete dispatched turn, never retries, and removes temporary state (%s)", async (scenario) => {
      const f = await fixture(scenario);
      await expect(f.run()).rejects.toMatchObject({ dispatched: true });
      expect((await f.calls()).filter((call) => call.method === "turn/start")).toHaveLength(1);
      await expect(stat(f.temporaryRoot())).rejects.toMatchObject({ code: "ENOENT" });
    });

  it("fails locally without an existing session, before calling final admission", async () => {
    const hook = vi.fn();
    await expect(runCodexLunaForTest(input, hook, { loadSession: async () => null }))
      .rejects.toMatchObject({ code: "existing_session_unavailable", dispatched: false });
    expect(hook).not.toHaveBeenCalled();
  });
});

const nativeInstalled = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim() === "codex-cli 0.162.1";
describe("native Codex request boundary (localhost only; no account or inference)", () => {
  it.skipIf(!nativeInstalled).each(["reject", "complete"])("sends only bounded source without tools or ambient instructions, and handles native %s", async (mode) => {
    const captured: Array<{ body: Record<string, unknown>; authorization: boolean }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: request.headers.authorization !== undefined });
        if (mode === "reject") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Local protocol boundary, no inference performed", type: "invalid_request_error" } }));
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const item = { id: "msg_native_protocol", type: "message", role: "assistant", phase: "final_answer", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] };
          const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
          response.end(event("response.output_item.done", { output_index: 0, item }) + event("response.completed", {
            response: { id: "resp_native_protocol", status: "completed", model: OPENAI_MODEL, output: [item],
              usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } },
          }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local test server address");
    let temporaryRoot = "";
    try {
      const result: unknown = await runCodexLunaForTest(input, () => undefined, {
        localProviderUrl: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 15_000,
        loadSession: async () => { throw new Error("Native fake provider must not read real credentials"); },
        observeTemporaryRoot: (value) => { temporaryRoot = value; },
      }).catch((error: unknown) => error);
      if (mode === "reject") expect(result).toBeInstanceOf(CodexLunaError);
      else expect(result).toMatchObject({ modelRequested: OPENAI_MODEL, modelReturned: null, classification: { sentiment: "positive" },
        tokenUsage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 } });
      expect(captured, result instanceof CodexLunaError ? `${result.code}; dispatched=${result.dispatched}` : "native result").toHaveLength(1);
      const request = captured[0];
      expect(request?.authorization).toBe(false);
      expect(request?.body.model).toBe(OPENAI_MODEL);
      expect(request?.body.tools ?? []).toEqual([]);
      const serialized = JSON.stringify(request?.body);
      expect(serialized).toContain(input.source.title);
      expect(serialized).toContain(input.source.excerpt);
      expect(serialized).not.toContain("# AGENTS.md instructions");
      expect(serialized).not.toContain("<skills_instructions>");
      expect(serialized).not.toContain("### Available skills");
      expect(serialized).toContain(JSON.stringify(OPENAI_PROMPT).slice(1, -1));
      await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }, 20_000);
});
