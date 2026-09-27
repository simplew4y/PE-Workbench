import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildPePdfLayout } = await jiti.import("./layout.ts");
const { pePdfPageHeader } = await jiti.import("./markdown.ts");
const { extractPePdfMetadata, normalizePePdfDate } = await jiti.import("./metadata.ts");
const { classifyPePdfPageRole } = await jiti.import("./roles.ts");
const { normalizePePdfFilename } = await jiti.import("../paths.ts");

const PAGE = { width: 612, height: 792 };
const NO_IMAGES = { embeddedImageCount: 1, largeEmbeddedImageCount: 1, drawingOperatorCount: 2 };

function token(text, x, y, width, height = 9) {
  return { text, x, y, width, height, fontName: "F1", direction: "ltr", hasEol: true };
}

function prose(x, y, width, count, label) {
  return Array.from({ length: count }, (_, index) => (
    token(`${label} line ${index} with enough words to count as prose text`, x, y + index * 12, width)
  ));
}

test("keeps a wide main column separate from a narrow sidebar on a report cover", () => {
  const tokens = [
    token("Company Name", 43, 100, 150, 16),
    token("Report headline: what changed", 43, 240, 260, 20),
    ...prose(43, 284, 340, 12, "Body"),
    // Body lines occasionally overrun the gutter by a few points.
    token("Body overrun line that runs slightly past the sidebar edge", 43, 430, 372),
    token("30 June 2026", 446, 42, 63),
    ...prose(403, 291, 158, 10, "Sidebar"),
    token("Adjusted EPS F25A F26E F27E Financials F25A F26E F27E Valuation F25A F26E F27E", 46, 683, 514),
    token("Source: Bloomberg, Bernstein estimates and analysis.", 43, 726, 134),
  ];
  const layout = buildPePdfLayout("page_cover", tokens, PAGE.width, PAGE.height);
  const texts = layout.blocks.map((block) => block.text);
  assert.equal(layout.twoColumn, true);
  const bodyEnd = texts.indexOf("Body overrun line that runs slightly past the sidebar edge");
  const sidebarStart = texts.indexOf("30 June 2026");
  assert.ok(bodyEnd >= 0 && sidebarStart > bodyEnd, "sidebar follows the complete main column");
  assert.ok(texts.indexOf("Body line 11 with enough words to count as prose text") < sidebarStart);
  assert.equal(texts.at(-2), "Adjusted EPS F25A F26E F27E Financials F25A F26E F27E Valuation F25A F26E F27E");
  assert.equal(texts.at(-1), "Source: Bloomberg, Bernstein estimates and analysis.");
  assert.ok(!texts.some((text) => text.includes("Body") && text.includes("Sidebar")), "columns never merge");
});

test("reads a full-width table as rows above two side-by-side exhibits", () => {
  const tokens = [];
  const years = ["2000", "2005", "2010", "2015", "2019", "2025"];
  for (let row = 0; row < 6; row += 1) {
    const y = 150 + row * 11;
    tokens.push(token(`Division ${row}`, 76, y, 60));
    years.forEach((year, column) => tokens.push(token(String(300 + row * 10 + column), 180 + column * 62, y, 28)));
  }
  tokens.push(...prose(67, 300, 220, 5, "Left exhibit caption"));
  tokens.push(...prose(309, 300, 220, 5, "Right exhibit caption"));
  const layout = buildPePdfLayout("page_table", tokens, PAGE.width, PAGE.height);
  const texts = layout.blocks.map((block) => block.text);
  assert.equal(layout.twoColumn, true);
  assert.equal(texts[0], "Division 0 300 301 302 303 304 305");
  assert.equal(texts[5], "Division 5 350 351 352 353 354 355");
  assert.deepEqual(texts.slice(6, 11).map((text) => text.split(" line ")[0]), Array(5).fill("Left exhibit caption"));
  assert.deepEqual(texts.slice(11).map((text) => text.split(" line ")[0]), Array(5).fill("Right exhibit caption"));
});

