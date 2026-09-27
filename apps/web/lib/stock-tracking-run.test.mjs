import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getStockTracking, sourceId } from "@earendil-works/pe-boot";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true,
  alias: { "@earendil-works/pe-boot": fileURLToPath(new URL("../../PE-Workbench-pi/packages/pe-boot/src/index.ts", import.meta.url)) },
});
const { createPeProject } = await jiti.import("./pe-project-store.ts");
const { startStockTrackingRun, getStockTrackingRun, stockTrackingCompletionError, stockTrackingRunPrompt } = await jiti.import("./stock-tracking-run.ts");

test("the forecast stage uses Alice Market on fresh Wind data without a separate valuation prerequisite", () => {
  const prompt = stockTrackingRunPrompt({ datasetId: "test", name: "test" }, "tracker");
  assert.match(prompt, /valuation-pricing-framework skill/);
  assert.match(prompt, /category=financials/);
  assert.match(prompt, /get_financial_data MCP/);
  assert.match(prompt, /不能把旧 DCF 数值换上今天日期/);
  assert.match(prompt, /不以单独生成当日估值点为前提/);
  assert.doesNotMatch(prompt, /review:|financialsDate:/);
});

test("completion needs only a current forecast and successful market refresh", () => {
  const today = "2026-09-14";
  const state = { config: { code: "NVDA.O", rule: { kind: "market" } }, valuation: null, valuationStatus: "unavailable", marketError: null };
  assert.match(stockTrackingCompletionError(state, today), /股价预测尚未完成/);
  state.config.forecast = { bear: 110, base: 140, bull: 160, targetDate: "2027-09-14" };
  state.valuationStatus = "expired";
  state.error = "旧模型期限已到期";
  assert.equal(stockTrackingCompletionError(state, today), null);
  state.forecastNeedsUpdate = true;
  assert.match(stockTrackingCompletionError(state, today), /股价预测尚未完成/);
  state.forecastNeedsUpdate = false;
  state.forecastSplitReview = true;
  assert.match(stockTrackingCompletionError(state, today), /股价预测尚未完成/);
  state.forecastSplitReview = false;
  state.config.forecast.targetDate = today;
  assert.match(stockTrackingCompletionError(state, today), /股价预测尚未完成/);
  state.marketError = "Wind timeout";
  assert.equal(stockTrackingCompletionError(state, today), "Wind timeout");
});

