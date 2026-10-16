import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createResearchDraft, getResearchFramework, getResearchMonitor, initializePeCollectionDatabase, migrateFrameworkScriptMonitor, publishResearchDraft, registerPeDocuments, renderInvestmentFrameworkMarkdown, requestResearchMonitorRun, runResearchMonitor, saveResearchMonitor } from "@earendil-works/pe-boot";
import { frameworkFixture } from "../../../../packages/pe-boot/test/fixtures/framework.ts";
import { createFrameworkPipelineEngine, frameworkPipelineStatus } from "./framework-pipeline.mjs";
import { loadProjectMaterials, runProjectPipeline, validatePlan } from "../../../../test_script/hermes_framework_pipeline.mjs";
import { readSelectedExcel } from "../../../../test_script/framework_excel_selection.mjs";

const datasetId = "dataset_pipeline";
const config = { pipeline: "script", runtime: "server", modelId: "deepseek-test", updatePolicy: "direct", company: { name: "测试银行", ticker: "600000.SH" }, enabled: false, mode: "auto", intervalHours: 168, objective: "更新投资框架", queries: [], includeMemos: false };
function setup(context, enabled = false) {
  const cwd = mkdtempSync(join(tmpdir(), "framework-script-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "meta"));
  mkdirSync(join(cwd, "raw"));
  initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "测试银行" });
  const draft = createResearchDraft(cwd, datasetId, frameworkFixture(), [], null);
  publishResearchDraft(cwd, datasetId, { draftId: draft.id, revision: 1, expectedVersionId: null, requestId: "initial" });
  saveResearchMonitor(cwd, datasetId, { ...config, enabled }, 0);
  return cwd;
}
const narrative = () => "# 测试银行新版投资框架\n\n收入改善仍需现金流验证。\n\n自由生成的分析与判断。";
const response = value => ({ choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] });
function engine(cwd, complete) {
  return createFrameworkPipelineEngine(cwd, datasetId, config, { complete, windFetcher: async () => ({ content: [{ type: "text", text: "测试银行财报" }] }), env: { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-test" } });
}

test("manual and timed updates run the same two-call script, publish prose and preserve prior versions", async context => {
  const cwd = setup(context);
  const calls = [];
  const generator = engine(cwd, async (stage, messages) => {
    calls.push(stage);
    const { materials } = JSON.parse(messages[1].content);
    assert.equal(materials.company, "测试银行");
    assert.equal(materials.ticker, "600000.SH");
    assert.equal(materials.baseline.project, realpathSync(cwd));
    return response(stage === "plan" ? { queries: [{ category: "financials", query: "测试银行收入" }] } : `${narrative()}\n\n第${calls.length / 2}轮`);
  });
  requestResearchMonitorRun(cwd, datasetId);
  requestResearchMonitorRun(cwd, datasetId);
  assert.equal(await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal), true);
  assert.equal(getResearchMonitor(cwd, datasetId).runs[0].status, "published", getResearchMonitor(cwd, datasetId).runs[0].error);
  let state = getResearchFramework(cwd, datasetId);
  assert.equal(state.versions.length, 2);
  assert.equal(renderInvestmentFrameworkMarkdown(state.versions[0].content), `${narrative()}\n\n第1轮`);
  assert.equal(getResearchMonitor(cwd, datasetId).config.enabled, false);
  assert.equal(getResearchMonitor(cwd, datasetId).runs[0].status, "published");
  assert.equal(getResearchMonitor(cwd, datasetId).manualRequested, false);
  assert.equal(await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal), false);
  saveResearchMonitor(cwd, datasetId, { ...config, enabled: true }, 1);
  assert.equal(await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal), true);
  state = getResearchFramework(cwd, datasetId);
  assert.equal(state.versions.length, 3);
  assert.equal(renderInvestmentFrameworkMarkdown(state.versions[0].content), `${narrative()}\n\n第2轮`);
  assert.deepEqual(calls, ["plan", "revision", "plan", "revision"]);
  const monitor = getResearchMonitor(cwd, datasetId);
  assert.ok(monitor.nextRunAt > Date.now() + 167 * 3600_000);
  assert.equal(await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal), false);
});

test("a failed script records failure, keeps the current framework and can be retried manually", async context => {
  const cwd = setup(context);
  const before = getResearchFramework(cwd, datasetId).currentVersionId;
  const generator = engine(cwd, async () => { throw new Error("provider unavailable"); });
  requestResearchMonitorRun(cwd, datasetId);
  await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal);
  assert.equal(getResearchFramework(cwd, datasetId).currentVersionId, before);
  assert.equal(getResearchMonitor(cwd, datasetId).runs[0].status, "failed");
  assert.match(getResearchMonitor(cwd, datasetId).runs[0].error, /provider unavailable/);
  requestResearchMonitorRun(cwd, datasetId);
  assert.equal(getResearchMonitor(cwd, datasetId).manualRequested, true);
});

