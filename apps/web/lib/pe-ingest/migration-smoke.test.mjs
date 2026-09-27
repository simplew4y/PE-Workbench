import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { listPePdfDocuments, searchPePdfPages, readPePdfPages, listPeConsensusCards } from "@earendil-works/pe-boot";
import { resolvePeEvidenceSource } from "@earendil-works/pe-boot/evidence";
import { sourceId } from "@earendil-works/pe-boot/source";
import { workbookBytes } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { queuePePdfIngest, resolvePeProjectPaths } = await jiti.import("./index.ts");
const { readPeIngestJob } = await jiti.import("./jobs.ts");
const { createPeProject, peProjectStorePaths } = await jiti.import("../pe-project-store.ts");

test("real copied PDF and workbook pass the compiled upload worker and retrieval without a paid model", {
  skip: !process.env.PE_MIGRATION_SMOKE_PDF,
  timeout: 180_000,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pe-migration-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "Migration smoke" }, store);
  const registryPath = peProjectStorePaths(store).registryPath;
  const paths = resolvePeProjectPaths(project, registryPath);
  const original = readFileSync(process.env.PE_MIGRATION_SMOKE_PDF);
  const hash = createHash("sha256").update(original).digest("hex");
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    requests++;
    assert.equal(payload.model, "local-smoke-fake");
    const system = payload.messages[0].content;
    let content = system.includes("卡片") ? { cards: [] } : { decisions: [] };
    if (system.includes("原子观点")) {
      const match = payload.messages[1].content.match(/\[(page:[^\]]+)\][^\n]*\n([^\[]+)/u);
      const quote = match?.[2].split("\n").find((line) => line.trim().length >= 10)?.trim().slice(0, 100);
      content = {
        document: { issuer_name: "华泰证券", issuer_kind: "sell_side", issuer_confidence: 0.95 },
        proposed_items: [],
        claims: quote ? [{ item_key: "industry_demand", claim_text: "仅用于验证链路的测试观点", stance: "neutral",
          evidence_ids: [match[1]], evidence_quotes: [{ evidence_id: match[1], quote }], confidence: 0.9 }] : [],
      };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const variables = {
    PE_CONSENSUS_ENABLED: "1",
    PE_INGEST_ANALYSIS_DISABLED: "0", PE_INGEST_LLM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    PE_INGEST_LLM_API_KEY: "smoke-not-a-secret", PE_INGEST_LLM_MODEL: "local-smoke-fake",
    PE_INGEST_ANALYSIS_PYTHON: process.platform === "win32" ? "python" : "python3",
    PE_INGEST_LLM_MAX_ATTEMPTS: "1", PE_INGEST_ANALYSIS_TIMEOUT_SECONDS: "60",
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  };
  const old = new Map(Object.keys(variables).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of old) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const job = queuePePdfIngest({ project, registryPath, uploads: [
    { filename: path.basename(process.env.PE_MIGRATION_SMOKE_PDF), mimeType: "application/pdf", content: original },
    { filename: "Smoke model.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: workbookBytes(100) },
  ] });
  const deadline = Date.now() + 150_000;
  let finished;
  do {
    finished = readPeIngestJob(paths, job.jobId);
    if (!["queued", "running"].includes(finished.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(["completed", "completed_with_warnings"].includes(finished.status), JSON.stringify(finished));
  assert.equal(finished.result.createdCount, 2, JSON.stringify(finished));
  assert.equal(finished.result.failedCount, 0);
  assert.ok(requests > 0, "The independently configured fake analysis endpoint was used");
  const listed = listPePdfDocuments(project.root);
  assert.equal(listed.documents.length, 1);
  const pdf = listed.documents[0];
  const page = readPePdfPages(project.root, { docId: pdf.doc_id, pageStart: 1, includeImages: "never" }).pages[0];
  assert.ok(page.content.length > 0);
  const term = page.content.split(/\s+/u).find((word) => word.length >= 3)?.slice(0, 5);
  assert.ok(term);
  assert.ok(searchPePdfPages(project.root, { queries: [term] }).matched_page_count > 0);
  const db = new DatabaseSync(paths.collectionPath);
  try {
    const record = db.prepare("SELECT document_markdown_path,layout_json_path FROM documents WHERE doc_id=?").get(pdf.doc_id);
    assert.ok(readFileSync(path.join(project.root, record.document_markdown_path), "utf8").includes(`evidence_id: ${page.evidence_id}`));
    const layout = JSON.parse(readFileSync(path.join(project.root, record.layout_json_path), "utf8"));
    assert.ok(layout.pages.length > 0);
    assert.ok(existsSync(path.join(project.root, path.dirname(record.layout_json_path), layout.pages[0].imagePaths[0])));
    const excel = db.prepare("SELECT doc_id FROM documents WHERE file_type='xlsx'").get();
    const detail = await resolvePeEvidenceSource(project.root, sourceId({ docId: excel.doc_id, location: { kind: "excel", sheet: "Model", range: "B1:C1" } }));
    assert.equal(detail.payload.cells.find((cell) => cell.cell_ref === "C1").formula, "=B1*2");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM atomic_claims WHERE doc_id=?").get(excel.doc_id).n, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='chunks'").get(), undefined);
    assert.equal(db.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get().value, "4");
  } finally { db.close(); }
  const cards = listPeConsensusCards(project.root, { includeSources: true });
  assert.equal(cards.status, finished.result.analysis.status);
  if (cards.status === "completed") {
    assert.ok(cards.card_count > 0);
    assert.equal(cards.stale, false);
    assert.ok(cards.cards[0].sources[0].citations.length > 0);
  }
  assert.equal(createHash("sha256").update(readFileSync(process.env.PE_MIGRATION_SMOKE_PDF)).digest("hex"), hash);
  t.diagnostic(`PDF pages=${pdf.page_count}; analysis=${cards.status}; cards=${cards.card_count}; fake requests=${requests}`);
});
