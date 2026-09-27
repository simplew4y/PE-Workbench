import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("retries the registered document version and accepts existing filename requests", () => {
  assert.match(source, /body\.datasetId/);
  assert.match(source, /body\.filename/);
  assert.match(source, /body\.docId/);
  assert.match(source, /getPeProject\(datasetId\)/);
  assert.match(source, /queuePeExcelRetry/);
  assert.match(source, /queuePeDocumentRetry/);
  assert.doesNotMatch(source, /body\.cwd|body\.databasePath/);
});
