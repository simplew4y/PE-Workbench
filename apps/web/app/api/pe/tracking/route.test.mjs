import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { refreshStockTracker, sourceId } from "@earendil-works/pe-boot";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { writeWorkbookFixture } = await jiti.import("../../../../../../packages/pe-boot/test/workbook-source-fixture.ts");

test("tracking API saves independent rules and idempotent simulated trades; isolates projects and rejects invalid revisions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pe-tracking-route-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "Tracking route test" });
  const other = createPeProject({ name: "Other tracking project" });
  const post = (body) => POST(new Request("http://localhost/api/pe/tracking", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: project.datasetId, ...body }),
  }));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(new Date());
  const tracker = {
    name: "=腾讯模拟", code: "0700.HK", currency: "HKD", enabled: false,
    startDate: "2026-01-01", targetDate: "2027-12-31",
    rule: { kind: "fixed", bear: 80, base: 120, bull: 150 },
  };
  const saved = await post({ action: "save", tracker, revision: 0 });
  assert.equal(saved.status, 200);
  const { selected } = await saved.json();
  assert.equal(selected.config.code, "0700.HK");
  assert.equal(selected.config.enabled, false);
  const trade = { requestId: "first-buy", date, kind: "buy", quantity: 100, price: 95, fee: 5 };
  const bought = await post({ action: "trade", trackerId: selected.id, trade });
  assert.equal(bought.status, 200);
  const position = (await bought.json()).selected.position;
  assert.equal(position.quantity, 100);
  assert.equal(position.cost, 9505);
  assert.equal((await post({ action: "trade", trackerId: selected.id, trade })).status, 200);
  const state = await (await GET(new Request(`http://localhost/api/pe/tracking?datasetId=${project.datasetId}`))).json();
  assert.equal(state.selected.trades.length, 1);
  assert.equal(state.workerOnline, false);
  assert.equal(state.run, null);
  assert.deepEqual(state.documents, []);
  const db = new DatabaseSync(join(project.root, "meta/collection.sqlite3"));
  db.prepare("INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('model',?,'model.xlsx','xlsx','completed','2026-01-01','2026-01-01')").run(project.datasetId);
  db.close();
  writeWorkbookFixture(project.root, "model", [{ sheet: "Inputs", cell: "A1", value: 10 }]);
  const estimate = { date, price: 110, basis: { summary: "AI假设：EPS 10 × P/E 11 = 110，非模型原值", evidenceIds: [sourceId({ docId: "model", location: { kind: "excel", sheet: "Inputs", range: "A1" } })] } };
  const retrospective = await post({ action: "save", tracker: { ...tracker, id: selected.id, valuationEstimates: [{ ...estimate, date: "2026-02-01" }] }, revision: selected.revision });
  assert.equal(retrospective.status, 400, "API rejects backdated AI estimates");
  const filled = await post({ action: "save", tracker: { ...tracker, id: selected.id, valuationEstimates: [estimate] }, revision: selected.revision });
  assert.equal(filled.status, 200);
  const filledTracker = (await filled.json()).selected;
  assert.deepEqual(filledTracker.config.valuationEstimates, [{ ...estimate, generatedAt: filledTracker.config.valuationEstimates[0].generatedAt }]);
  assert.deepEqual(filledTracker.pnlAlertThresholds, { profitPercent: 20, lossPercent: 10 });
  const thresholds = { profitPercent: 5, lossPercent: 8 };
  const configured = await post({ action: "save", tracker: { ...filledTracker.config, pnlAlertThresholds: thresholds }, revision: filledTracker.revision });
  assert.equal(configured.status, 200);
  const configuredTracker = (await configured.json()).selected;
  assert.deepEqual(configuredTracker.pnlAlertThresholds, thresholds);
  assert.equal((await post({ action: "save", tracker: { ...configuredTracker.config, pnlAlertThresholds: { profitPercent: 0, lossPercent: 8 } }, revision: configuredTracker.revision })).status, 400);
  await refreshStockTracker(project.root, project.datasetId, selected.id, new AbortController().signal, async () => ({
    fetchedAt: new Date().toISOString(), quote: null, warnings: [],
    bars: [{ date, close: 100, currency: "HKD", evidenceId: "test-price-source" }],
  }));
  const alerted = await (await GET(new Request(`http://localhost/api/pe/tracking?datasetId=${project.datasetId}`))).json();
  assert.equal(alerted.selected.pnlAlert, "profit");
  const download = await GET(new Request(`http://localhost/api/pe/tracking?datasetId=${project.datasetId}&trackerId=${selected.id}&download=csv`));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Type"), /text\/csv/);
  const csv = await download.text();
  assert.ok(csv.includes('"\'=腾讯模拟"'), "spreadsheet formula prefix is escaped");
  assert.ok(csv.includes('"495"'), "exported P&L includes the simulated buy fee");
  assert.match(csv, /AI当日估值/);
  assert.ok(!csv.includes('"2026-02-01"'), "rejected retrospective AI value never enters the export");
  const aiRow = csv.split("\r\n").find((row) => row.includes(`"${date}"`));
  assert.ok(aiRow, "export includes the current analysis-day estimate");
  assert.match(aiRow, /"110","AI假设/);
  assert.ok(aiRow.includes(estimate.basis.evidenceIds[0]));
  assert.equal((await post({ action: "trade", trackerId: selected.id, trade, datasetId: other.datasetId })).status, 404);
  assert.equal((await GET(new Request(`http://localhost/api/pe/tracking?datasetId=${other.datasetId}&trackerId=${selected.id}`))).status, 404);
  assert.equal((await post({ action: "save", tracker: { ...tracker, id: selected.id }, revision: 0 })).status, 409);
  assert.equal((await post({ action: "save", tracker: { ...tracker, rule: { kind: "fixed", bear: 150, base: 120, bull: 80 } }, revision: 0 })).status, 400);
  assert.equal((await post({ action: "save", tracker: { ...tracker, startDate: "2026-02-30" }, revision: 0 })).status, 400);
  assert.equal((await post({ action: "trade", trackerId: selected.id, trade: { ...trade, requestId: "oversell", kind: "sell", quantity: 101 } })).status, 400);
  assert.equal((await post({ action: "refresh", trackerId: "missing" })).status, 404);
  assert.equal((await post({ action: "unknown" })).status, 400);
  assert.equal((await post({ action: "run", model: "invalid" })).status, 400);
  assert.equal((await post({ action: "run", model: { provider: "missing-model" } })).status, 400);
  assert.equal((await post({ action: "run", trackerId: selected.id, datasetId: other.datasetId })).status, 404);
  assert.equal((await POST(new Request("http://localhost/api/pe/tracking", { method: "POST", body: "null" }))).status, 400);
});

