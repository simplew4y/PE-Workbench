import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("uses the PE project registry instead of arbitrary directory selection", () => {
  assert.match(source, /fetch\("\/api\/pe\/projects"/);
  assert.match(source, /<PeProjectCreateDialog/);
  assert.match(source, /projects\.find\(\(project\) => project\.projectKey === selectedProject\.key\)/);
  assert.doesNotMatch(source, /<DirectoryPicker/);
  assert.doesNotMatch(source, /fetch\("\/api\/cwd\/validate"/);
  assert.doesNotMatch(source, /fetch\(`\/api\/worktrees/);
});
