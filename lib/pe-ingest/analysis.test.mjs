import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runPeClaimAnalysis } = await jiti.import("./analysis.ts");

function collectionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-claim-analysis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const collectionPath = path.join(root, "collection.sqlite3");
  const database = new DatabaseSync(collectionPath);
  database.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
      original_filename TEXT NOT NULL, file_type TEXT NOT NULL DEFAULT 'pdf',
      doc_type TEXT, company_name TEXT, brokerage TEXT, document_date TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      lifecycle_state TEXT NOT NULL DEFAULT 'active', deleted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pdf_pages (
      page_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, page_number INTEGER NOT NULL,
      page_text TEXT NOT NULL, page_header TEXT NOT NULL, role TEXT NOT NULL
    );
    INSERT INTO documents (
      doc_id, dataset_id, original_filename, doc_type, company_name,
      brokerage, document_date, created_at
    ) VALUES (
      'doc-1', 'dataset-1', '华泰证券-测试公司深度报告.pdf', 'research_report',
      '测试公司', '华泰证券', '2026-09-05', '2026-09-06T00:00:00Z'
    );
    INSERT INTO pdf_pages VALUES (
      'page-1', 'doc-1', 1,
      '我们预计 2026 年 AI 芯片出货量达到 120 万颗，主要客户为头部云厂商。',
      '华泰证券 | 2026-09-05', 'cover'
    );
  `);
  database.close();
  return collectionPath;
}

function modelServer(t) {
  const requestKinds = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const system = payload.messages?.[0]?.content ?? "";
    let content;
    if (system.includes("维护一份投研分析问题清单")) {
      requestKinds.push("question-resolution");
      content = {
        decisions: [{
          proposed_key: "ai_chip_shipments",
          item_key: "ai_chip_shipments",
          question: "AI 芯片出货量",
          description: "AI 芯片的年度出货预测",
          scope: "company",
          claim_type: "quantitative",
          value_kind: "volume",
          period_required: true,
        }],
      };
    } else if (system.includes("共识/分歧卡片")) {
      requestKinds.push("card-narrative");
      content = { cards: [] };
    } else {
      requestKinds.push("document-scan");
      content = {
        document: {
          issuer_name: "华泰证券",
          issuer_kind: "sell_side",
          issuer_confidence: 0.99,
          issuer_evidence: ["封面"],
          published_date: "2026-09-05",
        },
        proposed_items: [{
          key: "ai_chip_shipments",
          question: "AI 芯片出货量",
          scope: "company",
          claim_type: "quantitative",
          value_kind: "volume",
          rationale: "报告给出明确年度预测",
        }],
        claims: [{
          item_key: "ai_chip_shipments",
          claim_text: "预计 2026 年 AI 芯片出货 120 万颗",
          reason: "头部云厂商需求",
          stance: "bullish",
          measure: "volume",
          value_numeric: 120,
          unit: "万颗",
          currency: "",
          period: "2026",
          scope_note: "AI 芯片",
          confidence: 0.9,
          evidence_ids: ["page:page-1"],
          evidence_quotes: [{
            evidence_id: "page:page-1",
            quote: "2026 年 AI 芯片出货量达到 120 万颗",
          }],
        }],
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ server, requestKinds });
    });
  });
}

function setEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("extracts claims and new questions from current PDF pages in one document scan", async (t) => {
  const collectionPath = collectionFixture(t);
  const { server, requestKinds } = await modelServer(t);
  const address = server.address();
  assert.equal(typeof address, "object");
  setEnv(t, "PE_CONSENSUS_ENABLED", "1");
  setEnv(t, "PE_INGEST_LLM_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
  setEnv(t, "PE_INGEST_LLM_API_KEY", "test-key");
  setEnv(t, "PE_INGEST_LLM_MODEL", "test-model");
  setEnv(t, "PE_INGEST_LLM_MAX_ATTEMPTS", "1");

  const summary = await runPeClaimAnalysis({
    collectionPath,
    datasetId: "dataset-1",
    companyName: "测试公司",
    ingestedAt: "2026-09-06T00:00:00Z",
    docIds: ["doc-1"],
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.documents_scanned, 1);
  assert.deepEqual(summary.checklist_created, ["ai_chip_shipments"]);
  assert.equal(summary.cards.cards, 1);
  assert.deepEqual(requestKinds, ["document-scan", "question-resolution", "card-narrative"]);

  const database = new DatabaseSync(collectionPath, { readOnly: true });
  try {
    const claim = database.prepare(
      "SELECT item_key, issuer_key, evidence_ids_json, quality_status FROM atomic_claims",
    ).get();
    assert.deepEqual(
      {
        itemKey: claim.item_key,
        issuerKey: claim.issuer_key,
        evidenceIds: JSON.parse(claim.evidence_ids_json),
        qualityStatus: claim.quality_status,
      },
      {
        itemKey: "ai_chip_shipments",
        issuerKey: "htsc",
        evidenceIds: ["page:page-1"],
        qualityStatus: "verified",
      },
    );
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM analysis_checklist_items WHERE item_key = 'ai_chip_shipments'",
    ).get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM consensus_cards").get().count, 1);
  } finally {
    database.close();
  }
});

test("stays off until a deployment opts in", async (t) => {
  setEnv(t, "PE_CONSENSUS_ENABLED", "");
  const summary = await runPeClaimAnalysis({
    collectionPath: "/nonexistent/collection.sqlite3",
    datasetId: "dataset_disabled",
  });
  assert.equal(summary.status, "skipped_disabled");
});
