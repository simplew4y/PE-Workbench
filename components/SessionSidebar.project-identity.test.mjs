import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const projectSelectionStart = source.indexOf("const selectProject = useCallback");
const projectSelectionEnd = source.indexOf("// Close dropdowns", projectSelectionStart);
const projectSelectionSource = source.slice(projectSelectionStart, projectSelectionEnd);

test("registered project selection is persisted before changing cwd", () => {
  assert.notEqual(projectSelectionStart, -1);
  assert.notEqual(projectSelectionEnd, -1);
  assert.match(projectSelectionSource, /fetch\("\/api\/pe\/projects"/);
  assert.match(projectSelectionSource, /body: JSON\.stringify\(\{ datasetId: project\.datasetId \}\)/);

  const activeProjectUpdate = projectSelectionSource.indexOf("setActiveDatasetId(");
  const cwdUpdate = projectSelectionSource.indexOf("setSelectedCwd(");
  assert.ok(activeProjectUpdate >= 0, "active project identity is retained");
  assert.ok(cwdUpdate > activeProjectUpdate, "project identity is retained before cwd changes");
});
