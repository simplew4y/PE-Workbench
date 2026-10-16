import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";
import { registerPeDocuments, saveIterationModelConfig, saveResearchMonitor, createResearchDraft, publishResearchDraft, createFrameworkIteration, getFrameworkIteration } from "@earendil-works/pe-boot";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import("./route.ts");
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");
const { frameworkFixture } = await jiti.import("../../../../../../packages/pe-boot/test/fixtures/framework.ts");

test("workflow reads and writes enforce origin, identity, revision and explicit background-cost acknowledgement", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "pe-workflow-route-"));
  const environment = {
    PI_CODING_AGENT_DIR: root, PE_MULTI_USER_MODE: "0", PE_INGEST_LLM_MODEL: "deepseek-test",
    DEEPSEEK_API_KEY: "", DEEPSEEK_MODEL: "", DEEPSEEK_BASE_URL: "",
    PE_INGEST_LLM_BASE_URL: "https://example.invalid/v1", PE_INGEST_LLM_API_KEY: "never-send-test-key", PE_INGEST_LLM_EXTRA_BODY: "{}",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const priorGateway = globalThis.__peGatewayRuntime;
  const priorLockCheck = lockfile.check;
  lockfile.check = async () => true;
  Object.assign(process.env, environment);
  globalThis.__peGatewayRuntime = {
    config: { cookie: { name: "test-session" } }, store: { getSession: () => ({ userId: "test-user" }) },
    auth: { currentUser: async () => ({ id: "test-user" }), requireSession: async () => ({ userId: "test-user" }) },
  };
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    globalThis.__peGatewayRuntime = priorGateway;
    lockfile.check = priorLockCheck;
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "Unified tracking test", companyName: "Test Company", companyTicker: "1234.HK" });
  const headers = { host: "localhost", cookie: "test-session=authorized", "Content-Type": "application/json" };
  const request = (body) => POST(new NextRequest("http://localhost/api/pe/research-workflow", { method: "POST", headers, body: JSON.stringify({ datasetId: project.datasetId, ...body }) }));
  const read = () => GET(new NextRequest(`http://localhost/api/pe/research-workflow?datasetId=${project.datasetId}`, { headers }));
  const response = await read();
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.modelConfig, null);
  assert.equal(snapshot.modelResult, null);
  assert.equal(snapshot.serverRuntime.available, true);
  assert.equal(JSON.stringify(snapshot).includes("never-send-test-key"), false);
  const noFramework = await request({ action: "updates-run" });
  assert.equal(noFramework.status, 409, "a project with no saved framework still cannot start an update");
  assert.match((await noFramework.json()).error, /先保存一份投资框架/);
  const plan = { action: "monitor-save", enabled: false, collectSources: false, intervalHours: 24, revision: 0 };
  assert.equal((await request({ ...plan, enabled: true })).status, 409);
  assert.equal((await request(plan)).status, 200);
  assert.equal((await request(plan)).status, 409, "stale revision is rejected");
  const saved = await (await read()).json();
  assert.equal(saved.monitor.config.pipeline, "iteration");
  assert.equal(saved.monitor.config.runtime, "server");
  assert.equal(saved.monitor.config.mode, "review");
  assert.equal((await request({ action: "monitor-run" })).status, 409, "paused plans do not start workers");
  assert.equal((await request({ ...plan, revision: 1, intervalHours: 48, collectSources: true })).status, 200);
  const changed = await (await read()).json();
  assert.equal(changed.monitor.config.intervalHours, 48, "saving paused settings retains edited interval");
  assert.ok(changed.monitor.config.sourceConfig, "saving paused settings retains source selection");
  assert.equal(changed.monitor.config.enabled, false);
  saveResearchMonitor(project.root, project.datasetId, { enabled: false, mode: "review", intervalHours: 24, objective: "legacy plan", queries: [], includeMemos: false }, 2);
  process.env.PE_INGEST_LLM_API_KEY = "";
  process.env.PE_INGEST_LLM_MODEL = "";
  assert.equal((await request({ action: "monitor-pause", revision: 3 })).status, 200, "pausing an existing legacy plan does not require a model or paid access");
  assert.equal((await request({ action: "monitor-pause", revision: 3 })).status, 409, "pause also enforces revision");
  const partial = await GET(new NextRequest(`http://localhost/api/pe/research-workflow?datasetId=${project.datasetId}&docId=missing-workbook`, { headers }));
  assert.equal(partial.status, 200, "an unreadable model does not hide tracking controls");
  const partialSnapshot = await partial.json();
  assert.equal(partialSnapshot.modelVersions, null);
  assert.match(partialSnapshot.modelError, /重新绑定/);
  assert.equal(partialSnapshot.monitor.config.enabled, false);
  assert.ok(Array.isArray(partialSnapshot.documents));
  assert.equal((await request({ action: "monitor-pause", revision: 4 })).status, 200);
  const workbook = readFileSync(new URL("../../../../../../packages/pe-boot/test/fixtures/excel-parity.xlsx", import.meta.url));
  const docId = String(registerPeDocuments(project.root, project.datasetId, [{ name: "model.xlsx", bytes: workbook }]).documents[0].doc_id);
  saveIterationModelConfig(project.root, project.datasetId, {
    expectedRevision: 0, docId, baseVersionId: null,
    mappings: [{ id: "revenue", subject: "Test Company", metric: "Revenue", period: "2026Q2", periodKind: "single", asOf: null, unit: "CNY", scope: "group", currency: "CNY", role: "actual", sheet: "DCF", cell: "B2", expectedValue: 100 }],
  });
  rmSync(join(project.root, "raw/model.xlsx"));
  const missingOriginal = await read();
  assert.equal(missingOriginal.status, 200);
  const recoverable = await missingOriginal.json();
  assert.equal(recoverable.modelConfig.docId, docId);
  assert.equal(recoverable.modelVersions, null);
  assert.match(recoverable.modelError, /重新绑定/);
  assert.equal((await request({ action: "monitor-pause", revision: 5 })).status, 200, "missing original does not prevent pausing");
  assert.equal((await request({ action: "model-save", config: { arbitrary: true } })).status, 400);
  assert.equal((await request({ action: "model-promote", revision: 1, runId: "unrelated" })).status, 400);
  process.env.PE_INGEST_LLM_API_KEY = "never-send-test-key";
  process.env.PE_INGEST_LLM_MODEL = "test-model";
  const draft = createResearchDraft(project.root, project.datasetId, frameworkFixture(), [], null);
  const basis = publishResearchDraft(project.root, project.datasetId, { draftId: draft.id, revision: 1, expectedVersionId: null, requestId: "initial" });
  process.env.PE_INGEST_LLM_MODEL = "deepseek-test";
  const direct = { action: "updates-save", applyUpdates: true, enabled: false, revision: 6 };
  assert.equal((await request({ ...direct, applyUpdates: false })).status, 400);
  const savedDirect = await request(direct);
  assert.equal(savedDirect.status, 200);
  const updated = await savedDirect.json();
  assert.equal(updated.monitor.config.mode, "auto");
  assert.equal(updated.monitor.config.updatePolicy, "direct");
  assert.equal(updated.monitor.config.intervalHours, 168);
  assert.equal(updated.monitor.config.enabled, false);
  assert.equal(updated.monitor.config.pipeline, "script");
  assert.equal(updated.monitor.config.sourceConfig, undefined, "identity and query dates are discovered from source files, not supplied by the user");
  assert.equal((await request(direct)).status, 409, "direct settings also enforce revision");
  const db = new DatabaseSync(join(project.root, "meta/collection.sqlite3"));
  context.after(() => db.close());
  db.prepare("INSERT INTO research_monitor_runs VALUES('unlinked',?,7,'blocked',0,?,?)").run(project.datasetId, JSON.stringify({ id: "unlinked", status: "blocked", events: [], startedAt: "2026-10-15" }), "2026-10-15");
  assert.equal((await request({ action: "updates-cancel", monitorRunId: "unlinked" })).status, 200, "a failure before iteration creation can be ended");
  const iteration = createFrameworkIteration(project.root, project.datasetId, { requestId: "completed-framework", basisVersionId: basis.id, modelId: "test-model", uploadIdentity: "none" });
  db.prepare("UPDATE framework_iterations SET status='no_change',record_json=json_set(record_json,'$.status','no_change') WHERE id=?").run(iteration.id);
  db.prepare("INSERT INTO research_monitor_runs VALUES('model-running',?,7,'running',?,?,?)").run(project.datasetId, Date.now() + 60_000, JSON.stringify({ id: "model-running", status: "running", iterationId: iteration.id, events: [], startedAt: "2026-10-16" }), "2026-10-16");
  assert.equal((await request({ action: "updates-cancel", monitorRunId: "model-running" })).status, 200, "a completed framework does not prevent stopping model adoption");
  assert.equal(getFrameworkIteration(project.root, project.datasetId, iteration.id).status, "no_change");
  assert.equal(db.prepare("SELECT status FROM research_monitor_runs WHERE run_id='model-running'").get().status, "cancelled");
  db.prepare("INSERT INTO research_monitor_runs VALUES('abandoned-manual',?,7,'running',0,?,?)").run(project.datasetId, JSON.stringify({ id: "abandoned-manual", status: "running", events: [], startedAt: "2026-10-17" }), "2026-10-17");
  const recovered = await (await read()).json();
  assert.equal(recovered.monitor.manualRequested, false);
  assert.equal(recovered.monitor.config.enabled, false);
  assert.equal(recovered.monitor.runs[0].status, "cancelled", "polling clears an expired manual run so both buttons become usable again");
  const automaticProject = createPeProject({ name: "Automatic only", companyName: "Test Company", companyTicker: "1234.HK" });
  const automaticDraft = createResearchDraft(automaticProject.root, automaticProject.datasetId, frameworkFixture(), [], null);
  publishResearchDraft(automaticProject.root, automaticProject.datasetId, { draftId: automaticDraft.id, revision: 1, expectedVersionId: null, requestId: "initial-auto" });
  const automaticDb = new DatabaseSync(join(automaticProject.root, "meta/collection.sqlite3"));
  const savedContent = { title: "Test Company 1234.HK 投资框架", objective: "追踪原有判断", horizon: "两年", items: [{ id: "demand", kind: "hypothesis", subject: "需求", claim: "增长待验证", rationale: "沿用已保存假设", verification: "核对收入", invalidation: "收入下滑", origin: "user", evidenceIds: [] }], coverageGaps: [] };
  automaticDb.prepare("INSERT INTO research_versions VALUES('old-format',?,2,(SELECT current_version_id FROM research_frameworks WHERE dataset_id=?),?,'[]',?,'old-save','{}')").run(automaticProject.datasetId, automaticProject.datasetId, JSON.stringify(savedContent), "2026-09-14");
  automaticDb.prepare("UPDATE research_frameworks SET current_version_id='old-format' WHERE dataset_id=?").run(automaticProject.datasetId);
  automaticDb.close();
  const automatic = await request({ action: "updates-run", datasetId: automaticProject.datasetId });
  assert.equal(automatic.status, 202, "a saved legacy framework works without resaving, model selection, mapping, date, or schedule");
  const automaticState = await automatic.json();
  assert.equal(automaticState.monitor.config.pipeline, "script");
  assert.equal(automaticState.monitor.config.enabled, false, "a manual update does not silently enable weekly updates");
  assert.equal(automaticState.monitor.manualRequested, true);
  assert.equal((await request({ action: "updates-run", datasetId: automaticProject.datasetId })).status, 202, "double clicks reuse the queued update");
  const crossSite = await GET(new NextRequest(`http://localhost/api/pe/research-workflow?datasetId=${project.datasetId}&runId=other&download=model`, {
    headers: { ...headers, origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(crossSite.status, 403);
  globalThis.__peGatewayRuntime.store.getSession = () => null;
  assert.equal((await read()).status, 401);
});