test("tracking workbook search uses literal queries and pagination without inferring outputs or dates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pe-tracking-search-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "Tracking workbook source test" });
  const docId = "a".repeat(40);
  const get = (params = {}) => GET(new Request(`http://localhost/api/pe/tracking?${new URLSearchParams({
    datasetId: project.datasetId, docId, ...params,
  })}`));
  // Invalid requests must be rejected before attempting to prepare a document.
  for (const params of [{}, { query: " " }, { dateQuery: "" }, { query: "target", offset: "-1" },
    { query: "target", offset: "1.5" }, { query: "target", dateOffset: "9007199254740992" }, { sheet: "Inputs" }]) {
    assert.equal((await get(params)).status, 400);
  }
  const db = new DatabaseSync(join(project.root, "meta/collection.sqlite3"));
  db.prepare("INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES(?,?,'model.xlsx','xlsx','completed','2026-01-01','2026-01-01')").run(docId, project.datasetId);
  db.close();
  writeWorkbookFixture(project.root, docId, [
    ...Array.from({ length: 11 }, (_, i) => ({ sheet: "Inputs", cell: `A${i + 1}`, value: `目标价 ${i + 1}` })),
    { sheet: "Inputs", cell: "B1", value: 120 },
    { sheet: "Inputs", cell: "A20", value: "估值日期" },
    { sheet: "Inputs", cell: "B20", value: "2026-09-28" },
  ]);
  const response = await get({ query: "目标价", dateQuery: "估值日期" });
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.valuation.status, "search_results");
  assert.equal(first.valuation.matches.length, 10);
  assert.equal(first.valuation.search_complete, false);
  assert.equal(first.valuation.next_offset, 10);
  assert.equal("selected_output" in first.valuation, false);
  assert.equal(first.dates.status, "search_results");
  assert.deepEqual(first.dates.source_cells.map((cell) => cell.cell_ref), ["A20"]);
  assert.equal("valuation_date" in first.dates, false);
  const next = await (await get({ query: "目标价", offset: String(first.valuation.next_offset) })).json();
  assert.equal(next.valuation.matches.length, 1);
  assert.equal(next.valuation.search_complete, true);
  assert.equal(next.dates, null);
  const dateOnly = await (await get({ dateQuery: "估值日期", dateOffset: "1" })).json();
  assert.equal(dateOnly.valuation, null);
  assert.deepEqual(dateOnly.dates.source_cells, []);
  const empty = await (await get({ query: "not in this workbook" })).json();
  assert.deepEqual(empty.valuation.matches, []);
  assert.equal(empty.valuation.status, "search_results");
  assert.equal((await get({ sheet: "Inputs", cell: "B1" })).status, 200);
});
