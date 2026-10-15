import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createFrameworkIteration, createResearchDraft, initializePeCollectionDatabase, publishResearchDraft } from "@earendil-works/pe-boot";
import { availability, createServerIterationRuntime, serverIterationRuntimeStatus } from "./iteration-runtime.mjs";

const environment = {
  PE_INGEST_LLM_BASE_URL: "https://example.invalid/v1", PE_INGEST_LLM_API_KEY: "test-server-key", PE_INGEST_LLM_MODEL: "test-model",
  PE_INGEST_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"response_format":{"type":"json_object"}}',
};

test("runtime availability exposes no credentials and rejects unsafe protocol overrides", () => {
  assert.equal(serverIterationRuntimeStatus, availability);
  assert.equal(availability(environment).available, true);
  assert.equal(availability(environment).modelId, "test-model");
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
  ]) assert.equal(availability({ ...environment, ...changed }).available, false);
});

test("server runtime sends its explicit key and extra body to a local mock, not a user account", { timeout: 15000 }, async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "local mock denies access", type: "authentication_error" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment, { PE_INGEST_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
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
  await assert.rejects(runtime.engine.extract(run, basis, AbortSignal.timeout(10000)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer test-server-key");
  assert.equal(requests[0].body.model, "test-model");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(requests[0].body.stream, true);
  assert.ok(requests[0].body.tools.some((tool) => tool.function.name === "pe_iteration_submit"));
});