test("pausing a scheduled run during generation prevents late publication", async context => {
  const cwd = setup(context, true);
  const before = getResearchFramework(cwd, datasetId).currentVersionId;
  const generator = engine(cwd, async stage => {
    if (stage === "revision") saveResearchMonitor(cwd, datasetId, config, 1);
    return response(stage === "plan" ? { queries: [{ category: "financials", query: "测试银行收入" }] } : narrative());
  });
  await runResearchMonitor(cwd, datasetId, generator, new AbortController().signal);
  assert.equal(getResearchFramework(cwd, datasetId).currentVersionId, before);
  assert.equal(getResearchMonitor(cwd, datasetId).runs[0].status, "failed");
  assert.match(getResearchMonitor(cwd, datasetId).runs[0].error, /paused|changed/i);
});

test("pipeline availability uses the same DeepSeek environment as the script and never exposes secrets", () => {
  const status = frameworkPipelineStatus({ DEEPSEEK_API_KEY: "do-not-expose", DEEPSEEK_MODEL: "deepseek-v4-flash" });
  assert.equal(status.available, true);
  assert.equal(status.modelId, "deepseek-v4-flash");
  assert.doesNotMatch(JSON.stringify(status), /do-not-expose/);
  assert.equal(frameworkPipelineStatus({}).available, false);
});

test("project inputs include only current parsed documents and enforce project boundaries", async context => {
  const cwd = setup(context);
  mkdirSync(join(cwd, "generated"));
  writeFileSync(join(cwd, "generated", "report.txt"), "公司最新季度报告");
  const db = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
  try {
    for (const [id, status, current, deleted] of [["current", "completed", 1, null], ["old", "completed", 0, null], ["parsing", "running", 1, null], ["deleted", "completed", 1, "today"]]) {
      db.prepare(`INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,is_current,deleted_at,readable_text_path,created_at,updated_at)
        VALUES(?,?,?,?,?,'pdf',?,?,?,'generated/report.txt','before','before')`).run(id, datasetId, `${id}.pdf`, `${id}.pdf`, id, status, current, deleted);
    }
    const input = await loadProjectMaterials({ project: cwd, datasetId, company: "测试银行", ticker: "600000.SH" });
    assert.deepEqual(input.documents.map(doc => doc.id), ["current"]);
    assert.equal(input.documents[0].content, "公司最新季度报告");
    await assert.rejects(loadProjectMaterials({ project: cwd, datasetId: "another-project" }), /does not match/);
    db.prepare("UPDATE documents SET readable_text_path=? WHERE doc_id='current'").run(tmpdir());
    await assert.rejects(loadProjectMaterials({ project: cwd, datasetId }), /超出当前空间/);
  } finally { db.close(); }
});

test("worker migrates existing automatic plans without changing their timer; review plans stay separate", context => {
  const cwd = setup(context);
  saveResearchMonitor(cwd, datasetId, { ...config, enabled: true, pipeline: "iteration", automaticSetup: true }, 1);
  const db = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
  const next = Date.now() + 5 * 3600_000;
  try { db.prepare("UPDATE research_monitor_plans SET next_run_at=?").run(next); }
  finally { db.close(); }
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("./worker.mjs", import.meta.url).pathname, "--cwd", cwd, "--dataset", datasetId, "--monitor", "--once"], {
    timeout: 15_000, env: { ...process.env, DEEPSEEK_API_KEY: "test-only", DEEPSEEK_MODEL: "deepseek-test", DEEPSEEK_BASE_URL: "https://example.invalid" },
  });
  let state = getResearchMonitor(cwd, datasetId);
  assert.equal(state.config.pipeline, "script");
  assert.equal(state.config.enabled, true);
  assert.equal(state.nextRunAt, next);
  const revision = state.revision;
  migrateFrameworkScriptMonitor(cwd, datasetId);
  assert.equal(getResearchMonitor(cwd, datasetId).revision, revision);
  saveResearchMonitor(cwd, datasetId, { ...config, pipeline: "iteration", mode: "review", updatePolicy: undefined, company: undefined }, revision);
  migrateFrameworkScriptMonitor(cwd, datasetId);
  state = getResearchMonitor(cwd, datasetId);
  assert.equal(state.config.pipeline, "iteration");
  assert.equal(state.config.mode, "review");
});

