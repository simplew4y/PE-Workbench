import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as core from "@earendil-works/pe-boot";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { cacheSessionPath } = await jiti.import("../../../../lib/session-reader.ts");
const cardsModule = await jiti.import("../../../../lib/research-cards.ts");
const { cleanResearchSelection } = await jiti.import("../../../../lib/research-selection.ts");
const { frameworkFixture } = await jiti.import("../../../../../../packages/pe-boot/test/fixtures/framework.ts");
const require = createRequire(import.meta.url);

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "pe-cards-route-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE };
  process.env.PI_CODING_AGENT_DIR = root; process.env.PE_MULTI_USER_MODE = "0";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const project = createPeProject({ name: "研究积累" });
  const other = createPeProject({ name: "另一家公司" });
  const manager = SessionManager.create(project.root, join(root, "sessions"));
  const userId = manager.appendMessage({ role: "user", content: "分析需求", timestamp: Date.now() });
  const answer = "需求恢复尚待核实。\n\n需要核查原始财报 [财报](#pe-source?evidence_id=page%3Amissing)。";
  const entryId = manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(), content: [{ type: "text", text: answer }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  cacheSessionPath(manager.getSessionId(), manager.getSessionFile());
  const request = (body) => POST(new Request("http://localhost/api/pe/research-cards", { method: "POST", body: JSON.stringify({ datasetId: project.datasetId, ...body }) }));
  const source = { sessionId: manager.getSessionId(), entryId, excerpt: "需求恢复尚待核实。" };
  const create = { action: "create", kind: "note", title: "需求恢复", requestId: "save", source };
  return { root, project, other, manager, userId, source, create, request };
}

test("saves verified assistant excerpts, rejects forged/cross-project origins, persists and edits safely", async (t) => {
  const { project, other, source, userId, create, request } = setup(t);
  assert.equal((await request({ ...create, source: { ...source, excerpt: "伪造的结论" } })).status, 400);
  assert.equal((await request({ ...create, source: { ...source, entryId: userId } })).status, 404);
  assert.equal((await request({ ...create, datasetId: other.datasetId })).status, 404);
  const response = await request({ ...create, evidenceIds: ["page:forged"], content: "伪造内容" });
  assert.equal(response.status, 201);
  const { card } = await response.json();
  assert.equal(card.content, source.excerpt);
  assert.deepEqual(card.evidenceIds, ["page:missing"]);
  assert.equal(card.evidence[0].available, false);
  assert.equal((await (await request(create)).json()).card.id, card.id);
  assert.equal((await GET(new Request(`http://localhost/api/pe/research-cards?datasetId=${project.datasetId}`))).status, 200);
  assert.equal((await request({ action: "update", ...card, revision: 1, status: "confirmed", datasetId: other.datasetId })).status, 404);
  const confirmed = await request({ ...card, action: "update", status: "confirmed" });
  assert.equal(confirmed.status, 200);
  const confirmedCard = (await confirmed.json()).card;
  const history = await GET(new Request(`http://localhost/api/pe/research-cards?datasetId=${project.datasetId}&id=${card.id}`));
  assert.deepEqual((await history.json()).revisions.map((entry) => entry.revision), [2, 1]);
  const restored = await request({ action: "restore", id: card.id, revision: confirmedCard.revision, targetRevision: 1 });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).card.status, "unverified");
  assert.equal((await request({ action: "restore", id: card.id, revision: confirmedCard.revision, targetRevision: 1 })).status, 409);
  assert.equal((await request({ ...card, action: "update", status: "confirmed" })).status, 409);
  const question = await request({ action: "create", kind: "question", requestId: "question", title: "现金流是否改善？", content: "查新财报", relatedCardIds: [card.id] });
  assert.equal(question.status, 201);
  assert.deepEqual((await question.json()).card.evidenceIds, ["page:missing"]);
  assert.equal((await POST(new Request("http://localhost", { method: "POST", body: "null" }))).status, 400);
});

test("rendered selections preserve only the excerpt across emphasis, links, lists and tables", async (t) => {
  const { manager, source, create, request } = setup(t);
  const answer = "前言不应保存。\n\n海外**收入增长**仍需核对[现金流](#pe-source?evidence_id=page%3Amissing)。\n\n另一项判断关联[另一资料](#pe-source?evidence_id=page%3Aother)。\n\n- 销量增加\n- 利润待核实\n\n| 指标 | 变化 |\n| --- | --- |\n| 营收 | 上升 |\n\n结尾也不应保存。";
  const entryId = manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(), content: [{ type: "text", text: answer }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  assert.equal(cleanResearchSelection("海外收入增长仍需核对查看原始证据：现金流。", ["查看原始证据：现金流"]), "海外收入增长仍需核对。");
  const selections = [
    { excerpt: "海外收入增长仍需核对。", evidenceIds: ["page:missing"] },
    { excerpt: "销量增加\n利润待核实", evidenceIds: [] },
    { excerpt: "指标\t变化\n营收\t上升", evidenceIds: [] },
  ];
  for (const [index, selection] of selections.entries()) {
    const response = await request({ ...create, requestId: "selection-" + index, source: { ...source, entryId, ...selection, format: "rendered" } });
    assert.equal(response.status, 201, await response.clone().text());
    const { card } = await response.json();
    assert.equal(card.content, selection.excerpt);
    assert.equal(card.origin.excerpt, selection.excerpt);
    assert.doesNotMatch(card.content, /前言|结尾/);
    assert.deepEqual(card.evidenceIds, selection.evidenceIds);
  }
  assert.equal((await request({ ...create, requestId: "forged-evidence", source: { ...source, entryId, excerpt: selections[0].excerpt, evidenceIds: ["page:forged"], format: "rendered" } })).status, 400);
  for (const excerpt of ["", "收入增长已证实", "销量增加 结尾也不应保存。", undefined]) {
    assert.equal((await request({ ...create, source: { ...source, entryId, excerpt, format: "rendered" } })).status, 400);
  }
});

test("framework excerpts are verified against the saved tool document even with a failed or absent final reply", async (t) => {
  const { manager, project, source, create, request } = setup(t);
  for (const textOnly of [false, true]) {
    const callId = textOnly ? "historic-framework" : "saved-framework";
    const document = frameworkFixture();
    const excerpt = document.sections.businessModel.drivers[0].mechanism;
    const entryId = manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(),
      content: [{ type: "toolCall", id: callId, name: "pe_investment_framework", arguments: { operation: "propose" } }], stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const details = { kind: "pe_framework_draft", datasetId: project.datasetId, draft: { id: "draft", revision: 1, content: document } };
    manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "pe_investment_framework", timestamp: Date.now(), isError: false,
      content: [{ type: "text", text: textOnly ? JSON.stringify(details) : "框架已保存，请用户确认。" }], details: textOnly ? undefined : details });
    const response = await request({ ...create, requestId: callId, source: { ...source, entryId, excerpt, format: "rendered" } });
    assert.equal(response.status, 201, await response.clone().text());
    const { card } = await response.json();
    assert.equal(card.content, excerpt);
    assert.equal(card.origin.entryId, entryId);
    assert.equal((await request({ ...create, requestId: `${callId}-forged`, source: { ...source, entryId, excerpt: "编造的框架结论", format: "rendered" } })).status, 400);
  }
});

