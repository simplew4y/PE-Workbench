import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const compiledParser = path.resolve("dist/pe-ingest/pdf/parser.js");

test("keeps PDF.js recovery enabled for malformed hidden font objects", () => {
  const source = fs.readFileSync(new URL("./parser.ts", import.meta.url), "utf8");
  assert.match(source, /stopAtErrors:\s*false/u);
  assert.doesNotMatch(source, /stopAtErrors:\s*true/u);
});

function minimalTextPdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("extracts one page and writes Markdown, layout JSON, and a 110 DPI PNG", {
  skip: !fs.existsSync(compiledParser),
}, async (t) => {
  const { processPePdf } = await import(compiledParser);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-pdf-pipeline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rawPath = path.join(root, "report.pdf");
  const staging = path.join(root, "staging");
  fs.writeFileSync(rawPath, minimalTextPdf("Revenue grew twenty percent in the fiscal year."));

  const parsed = await processPePdf({
    datasetId: "dataset_fixture",
    originalFilename: "report.pdf",
    rawPath: "raw/report.pdf",
    rawAbsolutePath: rawPath,
    sha256: createHash("sha256").update(fs.readFileSync(rawPath)).digest("hex"),
    stagingDocumentDirectory: staging,
  });

  assert.equal(parsed.pages.length, 1);
  assert.match(parsed.pages[0].text, /Revenue grew twenty percent/u);
  assert.equal(parsed.pages[0].textQuality, "passed");
  assert.equal(parsed.artifactDirectory, "meta/documents/report");
  assert.equal(parsed.documentMarkdownPath, "meta/text/report.md");
  const markdown = fs.readFileSync(path.join(staging, "document.md"), "utf8");
  assert.match(markdown, /evidence_id: page:page_/u);
  const layout = JSON.parse(fs.readFileSync(path.join(staging, "layout.json"), "utf8"));
  assert.equal(layout.schemaVersion, 1);
  assert.equal(layout.pages.length, 1);
  const png = fs.readFileSync(path.join(staging, "pages", "page-0001@110.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 935);
  assert.equal(png.readUInt32BE(20), 1210);
});
