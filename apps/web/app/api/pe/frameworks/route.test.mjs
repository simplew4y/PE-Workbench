import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager, ModelRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createResearchDraft, getResearchFramework, listResearchContinuations } from "@earendil-works/pe-boot";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { cacheSessionPath } = await jiti.import("../../../../lib/session-reader.ts");
const { AgentSessionWrapper } = await jiti.import("../../../../lib/rpc-manager.ts");
const { AuthStorage } = await jiti.import("../../../../../../packages/coding-agent/src/core/auth-storage.ts");
const { frameworkFixture } = await jiti.import("../../../../../../packages/pe-boot/test/fixtures/framework.ts");
const { renderInvestmentFrameworkMarkdown } = await jiti.import("../../../../../../packages/pe-boot/src/research/report.ts");

test("project API creates, saves and publishes a draft; rejects stale, invalid and cross-project actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pe-framework-route-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "Framework route test" });
  const other = createPeProject({ name: "Other project" });
  const request = (body) => POST(new Request("http://localhost/api/pe/frameworks", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: project.datasetId, ...body }),
  }));
  const content = frameworkFixture({
    title: "框架", objective: "检查盈利", horizon: "未来一年", coverageGaps: ["待补财报"],
    items: [{ id: "margin", kind: "hypothesis", claim: "盈利可能恢复", rationale: "用户假设", subject: "试点公司", verification: "毛利率恢复", invalidation: "毛利率连续下降", origin: "user", evidenceIds: [] }],
  });
  const created = await request({ action: "create", content, docIds: [], expectedVersionId: null });
  assert.equal(created.status, 201);
  const { draft } = await created.json();
  assert.equal((await request({ action: "save", draftId: draft.id, revision: 1, content, datasetId: other.datasetId })).status, 404);
  assert.equal((await request({ action: "save", draftId: draft.id, revision: 1, content: { ...content, title: "修订" } })).status, 200);
  assert.equal((await request({ action: "save", draftId: draft.id, revision: 1, content })).status, 409);
  assert.equal((await request({ action: "publish", draftId: draft.id, revision: 2, expectedVersionId: null, requestId: "publish" })).status, 200);
  const snapshot = await GET(new Request(`http://localhost/api/pe/frameworks?datasetId=${project.datasetId}`));
  assert.equal(snapshot.status, 200);
  const { framework } = await snapshot.json();
  assert.equal(framework.versions[0].content.title, "修订");
  assert.deepEqual(framework.versions[0].content, { ...content, title: "修订" });
  const download = await GET(new Request(`http://localhost/api/pe/frameworks?datasetId=${project.datasetId}&download=${framework.currentVersionId}`));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type"), /text\/markdown/);
  const markdown = await download.text();
  assert.equal(markdown, renderInvestmentFrameworkMarkdown(framework.versions[0].content));
  for (const heading of ["研究设定", "当前判断", "公司如何创造价值", "投资判断与其他解释", "市场预期、估值与回报", "什么情况下我们错了", "证据、未知问题与版本变化"]) assert.ok(markdown.includes(heading), heading);
  const config = { enabled: false, mode: "auto", intervalHours: 24, objective: "持续核对新资料", queries: [], includeMemos: true };
  assert.equal((await request({ action: "monitor-save", revision: 0, config })).status, 200);
  const monitorResponse = await GET(new Request(`http://localhost/api/pe/frameworks?datasetId=${project.datasetId}`));
  assert.equal((await monitorResponse.json()).monitor.config.mode, "auto");
  assert.equal((await request({ action: "monitor-save", revision: 0, config })).status, 409);
  assert.equal((await request({ action: "monitor-run" })).status, 409, "paused plans cannot be dispatched");
  assert.equal((await request({ action: "generate", objective: "复盘", docIds: [], expectedVersionId: framework.currentVersionId, requestId: "review" })).status, 202);
  assert.equal((await request({ action: "create", content: {}, docIds: [], expectedVersionId: framework.currentVersionId })).status, 400);
  assert.equal((await request({ action: "create", content: { title: "旧框架", objective: "目标", horizon: "一年", items: content.sections.investmentJudgments.items, coverageGaps: [] }, docIds: [], expectedVersionId: framework.currentVersionId })).status, 400);
  assert.equal((await request({ action: "unknown" })).status, 400);
  assert.equal((await POST(new Request("http://localhost/api/pe/frameworks", { method: "POST", body: "null" }))).status, 400);
});

