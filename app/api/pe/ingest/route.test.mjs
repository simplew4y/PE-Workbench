import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("requires a registered project and never accepts a browser-supplied workspace path", () => {
  assert.match(source, /const datasetId = textField\(form, "datasetId"\)\.trim\(\)/);
  assert.match(source, /getPeProject\(datasetId\)/);
  assert.match(source, /peProjectStorePaths\(\)\.registryPath/);
  assert.doesNotMatch(source, /textField\(form, "cwd"\)/);
  assert.doesNotMatch(source, /identifyPeUploads|findCanonicalPeProject|createPeProject/);
});

test("accepts only supported document extensions and delegates content validation", () => {
  assert.match(source, /PE_SUPPORTED_EXTENSIONS/);
  assert.match(source, /Only PDF, XLSX, and XLSM files are supported/);
  assert.match(source, /queuePeIngest/);
  assert.match(source, /Each document must be 100MB or smaller/);
  assert.match(source, /Document uploads must total 300MB or less/);
});