test("classifies English research report appendix pages by heading, vocabulary density, and structure", () => {
  const blocks = (lines) => lines.map((text) => ({ text, blockType: "body" }));
  const appendix = "DISCLOSURE APPENDIX\nI. REQUIRED DISCLOSURES\nReferences to the Firm relate to the following entities.";
  assert.equal(classifyPePdfPageRole(15, 24, appendix, blocks(appendix.split("\n")), NO_IMAGES).role, "disclosure_boilerplate");

  const legal = Array(30).fill(
    "This report has been prepared by an affiliate and is distributed to persons regulated by the SEC; "
    + "no liability is accepted and the recipient must not solicit or distribute it in any jurisdiction.",
  ).join("\n");
  const continuation = classifyPePdfPageRole(20, 24, legal, blocks(legal.split("\n")), NO_IMAGES);
  assert.equal(continuation.role, "disclosure_boilerplate");
  assert.ok(continuation.signals.disclosureDensity >= 6);

  const analysis = Array(30).fill(
    "Hermès is stretching its assortment upwards to better serve rich consumers, with price points "
    + "moving into the hundreds of thousands while leather goods keep growing at double digits.",
  ).join("\n");
  assert.equal(classifyPePdfPageRole(4, 24, analysis, blocks(analysis.split("\n")), NO_IMAGES).role, "body");

  const passingMention = "Our valuation methods for luxury names blend relative P/E with DCF; Hermès trades at a premium.\n".repeat(20);
  assert.equal(classifyPePdfPageRole(7, 13, passingMention, blocks(passingMention.split("\n")), NO_IMAGES).role, "body");
  const valuation = "VALUATION METHODOLOGY\nWe value Hermès on a target 3.2x relative P/E multiple.\nRISKS\nDownside risks include slower growth.";
  assert.equal(classifyPePdfPageRole(15, 24, valuation, blocks(valuation.split("\n")), NO_IMAGES).role, "valuation_method");

  const ratingTable = [
    "Date Stock Price (€) Price Target (€) Rating",
    "2025-02-17 2809.00 3205.00 Buy",
    "2025-03-28 2436.00 2975.00 Buy",
    "2025-06-30 2299.00 2704.00 Neutral",
    "2025-09-29 2119.00 2310.00 Neutral",
  ].join("\n");
  assert.equal(classifyPePdfPageRole(6, 13, ratingTable, blocks(ratingTable.split("\n")), NO_IMAGES).role, "rating_history");

  const captionedAppendix = [
    "DISCLOSURE APPENDIX",
    "Table 1: Rating Distribution",
    "Outperform 54% Market-Perform 40% Underperform 6%",
    "Each research analyst certifies that the views expressed accurately reflect their personal views.",
  ].join("\n");
  assert.equal(
    classifyPePdfPageRole(14, 24, captionedAppendix, blocks(captionedAppendix.split("\n")), NO_IMAGES).role,
    "disclosure_boilerplate",
    "an explicit appendix heading wins over an exhibit caption on the same page",
  );

  const screenshots = "EXHIBIT 3: Some backlash in China\nSource: Weibo\nEXHIBIT 4: Feedback more mixed in the US\nSource: Reddit";
  const screenshotPage = classifyPePdfPageRole(5, 21, screenshots, blocks(screenshots.split("\n")), {
    embeddedImageCount: 4, largeEmbeddedImageCount: 4, drawingOperatorCount: 3,
  });
  assert.equal(screenshotPage.role, "exhibit_image");
});

