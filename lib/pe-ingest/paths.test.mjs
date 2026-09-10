import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { normalizePeDocumentFilename, normalizePePdfFilename, peDocumentFilenameKey, writePeRawFile, hasPeRawFilename } = await jiti.import("./paths.ts");
const reportedFilename = "Bernstein-Lululemon Athletica Inc（LULU.US）Lululemon： Product issue or brand-0swp (2).pdf";

test("preserves valid Unicode punctuation in PDF and workbook filenames", () => {
  assert.equal(normalizePePdfFilename(reportedFilename), reportedFilename);
  for (const filename of ["模型（2026）：估值.xlsx", "研究报告？附录！.PDF", "模型＃预测.xlsm"]) {
    assert.equal(normalizePeDocumentFilename(filename), filename);
  }
  assert.equal(normalizePeDocumentFilename("Cafe\u0301.pdf"), "Café.pdf");
});

test("maps Windows-invalid punctuation while preserving valid Unicode punctuation", () => {
  for (const [input, expected] of [
    ["report:notes.pdf", "report：notes.pdf"],
    ["report?.pdf", "report？.pdf"],
    ["report*.pdf", "report＊.pdf"],
    ["report|notes.pdf", "report｜notes.pdf"],
    ["report<notes>.pdf", "report＜notes＞.pdf"],
    ['report"notes.pdf', "report＂notes.pdf"],
    ["公司（A股）：2026?模型.xlsx", "公司（A股）：2026？模型.xlsx"],
  ]) {
    assert.equal(normalizePeDocumentFilename(input), expected);
    assert.equal(peDocumentFilenameKey(input), peDocumentFilenameKey(expected));
  }
});

test("continues rejecting path separators, control characters, and reserved names", () => {
  for (const filename of ["../report.pdf", "folder/report.pdf", "folder\\report.pdf", "report\u0000.pdf", "report\n.pdf", "CON.pdf", "NUL.xlsx", "LPT1.pdf"]) {
    assert.throws(() => normalizePeDocumentFilename(filename), /Invalid portable document filename/u, filename);
  }
});

test("uses compatibility normalization only for duplicate identities", () => {
  assert.equal(peDocumentFilenameKey("Report（1）.PDF"), peDocumentFilenameKey("report(1).pdf"));
  assert.equal(peDocumentFilenameKey("研究：估值.pdf"), "研究:估值.pdf");
});

test("writes the reported filename unchanged and still blocks duplicate originals", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pe-unicode-filenames-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { projectPath: root, rawPath: path.join(root, "raw") };
  mkdirSync(paths.rawPath);
  const bytes = Buffer.from("%PDF-1.7 filename storage regression");
  const stored = writePeRawFile(paths, reportedFilename, bytes);
  assert.equal(stored.rawPath, `raw/${reportedFilename}`);
  assert.deepEqual(readFileSync(path.join(paths.rawPath, reportedFilename)), bytes);
  assert.equal(hasPeRawFilename(paths, reportedFilename), true);
  assert.throws(() => writePeRawFile(paths, reportedFilename, bytes), /already exists/u);
});
