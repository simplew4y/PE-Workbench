import assert from "node:assert/strict";
import { test } from "node:test";
import { createIterationLoader, createIterationSubmission, defaultIterationRun, iterationNextStep, mergeIterationHistory } from "./framework-iteration-workspace.ts";

test("default selects newest pending or active run, not newest completed run", () => {
  const runs = [
    { id: "done", status: "published", createdAt: "2026-10-12" },
    { id: "review", status: "review_required", createdAt: "2026-10-11" },
    { id: "running", status: "running", createdAt: "2026-10-10" },
  ];
  assert.equal(defaultIterationRun(runs), "review");
  assert.equal(defaultIterationRun([runs[0]]), "done");
  assert.equal(defaultIterationRun([]), "");
  assert.equal(runs[0].id, "done");
});

test("concurrent polling and refresh share one request", async () => {
  const loader = createIterationLoader();
  const response = Promise.withResolvers();
  let calls = 0;
  const applied = [];
  const read = () => { calls++; return response.promise; };
  const first = loader.load("dataset/run", read, value => applied.push(value), assert.fail);
  const second = loader.load("dataset/run", read, value => applied.push(value), assert.fail);
  assert.equal(first, second);
  response.resolve("result");
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(applied, ["result"]);
});

for (const nextKey of ["other-dataset/run", "dataset/other-run"]) {
  test(`late response cannot overwrite ${nextKey}`, async () => {
    const loader = createIterationLoader();
    const old = Promise.withResolvers();
    const applied = [];
    let oldSignal;
    const pending = loader.load("dataset/run", signal => { oldSignal = signal; return old.promise; }, value => applied.push(value), assert.fail);
    await Promise.resolve();
    await loader.load(nextKey, async () => "new", value => applied.push(value), assert.fail);
    assert.equal(oldSignal.aborted, true);
    old.resolve("old");
    await pending;
    assert.deepEqual(applied, ["new"]);
  });
}

test("invalidated read cannot surface stale failures or clear a newer request", async () => {
  const loader = createIterationLoader();
  const old = Promise.withResolvers();
  const next = Promise.withResolvers();
  const pending = loader.load("same", () => old.promise, assert.fail, assert.fail);
  await Promise.resolve();
  loader.invalidate();
  const current = loader.load("same", () => next.promise, () => {}, assert.fail);
  old.reject(new Error("stale error"));
  await pending;
  assert.equal(loader.load("same", assert.fail, assert.fail, assert.fail), current);
  next.resolve("new");
  await current;
});

test("network retries retain the exact request identity and frozen baseline", () => {
  const submission = createIterationSubmission();
  const first = submission.prepare(requestId => ({ requestId, basisVersionId: "v1", files: ["report.pdf"] }));
  const retry = submission.prepare(() => ({ basisVersionId: "v2" }));
  assert.equal(retry, first);
  assert.equal(retry.payload.basisVersionId, "v1");
  submission.clear();
  const next = submission.prepare(requestId => ({ requestId, basisVersionId: "v2" }));
  assert.notEqual(next.requestId, first.requestId);
});

test("next steps distinguish review, recovery, no change and successful delivery", () => {
  assert.match(iterationNextStep("review_required").title, /审查/);
  assert.match(iterationNextStep("blocked").detail, /检查点/);
  assert.match(iterationNextStep("no_change").detail, /不等于没有风险/);
  assert.match(iterationNextStep("published").title, /发布结果/);
});

test("history deduplicates pages, preserves refreshed statuses and retains older cursor during polling", () => {
  const recent = { id: "recent", createdAt: "2026-10-12", status: "published" };
  const old = { id: "old", createdAt: "2026-10-10", status: "failed" };
  let history = mergeIterationHistory(null, "project", { runs: [recent], nextCursor: "recent" }, "snapshot");
  history = mergeIterationHistory(history, "project", { runs: [{ ...recent, status: "running" }, old], nextCursor: "old" }, "older");
  assert.equal(history.runs.length, 2);
  assert.equal(history.runs[0].status, "published");
  history = mergeIterationHistory(history, "project", { runs: [{ id: "new", createdAt: "2026-10-13", status: "running" }, recent], nextCursor: "recent" }, "snapshot");
  assert.deepEqual(history.runs.map(run => run.id), ["new", "recent", "old"]);
  assert.equal(history.nextCursor, "old");
  history = mergeIterationHistory(history, "project", { runs: [{ ...old, status: "published" }], nextCursor: "recent" }, "snapshot");
  assert.equal(history.runs[2].status, "published");
  assert.equal(history.nextCursor, "old");
});

test("exhausted history does not reopen on polling and another project starts fresh", () => {
  const run = { id: "run", createdAt: "2026-10-12", status: "published" };
  let history = mergeIterationHistory(null, "project", { runs: [run], nextCursor: "run" }, "snapshot");
  history = mergeIterationHistory(history, "project", { runs: [], nextCursor: null }, "older");
  history = mergeIterationHistory(history, "project", { runs: [run], nextCursor: "run" }, "snapshot");
  assert.equal(history.nextCursor, null);
  const other = mergeIterationHistory(history, "other", { runs: [], nextCursor: null }, "snapshot");
  assert.deepEqual(other.runs, []);
  assert.equal(other.paged, false);
  assert.equal(mergeIterationHistory(other, "project", { runs: [run], nextCursor: "run" }, "older"), other);
});
