import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { initializePeCollectionDatabase, listPeConsensusCards } from "@earendil-works/pe-boot";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runPeClaimAnalysis } = await jiti.import("./analysis.ts");

test("analysis resolves its default Python without an interpreter override", async (t) => {
  const options = fixture(t);
  await server(t, responseFor);
  environment(t, { PE_INGEST_ANALYSIS_PYTHON: undefined, PE_EXCEL_PYTHON: undefined });
  const result = await runPeClaimAnalysis(options);
  assert.equal(result.status, "completed");
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pe-analysis-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "meta"));
  mkdirSync(path.join(root, "raw"));
  mkdirSync(path.join(root, "generated"));
  const database = path.join(root, "meta", "collection.sqlite3");
  initializePeCollectionDatabase(database);
  const db = new DatabaseSync(database);
  db.prepare("INSERT INTO project_metadata VALUES(1,'dataset','Example','now','now')").run();
  db.prepare(`INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,raw_path,sha256,status,
    file_type,page_count,created_at,updated_at) VALUES('one','dataset','HTSC.pdf','htsc.pdf','raw/HTSC.pdf','hash',
    'completed','pdf',1,'now','now')`).run();
  db.prepare(`INSERT INTO pdf_pages VALUES('p1','one',1,?,'HTSC.pdf p.1','body','{}','passed','{}',595,842,0,'[]',0,0,0)`)
    .run("2026年收入预计100亿元，订单增长带动。");
  db.close();
  return { root, collectionPath: database, datasetId: "dataset", docIds: ["one"], ingestedAt: "2026-09-07T00:00:00Z" };
}

function environment(t, values) {
  const old = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function server(t, respond) {
  const http = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const payload = JSON.parse(raw);
    const result = await respond(payload);
    if (!result || response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => { http.closeAllConnections(); http.close(); });
  environment(t, {
    PE_CONSENSUS_ENABLED: "1",
    PE_INGEST_LLM_BASE_URL: `http://127.0.0.1:${http.address().port}/v1`,
    PE_INGEST_LLM_API_KEY: "test-not-a-secret",
    PE_INGEST_LLM_MODEL: "fake",
    PE_INGEST_ANALYSIS_DISABLED: "0",
    PE_INGEST_ANALYSIS_PYTHON: process.platform === "win32" ? "python" : "python3",
    PE_INGEST_LLM_MAX_ATTEMPTS: "1",
    PE_INGEST_ANALYSIS_TIMEOUT_SECONDS: "15",
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  });
}

function responseFor(payload) {
  const system = payload.messages[0].content;
  if (system.includes("维护一份")) return { decisions: [] };
  if (system.includes("卡片")) return { cards: [] };
  return {
    document: { issuer_name: "华泰证券", issuer_kind: "sell_side", issuer_confidence: 0.95, published_date: "2026-09-01" },
    proposed_items: [],
    claims: [{
      item_key: "revenue", claim_text: "2026年收入预计100亿元", reason: "订单增长",
      stance: "bullish", measure: "level", value_numeric: 100, unit: "亿元", period: "2026年", confidence: 0.95,
      evidence_ids: ["page:p1"], evidence_quotes: [{ evidence_id: "page:p1", quote: "2026年收入预计100亿元，订单增长带动。" }],
    }],
  };
}

test("analysis worker, shared card reader and source citations use one complete snapshot", async (t) => {
  const options = fixture(t);
  await server(t, responseFor);
  const events = [];
  const result = await runPeClaimAnalysis({ ...options, onProgress: (event) => events.push(event) });
  assert.equal(result.status, "completed");
  assert.ok(events.some((event) => event.stage === "consensus"));
  const cards = listPeConsensusCards(options.root, { includeSources: true });
  assert.equal(cards.stale, false, "Python and TypeScript fingerprints agree");
  assert.equal(cards.coverage.complete, true);
  assert.equal(cards.cards[0].stats.median, 100e8);
  assert.equal(cards.cards[0].stats.iqr, 0);
  assert.equal(cards.cards[0].stats.mad, 0);
  assert.equal(cards.cards[0].stats.sample.included_count, 1);
  assert.deepEqual(cards.cards[0].stats.sample.claim_ids, [cards.cards[0].sources[0].claim_id]);
  assert.deepEqual(cards.cards[0].stats.sample.stance_ratios, { bullish: 1, bearish: 0, neutral: 0 });
  assert.match(cards.cards[0].sources[0].citations[0], /HTSC.pdf p.1.*page%3Ap1/u);
  assert.match(cards.cards[0].sources[0].quotes[0].quote, /100亿元/u);
  const db = new DatabaseSync(options.collectionPath);
  db.prepare("UPDATE pdf_pages SET page_text=page_text || ' new text'").run();
  db.close();
  assert.equal(listPeConsensusCards(options.root).stale, true);
});

test("concurrent requests share a project lock and do not scan the same pages twice", async (t) => {
  const options = fixture(t);
  let scans = 0;
  await server(t, (payload) => {
    if (payload.messages[0].content.includes("原子观点")) scans++;
    return responseFor(payload);
  });
  const results = await Promise.all([runPeClaimAnalysis(options), runPeClaimAnalysis(options)]);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.equal(scans, 1);
});

test("default-off analysis returns before accessing a database, Python, or a model", async (t) => {
  environment(t, { PE_CONSENSUS_ENABLED: undefined, PE_INGEST_ANALYSIS_DISABLED: "0",
    PE_INGEST_ANALYSIS_PYTHON: "nonexistent-python", PE_INGEST_LLM_BASE_URL: "http://127.0.0.1:1/v1",
    PE_INGEST_LLM_API_KEY: "test-not-a-secret" });
  assert.deepEqual(await runPeClaimAnalysis({
    collectionPath: path.join(tmpdir(), "nonexistent-consensus-project", "collection.sqlite3"),
    datasetId: "unused", docIds: [],
  }), { status: "skipped_disabled", errors: [] });
});

test("unconfigured and disabled analysis does not require an installed Python", async (t) => {
  const options = fixture(t);
  environment(t, { PE_CONSENSUS_ENABLED: "1", PE_INGEST_ANALYSIS_PYTHON: "nonexistent-python",
    PE_INGEST_LLM_API_KEY: undefined, PE_INGEST_ANALYSIS_DISABLED: "0" });
  assert.equal((await runPeClaimAnalysis(options)).status, "skipped_no_model");
  process.env.PE_INGEST_ANALYSIS_DISABLED = "1";
  assert.equal((await runPeClaimAnalysis(options)).status, "skipped_disabled");
});

test("total timeout terminates the worker, releases its lock and preserves ingested pages", async (t) => {
  const options = fixture(t);
  await server(t, () => null);
  process.env.PE_INGEST_ANALYSIS_TIMEOUT_SECONDS = "0.5";
  await assert.rejects(runPeClaimAnalysis(options), /timeout|aborted/iu);
  const db = new DatabaseSync(options.collectionPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pdf_pages").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM pe_analysis_metadata").get().status, "failed");
  db.close();
  process.env.PE_INGEST_ANALYSIS_DISABLED = "1";
  assert.equal((await runPeClaimAnalysis(options)).status, "skipped_disabled");
});

