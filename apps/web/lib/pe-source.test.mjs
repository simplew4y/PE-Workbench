import assert from "node:assert/strict";
import test from "node:test";
import { sourceId } from "@earendil-works/pe-boot";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  excelColumnLabel,
  parseExcelCellRange,
  parsePeSourceHref,
  peSourceApiUrl,
  peSourceFileUrl,
} = await jiti.import("./pe-source.ts");

test("parses PE evidence references without exposing workspace paths", () => {
  const excelEvidenceId = sourceId({ docId: "doc_model", sheet: "Forecast", range: "C5:E7" });
  assert.deepEqual(
    parsePeSourceHref(`#pe-source?${new URLSearchParams({ evidence_id: excelEvidenceId })}`),
    { evidenceId: excelEvidenceId },
  );
  assert.deepEqual(
    parsePeSourceHref("#pe-source?evidence_id=page%3Apage_abc123"),
    { evidenceId: "page:page_abc123" },
  );
  assert.equal(parsePeSourceHref("https://example.com"), null);
  assert.equal(parsePeSourceHref("#pe-source?evidence_id=invalid"), null);
});

test("adds the workspace only to server API requests", () => {
  const metadataUrl = peSourceApiUrl("/workspace/300274", "page:page_abc123");
  const fileUrl = peSourceFileUrl("/workspace/300274", "page:page_abc123");

  assert.equal(
    metadataUrl,
    "/api/pe/source?cwd=%2Fworkspace%2F300274&evidence_id=page%3Apage_abc123",
  );
  assert.equal(
    fileUrl,
    "/api/pe/source/file?cwd=%2Fworkspace%2F300274&evidence_id=page%3Apage_abc123",
  );
});

test("recovers model-expanded app citation URLs without accepting external sites", () => {
  assert.deepEqual(parsePeSourceHref("https://pe-workbench.local/pe-source?evidence_id=page%3Apage_abc123&cwd=/wrong"), { evidenceId: "page:page_abc123" });
  assert.deepEqual(parsePeSourceHref("/pe-source?evidence_id=page%3Apage_abc123"), { evidenceId: "page:page_abc123" });
  for (const href of ["https://evil.example/pe-source?evidence_id=page%3Apage_abc", "https://pe-workbench.local.evil/pe-source?evidence_id=page%3Apage_abc", "https://user@pe-workbench.local/pe-source?evidence_id=page%3Apage_abc", "javascript:alert(1)"]) assert.equal(parsePeSourceHref(href), null);
});

test("builds familiar Excel column labels and evidence bounds", () => {
  assert.equal(excelColumnLabel(1), "A");
  assert.equal(excelColumnLabel(26), "Z");
  assert.equal(excelColumnLabel(27), "AA");
  assert.deepEqual(parseExcelCellRange("$C$5:E7"), {
    row_start: 5,
    row_end: 7,
    col_start: 3,
    col_end: 5,
  });
});
