import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});

test("renders generative UI tool messages outside collapsed process details", () => {
  assert.match(source, /const uiProcessIndices = processIndices\.filter/);
  assert.match(source, /!uiProcessIndexSet\.has\(processIdx\) && hasDisplayableProcessMessage/);
  assert.match(source, /for \(const uiProcessIdx of uiProcessIndices\)[\s\S]*?keyPrefix: "generative-ui"/);
});
