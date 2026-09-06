import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("identifies and groups global uploads before routing company projects", () => {
  assert.match(source, /identifyPeUploads\(manifestPath\)/);
  assert.match(source, /findCanonicalPeProject\(group\.identity, knownProjects\)/);
  assert.match(source, /group\.identity\.company_confidence < PE_UPLOAD_AUTO_CREATE_THRESHOLD/);
  assert.match(source, /createPeProject\(\{/);
  assert.match(source, /needsReview\.push\(\{/);
  assert.match(source, /const routed = new Map/);
});

test("keeps upload identification staging outside the persistent PE workbench store", () => {
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "pe-upload-"\)\)/);
  assert.match(source, /fs\.rmSync\(batchDirectory, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /storeRoot/);
  assert.doesNotMatch(source, /"_inbox"/);
});
