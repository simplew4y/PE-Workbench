import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { sourceId } from "@earendil-works/pe-boot/source";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  excelColumnLabel,
  parseExcelCellRange,
  parsePeSourceHref,
  peSourceApiUrl,
  peSourceFileUrl,
} = await jiti.import("./pe-source.ts");

test("parses PE evidence references without exposing workspace paths", () => {
  assert.deepEqual(
    parsePeSourceHref("#pe-source?evidence_id=chunk%3Aabc123"),
    { evidenceId: "chunk:abc123" },
  );
  assert.deepEqual(
    parsePeSourceHref("http://localhost/chat#pe-source?evidence_id=fact%3Arevenue"),
    { evidenceId: "fact:revenue" },
  );
  assert.deepEqual(
    parsePeSourceHref("#pe-source?evidence_id=page%3Apage_abc123"),
    { evidenceId: "page:page_abc123" },
  );
  assert.equal(parsePeSourceHref("https://example.com"), null);
  assert.equal(parsePeSourceHref("#pe-source?evidence_id=invalid"), null);
});

test("adds the workspace only to server API requests", () => {
  const metadataUrl = peSourceApiUrl("/workspace/300274", "chunk:abc123");
  const fileUrl = peSourceFileUrl("/workspace/300274", "chunk:abc123");

  assert.equal(
    metadataUrl,
    "/api/pe/source?cwd=%2Fworkspace%2F300274&evidence_id=chunk%3Aabc123",
  );
  assert.equal(
    fileUrl,
    "/api/pe/source/file?cwd=%2Fworkspace%2F300274&evidence_id=chunk%3Aabc123",
  );
});

test("recovers model-expanded app citation URLs without accepting external sites", () => {
  assert.deepEqual(parsePeSourceHref("https://pe-workbench.local/pe-source?evidence_id=chunk%3Aabc123&cwd=/wrong"), { evidenceId: "chunk:abc123" });
  assert.deepEqual(parsePeSourceHref("/pe-source?evidence_id=fact%3Arevenue"), { evidenceId: "fact:revenue" });
  for (const href of ["https://evil.example/pe-source?evidence_id=chunk%3Aabc", "https://pe-workbench.local.evil/pe-source?evidence_id=chunk%3Aabc", "https://user@pe-workbench.local/pe-source?evidence_id=chunk%3Aabc", "javascript:alert(1)"]) assert.equal(parsePeSourceHref(href), null);
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

test("recognizes versioned Excel ranges, including Chinese sheet names and blank cells", () => {
  const evidenceId = sourceId({ docId: "version-1", location: { kind: "excel", sheet: "估值模型", range: "Z90:AA100" } });
  assert.deepEqual(parsePeSourceHref(`#pe-source?evidence_id=${encodeURIComponent(evidenceId)}`), { evidenceId });
  for (const id of ["source:garbage", "source:W10", "source:bad+base64", "source:"]) {
    assert.equal(parsePeSourceHref(`#pe-source?evidence_id=${encodeURIComponent(id)}`), null);
  }
});
