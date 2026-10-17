import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createFrameworkIteration, createResearchDraft, informationSourceConfig, initializePeCollectionDatabase, publishResearchDraft } from "@earendil-works/pe-boot";
import { availability, createServerIterationRuntime, serverIterationRuntimeStatus } from "./iteration-runtime.mjs";

const environment = {
  PE_INGEST_LLM_BASE_URL: "https://example.invalid/v1", PE_INGEST_LLM_API_KEY: "test-server-key", PE_INGEST_LLM_MODEL: "test-model",
  PE_INGEST_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}}',
};

test("runtime availability exposes no credentials and rejects unsafe protocol overrides", () => {
  assert.equal(serverIterationRuntimeStatus, availability);
  assert.equal(availability(environment).available, true);
  assert.equal(availability(environment).modelId, "test-model");
  assert.equal(availability(environment).contextWindow, 64000);
  assert.equal(availability({ ...environment, PE_INGEST_LLM_BASE_URL: "https://api.deepseek.com", PE_INGEST_LLM_MODEL: "deepseek-v4-flash" }).contextWindow, 1000000);
  assert.equal(availability({ ...environment, PE_INGEST_LLM_CONTEXT_WINDOW: "128000" }).contextWindow, 128000);
  const serialized = JSON.stringify(availability(environment));
  assert.equal(serialized.includes("test-server-key"), false);
  assert.equal(serialized.includes("example.invalid"), false);
  for (const changed of [
    { PE_INGEST_LLM_API_KEY: "" }, { PE_INGEST_LLM_MODEL: "" }, { PE_INGEST_LLM_EXTRA_BODY: "[1]" },
    { PE_INGEST_LLM_EXTRA_BODY: "broken" }, { PE_INGEST_LLM_EXTRA_BODY: '{"messages":[]}' },
    { PE_INGEST_LLM_EXTRA_BODY: '{"tools":[]}' }, { PE_INGEST_LLM_EXTRA_BODY: '{"stream":false}' },
    { PE_INGEST_LLM_EXTRA_BODY: '{"__proto__":{}}' },
    { PE_INGEST_LLM_BASE_URL: "https://user:test-server-key@example.invalid" },
    { PE_INGEST_LLM_BASE_URL: "http://example.invalid" },
    { PE_INGEST_LLM_CONTEXT_WINDOW: "0" }, { PE_INGEST_LLM_CONTEXT_WINDOW: "1.5" }, { PE_INGEST_LLM_CONTEXT_WINDOW: "NaN" },
  ]) assert.equal(availability({ ...environment, ...changed }).available, false);
});

test("server runtime sends its explicit key and extra body to a local mock, not a user account", { timeout: 15000 }, async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ authorization: request.headers.authorization, body: payload });
    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "large-context", object: "chat.completion.chunk", created: 1, model: "test-model" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "pe_iteration_read", arguments: '{"docId":"outside","action":"inspect"}' } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 70000, completion_tokens: 20, total_tokens: 70020 } })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (payload.response_format?.type === "json_object" && !/json/i.test(JSON.stringify(payload.messages))) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Prompt must contain the word 'json' to use json_object", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "local mock denies access", type: "authentication_error" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const previous = Object.fromEntries([...Object.keys(environment), "PE_INGEST_LLM_CONTEXT_WINDOW"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment, { PE_INGEST_LLM_CONTEXT_WINDOW: "1000000", PE_INGEST_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const cwd = mkdtempSync(join(tmpdir(), "pe-server-runtime-test-"));
  mkdirSync(join(cwd, "meta"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const datasetId = "dataset_runtime_test";
  initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "Runtime test" });
  const jiti = createJiti(import.meta.url);
  const { frameworkFixture } = await jiti.import("../../../../packages/pe-boot/test/fixtures/framework.ts");
  const basis = frameworkFixture();
  const draft = createResearchDraft(cwd, datasetId, basis, [], null);
  const version = publishResearchDraft(cwd, datasetId, { draftId: draft.id, revision: 1, expectedVersionId: null, requestId: "initial" });
  const run = createFrameworkIteration(cwd, datasetId, { requestId: "runtime", basisVersionId: version.id, modelId: "test-model", uploadIdentity: "mock", changeReview: true });
  await assert.rejects(createServerIterationRuntime(cwd, datasetId, { ...run, modelId: "other-user-model" }, new AbortController().signal), /不一致/);
  const runtime = await createServerIterationRuntime(cwd, datasetId, run, new AbortController().signal);
  t.after(() => runtime.dispose());
  const observations = { observations: [], coverage: [] };
  const impacts = { substantive: false, summary: "没有变化", impacts: [], gaps: [] };
  const sourceRun = { ...run, sourceMode: "sources", sourceConfig: informationSourceConfig("测试公司", "000001.SZ", ["wind-financials"]) };
  for (const invoke of [
    () => runtime.engine.prepare(run, basis, AbortSignal.timeout(10000)),
    () => runtime.engine.collect(sourceRun, basis, AbortSignal.timeout(10000)),
    () => runtime.engine.extract(run, basis, AbortSignal.timeout(10000)),
    () => runtime.engine.impact(run, basis, observations, AbortSignal.timeout(10000)),
    () => runtime.engine.revise(run, basis, observations, impacts, AbortSignal.timeout(10000)),
  ]) await assert.rejects(invoke(), /平台授权失效/, "the mock's JSON-mode validation must pass before its deliberate authentication rejection");
  assert.equal(requests.length, 6);
  assert.equal(requests[1].body.max_tokens, 8192, "70K input usage must not collapse the next tool reply to one token");
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer test-server-key");
    assert.equal(request.body.model, "test-model");
    assert.deepEqual(request.body.thinking, { type: "disabled" });
    assert.equal(request.body.response_format, undefined, "tool schemas provide the structured result; JSON text mode must not compete with tool calls");
    assert.match(JSON.stringify(request.body.messages), /json/i, "all five stages must explicitly instruct JSON in message content");
    assert.equal(request.body.stream, true);
    assert.ok(request.body.tools.some((tool) => tool.function.name === "pe_iteration_submit"));
  }
});
