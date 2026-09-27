import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildPePdfLayout } = await jiti.import("./layout.ts");
const { renderPePdfMarkdown } = await jiti.import("./markdown.ts");
const { extractPePdfMetadata } = await jiti.import("./metadata.ts");
const { evaluatePePdfTextQuality } = await jiti.import("./quality.ts");
const { classifyPePdfPageRole } = await jiti.import("./roles.ts");

function token(text, x, y, width = 80, height = 10) {
  return { text, x, y, width, height, fontName: "F1", direction: "ltr", hasEol: true };
}

test("orders a confident two-column page left column before right column", () => {
  const tokens = [];
  for (let index = 0; index < 4; index += 1) {
    tokens.push(token(`左栏内容${index}`, 40, 80 + index * 30));
    tokens.push(token(`右栏内容${index}`, 330, 80 + index * 30));
  }
  const layout = buildPePdfLayout("page_test", tokens, 600, 800);
  assert.equal(layout.twoColumn, true);
  assert.deepEqual(
    layout.blocks.map((block) => block.text),
    ["左栏内容0", "左栏内容1", "左栏内容2", "左栏内容3", "右栏内容0", "右栏内容1", "右栏内容2", "右栏内容3"],
  );
  assert.deepEqual(layout.blocks.map((block) => block.columnNo), [1, 1, 1, 1, 2, 2, 2, 2]);
});

test("falls back to normal position order when column evidence is weak", () => {
  const layout = buildPePdfLayout("page_test", [
    token("第一行", 40, 80),
    token("第二行", 330, 110),
    token("第三行", 40, 140),
  ], 600, 800);
  assert.equal(layout.twoColumn, false);
  assert.deepEqual(layout.blocks.map((block) => block.text), ["第一行", "第二行", "第三行"]);
});

test("marks speaker lines without splitting them into separate retrieval chunks", () => {
  const layout = buildPePdfLayout("page_test", [token("管理层：今年收入保持增长", 40, 80, 200)], 600, 800);
  assert.equal(layout.blocks[0].blockType, "speaker");
  assert.equal(layout.text, "管理层：今年收入保持增长");
});

test("detects empty or garbled pages as needing OCR", () => {
  assert.equal(evaluatePePdfTextQuality("").quality, "needs_ocr");
  assert.equal(evaluatePePdfTextQuality("有效短句。").quality, "passed");
  assert.equal(evaluatePePdfTextQuality("正常的中文研究报告文字，包含营业收入、利润率与现金流等有效信息。").quality, "passed");
  assert.equal(evaluatePePdfTextQuality("����������������������������").quality, "needs_ocr");
});

test("prefers the report date in page text or filename over PDF creation time", () => {
  const filenameDate = extractPePdfMetadata(
    "阳光电源-20260615.pdf",
    { CreationDate: "D:20260616101122+08'00'" },
    "阳光电源研究记录",
    [],
  );
  assert.equal(filenameDate.documentDate, "2026-06-15");

  const pageDate = extractPePdfMetadata(
    "阳光电源-20260615.pdf",
    { CreationDate: "D:20260616101122+08'00'" },
    "会议日期：2026年6月14日",
    [],
  );
  assert.equal(pageDate.documentDate, "2026-06-14");
});

test("renders stable page evidence and image markers in Markdown", () => {
  const markdown = renderPePdfMarkdown("report.pdf", {
    title: "报告",
    brokerage: "示例证券",
    documentDate: "2026-09-06",
    rating: "买入",
    targetPrice: "100元",
    exhibits: [],
    pdfMetadata: {},
  }, [{
    pageId: "page_123",
    pageNumber: 1,
    role: "cover",
    roleSignals: {
      matchedKeywords: [], numericLineRatio: 0, tableLineRatio: 0,
      embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0,
    },
    width: 595,
    height: 842,
    rotation: 0,
    text: "报告正文",
    pageHeader: "",
    textQuality: "passed",
    qualitySignals: {
      characterCount: 4, replacementCharacterRatio: 0,
      suspiciousCharacterRatio: 0, readableCharacterRatio: 1, reasons: [],
    },
    imagePaths: ["pages/page-0001@110.png"],
    imageStatistics: { embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 0 },
    blocks: [],
  }]);
  assert.match(markdown, /<!-- evidence_id: page:page_123 -->/u);
  assert.match(markdown, /<!-- image: pages\/page-0001@110\.png -->/u);
  assert.match(markdown, /> report\.pdf · 示例证券 · 2026-09-06 · p\.1\/1/u);
});

test("records explainable signals when classifying disclosure and table pages", () => {
  const statistics = { embeddedImageCount: 0, largeEmbeddedImageCount: 0, drawingOperatorCount: 3 };
  const disclosure = classifyPePdfPageRole(
    9,
    10,
    "免责声明与分析师声明",
    [],
    statistics,
  );
  assert.equal(disclosure.role, "disclosure_boilerplate");
  assert.deepEqual(disclosure.signals.matchedKeywords, ["disclosure"]);

  const table = classifyPePdfPageRole(
    3,
    10,
    "收入 100\n利润 20\n毛利率 30%",
    [0, 1, 2].map((index) => ({ text: String(index), blockType: "table_row" })),
    statistics,
  );
  assert.equal(table.role, "table_heavy");
  assert.equal(table.signals.tableLineRatio, 1);
});