test("cancellation and spawn failure settle instead of leaving a pending task", async (t) => {
  const options = fixture(t);
  await server(t, () => null);
  const controller = new AbortController();
  await assert.rejects(runPeClaimAnalysis({
    ...options, signal: controller.signal,
    onProgress: () => controller.abort(new Error("cancelled by test")),
  }), /cancelled/u);
  process.env.PE_INGEST_ANALYSIS_PYTHON = "nonexistent-python";
  await assert.rejects(runPeClaimAnalysis(options), /ENOENT/u);
});

test("analysis exits when the parent's lifetime pipe closes, including during HTTP", { timeout: 10_000 }, async (t) => {
  const options = fixture(t);
  await server(t, () => null);
  const script = path.resolve("services/pe-analysis/analyze_collection.py");
  const child = spawn(process.env.PE_INGEST_ANALYSIS_PYTHON, ["-u", script,
    "--collection-path", options.collectionPath, "--dataset-id", options.datasetId, "--parent-stdio"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close");
  await once(child.stderr, "data");
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 125);
  const db = new DatabaseSync(options.collectionPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pdf_pages").get().n, 1);
  db.close();
});

test("card reader reports empty state, rejects wrong datasets, and resolves only existing source pages", async (t) => {
  const options = fixture(t);
  assert.equal(listPeConsensusCards(options.root).empty_reason, "not_analyzed");
  assert.throws(() => listPeConsensusCards(options.root, { datasetId: "another-project" }), /dataset/iu);
  await server(t, responseFor);
  await runPeClaimAnalysis(options);
  assert.equal(listPeConsensusCards(options.root, { itemKey: "nonexistent" }).card_count, 0);
  assert.equal(listPeConsensusCards(options.root, { cardTypes: ["single_view"], limit: 1 }).card_count, 1);
  assert.deepEqual(listPeConsensusCards(options.root).cards[0].sources, []);
  const db = new DatabaseSync(options.collectionPath);
  db.prepare("UPDATE documents SET deleted_at='now',lifecycle_state='removed',is_current=0").run();
  let result = listPeConsensusCards(options.root, { includeSources: true });
  assert.equal(result.stale, true);
  assert.deepEqual(result.cards[0].sources[0].citations, []);
  assert.deepEqual(result.cards[0].sources[0].unresolved_evidence_ids, ["page:p1"]);
  db.prepare("UPDATE pe_analysis_metadata SET schema_version=999").run();
  assert.throws(() => listPeConsensusCards(options.root), /schema version/u);
  db.close();
});
