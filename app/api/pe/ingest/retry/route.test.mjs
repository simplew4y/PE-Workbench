import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("retries Excel by registered dataset and filename only", () => {
  assert.match(source, /body\.datasetId/);
  assert.match(source, /body\.filename/);
  assert.match(source, /getPeProject\(datasetId\)/);
  assert.match(source, /queuePeExcelRetry/);
  assert.doesNotMatch(source, /body\.cwd|body\.docId|body\.databasePath/);
});