test("planning sees only workbook navigation, and revision sees only the selected key cells in two LLM calls", async context => {
  const cwd = setup(context);
  const bytes = readFileSync(new URL("../../../../packages/pe-boot/test/fixtures/excel-parity.xlsx", import.meta.url));
  const [doc] = registerPeDocuments(cwd, datasetId, [{ name: "model.xlsx", bytes }]).documents;
  const db = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
  try { db.prepare("UPDATE documents SET status='completed',readable_text_path='generated/navigation-only.txt' WHERE doc_id=?").run(doc.doc_id); }
  finally { db.close(); }
  const input = await loadProjectMaterials({ project: cwd, datasetId });
  const workbook = input.documents.find(document => document.id === doc.doc_id);
  assert.equal(workbook.content, undefined, "never extract the full workbook before planning");
  assert.ok(workbook.workbook.sheets.some(sheet => sheet.name === "DCF"));
  assert.ok(JSON.stringify(input).length < 30_000);
  const calls = [];
  await runProjectPipeline({ materials: input, output: join(cwd, "generated", "key-cells"), env: { DEEPSEEK_API_KEY: "test", DEEPSEEK_MODEL: "deepseek-test" },
    windFetcher: async () => ({ content: [{ type: "text", text: "财报" }] }),
    complete: async (stage, messages) => {
      calls.push(stage);
      const payload = JSON.parse(messages[1].content);
      assert.ok(JSON.stringify(payload).length < 35_000);
      assert.doesNotMatch(JSON.stringify(payload), /Long original note/);
      if (stage === "revision") {
        const cells = payload.excel.flatMap(receipt => receipt.cells);
        assert.ok(cells.some(cell => cell.sheet === "DCF" && cell.cell === "B2" && cell.numericValue === 100));
        assert.ok(cells.length <= 200);
        assert.ok(cells.every(cell => ["A2", "B2", "A3", "B3"].includes(cell.cell)));
      }
      return response(stage === "plan" ? { questions: ["核心盈利假设是否改变"], queries: [{ category: "financials", query: "测试银行收入" }],
        excelReads: [{ docId: doc.doc_id, sheet: "DCF", range: "A2:B3", purpose: "核对框架中的核心假设" }] } : narrative());
    },
  });
  assert.deepEqual(calls, ["plan", "revision"]);
});

test("Excel plan rejects whole-sheet or excessive reads before accessing cells", () => {
  const plan = { queries: [{ category: "financials", query: "收入" }] };
  assert.throws(() => validatePlan({ ...plan, excelReads: [{ docId: "model", sheet: "DCF", range: "A1:XFD1048576", purpose: "全部读取" }] }), /200/);
  assert.throws(() => validatePlan({ ...plan, excelReads: Array.from({ length: 9 }, () => ({ docId: "model", sheet: "DCF", range: "B2", purpose: "假设" })) }), /8/);
});

test("metric lookup reads only nearby key values and records unlocated periods without guessing", async context => {
  const cwd = setup(context);
  const bytes = readFileSync(new URL("../../../../packages/pe-boot/test/fixtures/excel-parity.xlsx", import.meta.url));
  const [doc] = registerPeDocuments(cwd, datasetId, [{ name: "model.xlsx", bytes }]).documents;
  const db = new DatabaseSync(join(cwd, "meta/collection.sqlite3"));
  try { db.prepare("UPDATE documents SET status='completed' WHERE doc_id=?").run(doc.doc_id); }
  finally { db.close(); }
  const input = await loadProjectMaterials({ project: cwd, datasetId });
  const receipts = await readSelectedExcel(input, [
    { docId: doc.doc_id, sheet: "Valuation", query: "Current Price", purpose: "核对价格假设" },
    { docId: doc.doc_id, sheet: "Valuation", query: "Revenue", periods: ["2099E"], purpose: "核对远期收入" },
    { docId: "outside-project", sheet: "DCF", range: "B2", purpose: "越界请求" },
    { docId: doc.doc_id, sheet: "Date cases", query: "Valuation date", periods: ["2026"], purpose: "核对期间歧义" },
  ], new AbortController().signal);
  assert.ok(receipts[0].cells.some(cell => cell.cell === "B6" && cell.numericValue === 100));
  assert.ok(receipts[1].gaps.some(gap => gap.includes("2099E")));
  assert.ok(receipts[1].cells.every(cell => cell.numericValue === null));
  assert.equal(receipts[2].status, "failed");
  assert.equal(receipts[2].cells.length, 0);
  assert.ok(receipts[3].gaps.some(gap => gap.includes("2026有多个期间匹配")));
  assert.ok(receipts.every(receipt => receipt.cells.length <= 25));
});
