import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("asr config is local agent-dir JSON with trusted API access", () => {
  assert.match(source, /readPeAsrConfig/);
  assert.match(source, /writePeAsrConfig/);
  assert.match(source, /isApiRequestAllowed/);
  assert.match(source, /hasJsonContentType/);
  assert.match(source, /asrConfigView/);
});