for (const rule of [{ kind: "fixed", bear: 80, base: 100, bull: 120 }, { kind: "market" }]) {
test(`${rule.kind}: create and update fetch Wind before prediction; a later model failure keeps refreshed prices`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pe-tracking-run-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE, WIND_API_KEY: process.env.WIND_API_KEY };
  const originalFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  process.env.WIND_API_KEY = "test-only";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    globalThis.__peStockTrackingRuns?.clear();
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "后台追踪测试" });
  const outside = join(root, "outside-secret.txt");
  writeFileSync(outside, "MUST_NOT_READ");
  const db = new DatabaseSync(join(project.root, "meta/collection.sqlite3"));
  db.prepare("INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('model',?,'model.xlsx','xlsx','completed','2026-01-01','2026-01-01')").run(project.datasetId);
  db.prepare("INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,numeric_value,row_label,period,unit) VALUES('cell',?,'model','Valuation','B2',2,2,'number',100,'Target price','2027E','HKD/share')").run(project.datasetId);
  db.close();
  const formatDate = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(date);
  const yesterday = formatDate(new Date(Date.now() - 86400000));
  const config = {
    name: "测试股票", code: "0700.HK", currency: "HKD", enabled: false,
    startDate: formatDate(new Date(Date.now() - 365 * 86400000)), targetDate: formatDate(new Date(Date.now() + 365 * 86400000)), rule,
    basis: { summary: "测试模型；没有目标价时仅追踪行情", evidenceIds: [sourceId({ docId: "model", location: { kind: "excel", sheet: "Valuation", range: "B2" } })] },
  };
  const requests = [];
  let quoteCalls = 0;
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(String(options.body));
    let result = { protocolVersion: "2025-03-26" };
    if (request.method === "tools/call") {
      requests.push({ url, ...request.params });
      if (request.params.name === "get_stock_price_indicators") quoteCalls++;
      const data = request.params.name === "get_stock_price_indicators"
        ? { columns: ["最新交易日", "交易时间", "最新成交价", "Wind代码"], rows: [[yesterday, `${yesterday}T16:00:00+08:00`, 100 + quoteCalls, config.code]], unit: "HKD" }
        : request.params.name === "get_stock_kline"
          ? { columns: ["TIME", "MATCH"], rows: [[`${yesterday}T00:00:00+08:00`, 100 + quoteCalls]], unit: "HKD" }
          : { EPS: 10, unit: "HKD/share", peerPE: [8, 12, 15], scenarioPrices: [80, 120, 150] };
      result = { content: [{ type: "text", text: JSON.stringify({ data, error: null }) }] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  const skillPath = fileURLToPath(new URL("../../PE-Workbench-pi/packages/pe-boot/skills/valuation-pricing-framework/SKILL.md", import.meta.url));
  let setupCalls = 0, forecastCalls = 0, failForecast = false, lastContext;
  const options = {
    initialModel: { provider: "pe-platform", modelId: "tracking-test" },
    platformProvider: {
      api: "stock-tracking-test", baseUrl: "https://unused.invalid", apiKey: "test-only",
      models: [{ id: "tracking-test", name: "Test", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        lastContext = context;
        const workflows = context.messages.filter((message) => JSON.stringify(message.content).includes("PE workflows:"));
        assert.equal(workflows.length, 1, "tracking instructions are preloaded once, including the first model call");
        assert.match(JSON.stringify(workflows[0].content), /第一步：判断公司类型/);
        for (const tool of context.tools ?? []) assert.ok(!["bash", "write", "edit", "pe_dataset_memo", "pe_research_note_save", "pe_investment_framework"].includes(tool.name));
        const predicting = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("这是股票追踪的预测阶段"));
        let action;
        if (!predicting) {
          setupCalls++;
          action = [
            { name: "read", arguments: { path: outside } },
            { name: "pe_stock_tracking", arguments: { operation: "trade", tracker_id: "anything", trade: { requestId: "bad", date: yesterday, kind: "buy", price: 100, quantity: 1 } } },
            { name: "pe_stock_tracking", arguments: { operation: "configure", revision: 0, config } },
          ][setupCalls - 1];
        } else {
          forecastCalls++;
          const state = getStockTracking(project.root, project.datasetId).selected;
          assert.equal(state.quote.price, 100 + quoteCalls, "fresh quote is visible before any prediction call");
          assert.equal(state.observations[0].close, 100 + quoteCalls, "history is already persisted");
          assert.match(context.systemPrompt, /valuation-pricing-framework/);
          const source = context.messages.filter((message) => message.role === "toolResult" && message.toolName === "pe_trusted_source").at(-1);
          action = [
            { name: "read", arguments: { path: skillPath } },
            { name: "pe_trusted_source", arguments: { operation: "fetch", category: "financials", query: "0700.HK 最新披露 EPS 及股本" } },
            { name: "pe_trusted_source", arguments: { operation: "fetch", category: "analytics", query: "0700.HK 同业 PE 区间及 EPS 10 下的情景计算" } },
            ...(!failForecast && source ? [{ name: "pe_stock_tracking", arguments: { operation: "configure", revision: state.revision, config: { ...state.config, forecast: { bear: 80, base: 120, bull: 150, targetDate: config.targetDate, basis: { summary: "Wind EPS 10 × 同业 PE 8/12/15，情景假设", evidenceIds: [JSON.parse(source.content[0].text).evidenceId] } } } } }] : []),
          ][forecastCalls - 1];
        }
        const failed = predicting && failForecast && !action;
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: action ? [{ type: "toolCall", id: `call-${setupCalls}-${forecastCalls}`, ...action }, ...(!predicting && setupCalls === 3 ? [{ type: "toolCall", id: "duplicate-configure", ...action }] : [])] : [],
          stopReason: action ? "toolUse" : failed ? "error" : "stop", ...(failed ? { errorMessage: "测试模型无法生成区间" } : {}) };
        const stream = createAssistantMessageEventStream();
        if (failed) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
        return stream;
      },
    },
  };
  const job = startStockTrackingRun(project, undefined, options);
  assert.equal(startStockTrackingRun(project, undefined, options), job);
  await job.completion;
  assert.equal(job.run.status, "completed", job.run.error);
  const state = getStockTracking(project.root, project.datasetId);
  assert.equal(state.trackers.length, 1);
  assert.deepEqual(state.selected.config.rule, rule);
  assert.equal(state.selected.config.valuationEstimates, undefined);
  assert.equal(state.selected.config.forecast.base, 120);
  assert.ok(state.selected.config.forecast.generatedAt);
  assert.equal(state.selected.trades.length, 0);
  assert.equal(job.run.trackerId, state.selected.id);
  assert.equal(getStockTrackingRun(project.root), job.run);
  const trace = JSON.stringify(lastContext.messages);
  assert.match(trace, /只能读取本项目/);
  assert.match(trace, /不能新增模拟交易/);
  assert.match(trace, /只能更新本次选定的股票/);
  assert.match(trace, /估值与定价框架/);
  assert.doesNotMatch(trace, /MUST_NOT_READ/);
  failForecast = true;
  forecastCalls = 0;
  const update = startStockTrackingRun(project, state.selected.id, options);
  await update.completion;
  assert.equal(update.run.status, "error");
  assert.match(update.run.error, /行情已更新，预测未完成/);
  const refreshed = getStockTracking(project.root, project.datasetId).selected;
  assert.equal(refreshed.quote.price, 102);
  assert.equal(refreshed.observations[0].close, 102);
  assert.deepEqual(refreshed.config.forecast, state.selected.config.forecast);
  assert.equal(setupCalls, 4, "existing trackers skip setup");
  assert.deepEqual(requests.map((request) => request.name), Array(2).fill(["get_stock_price_indicators", "get_stock_kline", "get_stock_fundamentals", "get_financial_data"]).flat());
  assert.ok(!readdirSync(root).includes("sessions"));
  assert.throws(() => startStockTrackingRun(project, state.selected.id, { initialModel: options.initialModel }), /连接当前模型账户/);
});
}