test("failed and unrelated framework results cannot authorize research excerpts", async (t) => {
  const { manager, project, source, create, request } = setup(t);
  const document = frameworkFixture();
  const excerpt = document.sections.businessModel.drivers[0].mechanism;
  const entryId = manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: Date.now(),
    content: [{ type: "toolCall", id: "failed-call", name: "pe_investment_framework", arguments: { operation: "propose" } }], stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const details = { kind: "pe_framework_draft", datasetId: project.datasetId, draft: { id: "draft", revision: 1, content: document } };
  manager.appendMessage({ role: "toolResult", toolCallId: "failed-call", toolName: "pe_investment_framework", timestamp: Date.now(), isError: true, content: [], details });
  assert.equal((await request({ ...create, requestId: "failed-source", source: { ...source, entryId, excerpt } })).status, 400);
  manager.appendMessage({ role: "toolResult", toolCallId: "other-call", toolName: "pe_investment_framework", timestamp: Date.now(), isError: false, content: [], details });
  assert.equal((await request({ ...create, requestId: "unrelated-source", source: { ...source, entryId, excerpt } })).status, 400);
  manager.branch(source.entryId);
  manager.appendMessage({ role: "toolResult", toolCallId: "failed-call", toolName: "pe_investment_framework", timestamp: Date.now(), isError: false, content: [], details });
  assert.equal((await request({ ...create, requestId: "other-branch-source", source: { ...source, entryId, excerpt } })).status, 400);
});

test("new-session route sends only selected saved revisions, validates before starting the agent", async (t) => {
  const { project, other, create, request } = setup(t);
  const { card } = await (await request(create)).json();
  let starts = 0;
  const sent = [];
  const sessionB = SessionManager.create(project.root, join(project.root, "test-sessions"));
  const compiled = ts.transpileModule(readFileSync(new URL("../../agent/new/route.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  class GatewayError extends Error {}
  const modules = {
    "@earendil-works/pe-boot": core,
    "@/lib/research-cards": cardsModule,
    "@/lib/file-access": { allowFileRoot() {} },
    "@/lib/session-reader": { invalidateSessionListCache() {} },
    "@/lib/pe-platform-runtime": { getPePlatformRpcOptions: async () => ({}) },
    "@/lib/pe-agent-authorization": { authorizePeAgentCommand: async () => {} },
    "@/lib/pe-gateway/model-service": { PeModelServiceError: GatewayError },
    "@/lib/pe-gateway/backend-client": { PeBackendError: GatewayError },
    "@/lib/rpc-manager": { startRpcSession: async () => { starts++; return { realSessionId: sessionB.getSessionId(), session: { send: async (command) => {
      if (command.type === "get_state") return {};
      sent.push(command);
      sessionB.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
      return {};
    } } }; } },
  };
  runInNewContext(compiled, { exports, require: (id) => modules[id] ?? require(id) });
  const selection = [{ id: card.id, revision: card.revision }];
  const run = (body) => exports.POST(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ cwd: project.root, type: "prompt", message: "继续核查现金流", researchContext: { datasetId: project.datasetId, selection }, ...body }) }));
  assert.equal((await run({ cwd: other.root })).status, 403);
  assert.equal(starts, 0);
  assert.equal((await run({ researchContext: { datasetId: project.datasetId, selection: [{ id: card.id, revision: 99 }] } })).status, 409);
  assert.equal(starts, 0);
  const response = await run({});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, sessionB.getSessionId());
  assert.equal(starts, 1);
  assert.match(sent[0].message, /需求恢复尚待核实/);
  assert.match(sent[0].message, /状态：待核实/);
  assert.match(sent[0].message, /原始资料/);
  assert.equal(sent[0].researchContext, undefined);
  assert.equal(sessionB.getBranch().filter((entry) => entry.type === "message")[0].message.content, sent[0].message);
  await request({ ...card, action: "update", content: "后来修订的判断", status: "unverified" });
  assert.doesNotMatch(sent[0].message, /后来修订/);
});
