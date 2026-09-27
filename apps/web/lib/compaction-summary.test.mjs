import assert from "node:assert/strict";
import test from "node:test";
import { parseCompactionSummary } from "./compaction-summary.ts";

test("deduplicates file metadata within and across sections in first-seen order", () => {
  const summary = `Summary.

<read-files>
/skills/business-driver-model/SKILL.md
/tmp/b.ts
  /skills/business-driver-model/SKILL.md
</read-files>
<read-files>
/tmp/b.ts
/tmp/c.ts
</read-files>
<modified-files>
/tmp/b.ts
/tmp/b.ts
/tmp/changed.ts
</modified-files>
<modified-files>
/tmp/changed.ts
</modified-files>`;

  assert.deepEqual(parseCompactionSummary(summary), {
    body: "Summary.",
    readFiles: ["/skills/business-driver-model/SKILL.md", "/tmp/b.ts", "/tmp/c.ts"],
    // A file may legitimately appear once in each category.
    modifiedFiles: ["/tmp/b.ts", "/tmp/changed.ts"],
  });
});

test("separates pi file metadata tags from the visible compaction summary", () => {
  const parsed = parseCompactionSummary(`## Goal
Keep the important user intent.

<read-files>
/tmp/a.ts
/tmp/b.ts
</read-files>

<modified-files>
/tmp/changed.ts
</modified-files>`);

  assert.equal(parsed.body, "## Goal\nKeep the important user intent.");
  assert.deepEqual(parsed.readFiles, ["/tmp/a.ts", "/tmp/b.ts"]);
  assert.deepEqual(parsed.modifiedFiles, ["/tmp/changed.ts"]);
});

test("leaves normal summaries unchanged", () => {
  const summary = "## Goal\nNo file metadata here.";

  assert.deepEqual(parseCompactionSummary(summary), {
    body: summary,
    readFiles: [],
    modifiedFiles: [],
  });
});

test("keeps file-like tags that are part of the summary body", () => {
  const summary = `## Critical Context
The user asked what this compact metadata means: <read-files>example</read-files>.

More summary text after the mention.`;

  assert.deepEqual(parseCompactionSummary(summary), {
    body: summary,
    readFiles: [],
    modifiedFiles: [],
  });
});
