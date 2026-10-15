import assert from "node:assert/strict";
import test from "node:test";

import { openFileTab, openSourceTab, refreshSourceTabs, saveFileViewerState, sourceTabId, switchSourceView } from "./file-tab-state.ts";

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [tabA, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});

test("source tabs open originals while parsing, refresh in place, and retain both views on cleanup", () => {
  const source = { datasetId: "a", docId: "report", versionNo: 1, fileName: "report.pdf",
    originalPath: "/a/report.pdf", parsedPath: null };
  const id = sourceTabId(source);
  let tabs = openSourceTab([tabB], source);
  assert.equal(tabs[1].filePath, source.originalPath);
  const ready = { ...source, parsedPath: "/a/report.md" };
  tabs = refreshSourceTabs(tabs, [ready]);
  const originalRevision = tabs[1].viewerRevision;
  tabs = switchSourceView(tabs, id, "parsed");
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].filePath, ready.parsedPath);
  tabs = saveFileViewerState(tabs, id, originalRevision, tabA.viewerState,
    { view: "original", path: source.originalPath });
  assert.equal(tabs[1].viewerState, undefined);
  const parsedRevision = tabs[1].viewerRevision;
  tabs = switchSourceView(tabs, id, "original");
  assert.deepEqual(tabs[1].viewerState, tabA.viewerState);
  const parsedState = { ...tabA.viewerState, scrollTop: 90, textPage: 3 };
  tabs = saveFileViewerState(tabs, id, parsedRevision, parsedState, { view: "parsed", path: ready.parsedPath });
  tabs = switchSourceView(tabs, id, "parsed");
  assert.deepEqual(tabs[1].viewerState, parsedState);
  assert.strictEqual(tabs[0], tabB);
  assert.equal(openSourceTab(tabs, ready).length, 2);
  const replaced = refreshSourceTabs(tabs, [{ ...ready, parsedPath: "/a/new.md" }]);
  assert.equal(replaced[1].viewerState, undefined);
  assert.strictEqual(saveFileViewerState(replaced, id, parsedRevision, parsedState,
    { view: "parsed", path: ready.parsedPath }), replaced);
  const closed = tabs.filter((tab) => tab.id !== id);
  assert.strictEqual(saveFileViewerState(closed, id, parsedRevision, parsedState), closed);
});

test("source identity separates projects and versions and missing originals never substitute parsed text", () => {
  const source = { datasetId: "a", docId: "report", versionNo: 1, fileName: "report.pdf",
    originalPath: null, parsedPath: "/a/report.md" };
  assert.notEqual(sourceTabId(source), sourceTabId({ ...source, datasetId: "b" }));
  assert.notEqual(sourceTabId(source), sourceTabId({ ...source, versionNo: 2 }));
  assert.notEqual(sourceTabId({ ...source, docId: undefined, originalPath: "/a/report.pdf" }),
    sourceTabId({ ...source, docId: undefined, originalPath: "/b/report.pdf" }));
  assert.equal(openSourceTab([], source)[0].filePath, "");
  assert.equal(openSourceTab([], source, "parsed")[0].filePath, source.parsedPath);
});
