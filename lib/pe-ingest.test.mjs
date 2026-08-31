import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./pe-ingest.ts");
}

test("maps a project cwd to the sibling upload area and durable job directory", async (t) => {
  const { resolvePeProjectPaths } = await loadSubject();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workspace-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, "sungrow");
  fs.mkdirSync(project);

  const paths = resolvePeProjectPaths(project);
  assert.equal(paths.datasetId, "sungrow");
  assert.equal(paths.projectPath, fs.realpathSync(project));
  assert.equal(paths.uploadsPath, path.join(workspace, "_uploads", "sungrow"));
  assert.equal(paths.jobDirectory, path.join(project, "meta", "ingest-ui-jobs"));
});

test("rejects a cwd whose basename would change during dataset normalization", async (t) => {
  const { resolvePeProjectPaths } = await loadSubject();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workspace-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, "bad project name");
  fs.mkdirSync(project);

  assert.throws(() => resolvePeProjectPaths(project), /Rename .*bad_project_name/u);
});

test("persists and reads a queued job without allowing arbitrary job paths", async (t) => {
  const { findActivePeIngestJob, readPeIngestJob, resolvePeProjectPaths, writeQueuedPeIngestJob } = await loadSubject();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workspace-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, "dataset-1");
  fs.mkdirSync(project);
  const paths = resolvePeProjectPaths(project);
  const job = {
    jobId: "0123456789abcdef",
    datasetId: "dataset-1",
    status: "queued",
    message: "queued",
    projectPath: project,
  };

  writeQueuedPeIngestJob(paths, job);
  assert.deepEqual(readPeIngestJob(paths, job.jobId), job);
  assert.deepEqual(findActivePeIngestJob(paths), job);
  assert.throws(() => readPeIngestJob(paths, "../secret"), /Invalid ingest job ID/u);
});
