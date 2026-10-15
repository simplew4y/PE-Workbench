import assert from "node:assert/strict";
import test from "node:test";
import { isSelectableSource, selectedSourceScope, sourceScopeMessage, sourceSelectionKey } from "./pe-source-selection.ts";

test("selection defaults to available sources, preserves explicit empty selection, and pins versions", () => {
  const ready = { docId: "one", filename: "Annual.pdf", versionNo: 1, status: "completed",
    isCurrent: true, needsOcrPageCount: 0, warningCount: 0, pageCount: 2 };
  const documents = [ready, { ...ready, docId: "two", status: "running" },
    { ...ready, docId: "three", needsOcrPageCount: 1 },
    { ...ready, docId: "old", isCurrent: false }];
  assert.equal(selectedSourceScope("a", documents).documents.length, 3);
  assert.equal(selectedSourceScope("a", documents, []).documents.length, 0);
  const keys = [sourceSelectionKey(ready)];
  assert.equal(selectedSourceScope("a", [...documents, { ...ready, docId: "new" }], keys).documents.length, 1);
  assert.equal(selectedSourceScope("a", [{ ...ready, versionNo: 2 }], keys).documents.length, 0);
  assert.equal(isSelectableSource({ ...ready, status: "completed_with_warnings" }), true);
  for (const status of ["queued", "running", "failed", "completed_with_warnings"]) {
    assert.equal(isSelectableSource({ ...ready, status, warningCount: 1, pageCount: 0 }), true);
  }
  const pending = { filename: "Pending.pdf", rawRelativePath: "raw/Pending.pdf", status: "queued" };
  const pendingScope = selectedSourceScope("a", [pending]);
  assert.equal(pendingScope.documents.length, 1);
  assert.equal(sourceSelectionKey(pendingScope.documents[0]), sourceSelectionKey(pending));
  const snapshot = selectedSourceScope("a", documents, keys);
  ready.filename = "Changed.pdf";
  assert.equal(snapshot.documents[0].filename, "Annual.pdf");
  assert.match(sourceScopeMessage("Question", snapshot), /使用 1 份资料/);
  assert.match(sourceScopeMessage("Question", { datasetId: "a", documents: [] }), /不使用项目来源检索/);
  assert.doesNotMatch(sourceScopeMessage("Question", { datasetId: "a",
    documents: [{ docId: "x", versionNo: 1, filename: "<script>unsafe</script>" }] }), /<script>/);
});