test("confirmation binds source, persists once, retries into real Pi and reconciles a persisted receipt after restart", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pe-confirmation-route-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldMode = process.env.PE_MULTI_USER_MODE;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  const project = createPeProject({ name: "Confirmation integration" });
  const content = frameworkFixture({ title: "确认测试", objective: "需求验证", horizon: "一年", coverageGaps: [], items: [{ id: "demand", kind: "hypothesis", claim: "需求稳定", rationale: "待验证", subject: "测试公司", verification: "复购", invalidation: "库存上升", origin: "user", evidenceIds: [] }] });
  const draft = createResearchDraft(project.root, project.datasetId, content, [], null);
  const manager = SessionManager.create(project.root, join(root, "sessions"));
  const sid = manager.getSessionId();
  const assistant = { role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  manager.appendMessage({ role: "user", content: "生成投资框架", timestamp: Date.now() });
  manager.appendMessage({ ...assistant, content: [{ type: "toolCall", id: "proposal-call", name: "pe_investment_framework", arguments: { operation: "propose" } }], stopReason: "toolUse" });
  manager.appendMessage({ role: "toolResult", toolCallId: "proposal-call", toolName: "pe_investment_framework", content: [], details: { kind: "pe_framework_draft", datasetId: project.datasetId, draft }, isError: false, timestamp: Date.now() });
  manager.appendMessage({ ...assistant, content: [{ type: "text", text: "请确认框架" }], stopReason: "stop" });
  cacheSessionPath(sid, manager.getSessionFile());
  let admissions = 0;
  const wrapper = { sessionId: sid, isAlive: () => true, inner: { sessionManager: manager, model: { provider: "test" }, getFollowUpMessages: () => [], getSteeringMessages: () => [] },
    async send(command) {
      admissions++;
      assert.equal(command.streamingBehavior, "followUp");
      if (admissions === 1) throw new Error("test admission unavailable");
      manager.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
    }, destroy() {} };
  globalThis.__piSessions ??= new Map();
  globalThis.__piSessions.set(sid, wrapper);
  t.after(() => {
    globalThis.__piSessions.delete(sid);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.PE_MULTI_USER_MODE; else process.env.PE_MULTI_USER_MODE = oldMode;
    rmSync(root, { recursive: true, force: true });
  });
  const request = (body) => POST(new Request("http://localhost/api/pe/frameworks", { method: "POST", body: JSON.stringify({ datasetId: project.datasetId, ...body }) }));
  const confirm = { action: "confirm", draftId: draft.id, revision: 1, expectedVersionId: null, sessionId: sid, toolCallId: "proposal-call" };
  assert.equal((await request({ ...confirm, toolCallId: "forged" })).status, 409);
  assert.equal(getResearchFramework(project.root, project.datasetId).versions.length, 0);
  const response = await request(confirm);
  assert.equal(response.status, 200);
  const { version } = await response.json();
  assert.equal((await request(confirm)).status, 200);
  assert.equal(listResearchContinuations(project.root, project.datasetId)[0].status, "pending");
  const resume = { action: "continue", versionId: version.id };
  assert.equal((await (await request(resume)).json()).continuation.status, "failed");
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
  const model = { id: "confirmation-test", name: "confirmation-test", provider: "confirmation-test", api: "openai-completions", baseUrl: "https://unused.invalid", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let modelCalls = 0;
  runtime.registerNativeProvider({
    id: model.provider, name: model.name, getModels: () => [model],
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test-only" }, source: "test" }) } },
    stream() { throw new Error("Unexpected network stream"); },
    streamSimple(_model, context) {
      modelCalls++;
      assert.ok(JSON.stringify(context.messages).includes(`[framework-confirmation:${version.id}]`));
      const message = { ...assistant, provider: model.provider, model: model.id, content: [{ type: "text", text: "已收到正式框架，继续核对研究证据。" }], stopReason: "stop" };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
  const services = await createAgentSessionServices({ cwd: project.root, agentDir: join(root, "agent"), modelRuntime: runtime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true } });
  const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [] });
  const realWrapper = new AgentSessionWrapper(inner);
  t.after(() => realWrapper.destroy());
  const ended = new Promise((resolve) => inner.subscribe((event) => { if (event.type === "agent_end") resolve(); }));
  realWrapper.start();
  globalThis.__piSessions.set(sid, realWrapper);
  await Promise.all([request(resume), request(resume)]);
  await ended;
  assert.equal(modelCalls, 1);
  assert.equal(listResearchContinuations(project.root, project.datasetId)[0].status, "delivered");
  globalThis.__piSessions.delete(sid);
  assert.equal((await (await request(resume)).json()).continuation.status, "delivered");
  assert.equal(modelCalls, 1, "persisted message reconciles without dispatching again");
  assert.equal(getResearchFramework(project.root, project.datasetId).versions.length, 1);
});
