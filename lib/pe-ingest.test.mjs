import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./pe-ingest.ts");
}

test("maps a registered dataset to the PE workbench registry and upload area", async (t) => {
  const { resolvePeProjectPaths } = await loadSubject();
  const workbench = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workbench-"));
  t.after(() => fs.rmSync(workbench, { recursive: true, force: true }));
  const workspace = path.join(workbench, "projects");
  const projectRoot = path.join(workspace, "dataset_sungrow");
  fs.mkdirSync(projectRoot, { recursive: true });
  const registryPath = path.join(workbench, "datasets.sqlite3");
  fs.writeFileSync(registryPath, "");

  const paths = resolvePeProjectPaths(
    { datasetId: "dataset_sungrow", root: projectRoot },
    registryPath,
  );
  assert.equal(paths.datasetId, "dataset_sungrow");
  assert.equal(paths.projectPath, fs.realpathSync(projectRoot));
  assert.equal(paths.workspaceRoot, workspace);
  assert.equal(paths.registryPath, registryPath);
  assert.equal(paths.uploadsPath, path.join(workbench, "_uploads", "dataset_sungrow"));
  assert.equal(paths.jobDirectory, path.join(projectRoot, "meta", "ingest-ui-jobs"));
});

test("rejects a registered dataset whose ID does not match its project directory", async (t) => {
  const { resolvePeProjectPaths } = await loadSubject();
  const workbench = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workbench-"));
  t.after(() => fs.rmSync(workbench, { recursive: true, force: true }));
  const projectRoot = path.join(workbench, "projects", "dataset_real");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(workbench, "datasets.sqlite3"), "");

  assert.throws(
    () => resolvePeProjectPaths(
      { datasetId: "dataset_wrong", root: projectRoot },
      path.join(workbench, "datasets.sqlite3"),
    ),
    /dataset ID does not match/u,
  );
});

test("persists and reads a queued job without allowing arbitrary job paths", async (t) => {
  const { findActivePeIngestJob, readPeIngestJob, resolvePeProjectPaths, writeQueuedPeIngestJob } = await loadSubject();
  const workbench = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workbench-"));
  t.after(() => fs.rmSync(workbench, { recursive: true, force: true }));
  const project = path.join(workbench, "projects", "dataset-1");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(workbench, "datasets.sqlite3"), "");
  const paths = resolvePeProjectPaths(
    { datasetId: "dataset-1", root: project },
    path.join(workbench, "datasets.sqlite3"),
  );
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
