import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("lists documents by registered dataset instead of a client-provided path", () => {
  assert.match(source, /searchParams\.get\("datasetId"\)/u);
  assert.match(source, /listPeProjectDocuments\(datasetId\)/u);
  assert.doesNotMatch(source, /searchParams\.get\("cwd"\)/u);
  assert.doesNotMatch(source, /searchParams\.get\("path"\)/u);
});