test("extracts cover metadata from English sell-side templates", () => {
  const cover = [
    "Global Luxury Goods", "Hermes International", "Rating", "Outperform", "Price Target", "RMS.FP", "2,150.00 EUR",
    "Hermès: Stretching upwards",
    "Hermès’s brand equity is second to none. We rate Hermès Outperform, PT €2,150.00.",
    "Source: Bloomberg, Bernstein estimates and analysis.",
    "First Published: 30 Jun 2026 05:28 UTC Completion Date: 29 Jun 2026 23:28 UTC",
    "30 June 2026", "Luca Solca", "luca.solca@bernsteinsg.com", "Close Date", "29 Jun 2026",
  ];
  const heights = { "Hermes International": 16, "Outperform": 14, "Hermès: Stretching upwards": 20 };
  const blocks = cover.map((text) => ({ text, height: heights[text] ?? 9, x: 43 }));
  const metadata = extractPePdfMetadata("Bernstein-Hermes International（RMS.FP）Hermès： Stretching upwards-260630.pdf", {}, cover.join("\n"), [cover.join("\n"), "EXHIBIT 1: Revenue mix"], blocks);
  assert.equal(metadata.title, "Hermès: Stretching upwards");
  assert.equal(metadata.brokerage, "Bernstein");
  assert.equal(metadata.documentDate, "2026-06-30");
  assert.equal(metadata.rating, "Outperform");
  assert.equal(metadata.targetPrice, "2,150.00 EUR");
  assert.deepEqual(metadata.exhibits, ["EXHIBIT 1: Revenue mix"]);

  const ubs = [
    "First Read", "Hermès International SCA", "Conf Call feedback: Unchanged strategy despite", "evolving trends",
    "Valuation: Neutral, price target €1,820/share", "price of € 1,783.00 on 14-Apr-2026", "Global Research",
    "15 April 2026", "12-month rating Neutral", "12m price target", "€1,820.00", "EBIT (UBS)",
  ];
  const ubsHeights = { "Hermès International SCA": 16, "Conf Call feedback: Unchanged strategy despite": 14, "evolving trends": 14 };
  const ubsMetadata = extractPePdfMetadata("report.pdf", {}, ubs.join("\n"), [ubs.join("\n")], ubs.map((text) => ({ text, height: ubsHeights[text] ?? 9, x: 40 })));
  assert.equal(ubsMetadata.title, "Conf Call feedback: Unchanged strategy despite evolving trends");
  assert.equal(ubsMetadata.brokerage, "UBS");
  assert.equal(ubsMetadata.documentDate, "2026-04-15");
  assert.equal(ubsMetadata.rating, "Neutral");
  assert.equal(ubsMetadata.targetPrice, "€1,820/share");

  const hongKong = extractPePdfMetadata(
    "J.P. Morgan-Company.pdf",
    {},
    "Rating\nOverweight\nPrice target\nHK$ 123.40\nSource: Goldman Sachs estimates",
    [],
  );
  assert.equal(hongKong.brokerage, "J.P. Morgan");
  assert.equal(hongKong.targetPrice, "HK$ 123.40");
});

test("rejects impossible dates instead of emitting month 26", () => {
  assert.equal(normalizePePdfDate("Tracker~May 2026-260527.pdf"), "");
  assert.equal(normalizePePdfDate("2026-02-29"), "");
  assert.equal(normalizePePdfDate("2024-02-29"), "2024-02-29");
  assert.equal(normalizePePdfDate("31 April 2026"), "");
  assert.equal(normalizePePdfDate("阳光电源-20260615.pdf"), "2026-06-15");
  assert.equal(normalizePePdfDate("D:20260616101122+08'00'"), "2026-06-16");
  assert.equal(normalizePePdfDate("June 30, 2026"), "2026-06-30");
  assert.equal(extractPePdfMetadata("Tracker-260527.pdf", {}, "BERNSTEIN FLASHMAIL\n27 May 2026", []).documentDate, "2026-05-27");
});

test("page headers carry the role and up to three exhibit captions", () => {
  const header = pePdfPageHeader(
    "report.pdf",
    { brokerage: "Bernstein", documentDate: "2026-06-30" },
    {
      pageNumber: 5,
      role: "exhibit_chart",
      text: "EXHIBIT 8: Hermès continues to stretch\nSource: Company\nEXHIBIT 9: Second chart\nEXHIBIT 10: Third\nEXHIBIT 11: Fourth",
    },
    24,
  );
  assert.equal(
    header,
    "report.pdf · Bernstein · 2026-06-30 · p.5/24 · exhibit_chart · EXHIBIT 8: Hermès continues to stretch; EXHIBIT 9: Second chart; EXHIBIT 10: Third",
  );
});

test("accepts research platform filenames with full-width punctuation", () => {
  assert.equal(
    normalizePePdfFilename("Bernstein-Ferrari NV（RACE.US）Ferrari： Manual（e） for Success-260706.pdf"),
    "Bernstein-Ferrari NV（RACE.US）Ferrari： Manual（e） for Success-260706.pdf",
  );
  assert.equal(normalizePePdfFilename('What "next"? Q&A.pdf'), "What ＂next＂？ Q&A.pdf");
  assert.throws(() => normalizePePdfFilename("../escape.pdf"), /Invalid portable document filename/u);
  assert.throws(() => normalizePePdfFilename("dir/report.pdf"), /Invalid portable document filename/u);
});
