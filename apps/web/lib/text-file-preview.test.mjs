import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types.ts";
import { parseTextPreviewPage, readTextFilePreview } from "./text-file-preview.ts";

async function fixture(t, content) {
  const root = await mkdtemp(join(tmpdir(), "pe-text-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "workbook.txt");
  await writeFile(file, content);
  return file;
}

test("validates text preview page parameters", () => {
  assert.equal(parseTextPreviewPage(null), 0);
  assert.equal(parseTextPreviewPage("0"), 0);
  assert.equal(parseTextPreviewPage("12"), 12);
  for (const invalid of ["", "-1", "1.2", "Infinity", "1e4", "9007199254740992"]) {
    assert.equal(parseTextPreviewPage(invalid), null);
  }
});

test("small files and empty files remain complete", async (t) => {
  for (const content of ["", "简体中文\n=AVERAGE(A1:A3)\r\n<em>text</em>"]) {
    const file = await fixture(t, content);
    const result = await readTextFilePreview(file);
    assert.equal(result.content, content);
    assert.deepEqual(result.textPage, { page: 0, pageCount: 1, byteStart: 0, byteEnd: Buffer.byteLength(content) });
  }
});

test("multi-megabyte text can be read in bounded pages without dropping or duplicating content", async (t) => {
  const content = "Sheet 财务预测\t=SUM(A1:A9)\t123.45\r\n".repeat(110_000);
  const file = await fixture(t, content);
  let reconstructed = "";
  let previousEnd = 0;
  const first = await readTextFilePreview(file);
  assert.ok(first.size > 3 * 1024 * 1024);
  for (let page = 0; page < first.textPage.pageCount; page++) {
    const result = await readTextFilePreview(file, page);
    assert.equal(result.textPage.page, page);
    assert.equal(result.textPage.byteStart, previousEnd);
    assert.ok(Buffer.byteLength(result.content) <= TEXT_PREVIEW_MAX_BYTES + 3);
    assert.ok(!result.content.includes("\ufffd"));
    reconstructed += result.content;
    previousEnd = result.textPage.byteEnd;
  }
  assert.equal(previousEnd, first.size);
  assert.equal(reconstructed, content);
});

test("UTF-8 characters crossing every possible boundary remain intact", async (t) => {
  for (const character of ["é", "财", "𠮷"]) {
    for (let split = 1; split < Buffer.byteLength(character); split++) {
      const content = "x".repeat(TEXT_PREVIEW_MAX_BYTES - split) + character + "末尾\n";
      const file = await fixture(t, content);
      const first = await readTextFilePreview(file, 0);
      const second = await readTextFilePreview(file, 1);
      assert.equal(first.content + second.content, content);
      assert.equal(first.textPage.byteEnd, second.textPage.byteStart);
    }
  }
});

test("exact page boundaries and shrinking files remain readable", async (t) => {
  const file = await fixture(t, "a".repeat(TEXT_PREVIEW_MAX_BYTES));
  assert.equal((await readTextFilePreview(file)).textPage.pageCount, 1);
  await writeFile(file, "a".repeat(TEXT_PREVIEW_MAX_BYTES + 1));
  assert.equal((await readTextFilePreview(file, 1)).content, "a");
  await writeFile(file, "short");
  const last = await readTextFilePreview(file, 200);
  assert.equal(last.content, "short");
  assert.equal(last.textPage.page, 0);
  assert.equal(await readFile(file, "utf8"), "short");
});

test("invalid pages and binary content do not produce misleading text previews", async (t) => {
  const file = await fixture(t, Buffer.from([0x50, 0x4b, 0x03, 0, 0x04]));
  await assert.rejects(readTextFilePreview(file, -1), /Invalid text preview page/);
  await assert.rejects(readTextFilePreview(file), /Binary files cannot be previewed as text/);
});
