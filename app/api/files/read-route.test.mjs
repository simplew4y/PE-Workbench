import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");

test("file read route pages large text, keeps PDF streaming, and enforces access checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pe-file-read-route-"));
  const previousCache = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(async () => {
    globalThis.__piAllowedRootsCache = previousCache;
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, "workbook.txt");
  const content = "财务预测\t=SUM(A1:A9)\t123.45\n".repeat(25_000);
  await writeFile(file, content);
  const request = (filePath, page) => GET(
    new NextRequest(`http://localhost/api/files/fixture?type=read${page === undefined ? "" : `&page=${page}`}`),
    { params: Promise.resolve({ path: filePath.replaceAll("\\", "/").split("/").filter(Boolean) }) },
  );
  const response = await request(file);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.language, "text");
  assert.ok(first.textPage.pageCount > 1);
  assert.equal(first.size, Buffer.byteLength(content));
  let fullText = first.content;
  for (let page = 1; page < first.textPage.pageCount; page++) {
    const result = await request(file, page);
    assert.equal(result.status, 200);
    fullText += (await result.json()).content;
  }
  assert.equal(fullText, content);
  assert.equal((await request(file, "-1")).status, 400);
  assert.equal((await request(join(tmpdir(), "outside-pe-file-preview.txt"))).status, 403);
  const pdf = join(root, "report.pdf");
  await writeFile(pdf, "%PDF-1.7\nfixture");
  const pdfResponse = await request(pdf);
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("Content-Type"), "application/pdf");
  assert.equal(await pdfResponse.text(), "%PDF-1.7\nfixture");
  const binary = join(root, "workbook.xlsx");
  await writeFile(binary, Buffer.from([0x50, 0x4b, 0x03, 0, 0x04]));
  const binaryResponse = await request(binary);
  assert.equal(binaryResponse.status, 415);
  assert.match((await binaryResponse.json()).error, /Binary files cannot be previewed as text/);
});
