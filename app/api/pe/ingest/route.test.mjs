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

test("accepts only PDF extension, MIME, and content validated by the pipeline", () => {
  assert.match(source, /PE_SUPPORTED_EXTENSIONS/);
  assert.match(source, /file\.type\.toLocaleLowerCase\(\) !== PE_PDF_MIME_TYPE/);
  assert.match(source, /queuePePdfIngest/);
  assert.match(source, /Each PDF must be 100MB or smaller/);
  assert.match(source, /PDF uploads must total 300MB or less/);
});
