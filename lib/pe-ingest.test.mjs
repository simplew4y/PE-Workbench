import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./pe-ingest.ts");
}

test("maps a registered dataset to its canonical raw directory", async (t) => {
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
  assert.equal(paths.rawPath, path.join(projectRoot, "raw"));
  assert.equal(paths.jobDirectory, path.join(projectRoot, "meta", "ingest-ui-jobs"));
});

test("stores raw files once and preserves same-name content changes", async (t) => {
  const { writePeRawFile } = await loadSubject();
  const rawPath = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-raw-"));
  t.after(() => fs.rmSync(rawPath, { recursive: true, force: true }));

  const first = writePeRawFile(rawPath, "annual-report.pdf", Buffer.from("version one"));
  const duplicate = writePeRawFile(rawPath, "annual-report.pdf", Buffer.from("version one"));
  const changed = writePeRawFile(rawPath, "annual-report.pdf", Buffer.from("version two"));

  assert.equal(first.path, path.join(rawPath, "annual-report.pdf"));
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.path, first.path);
  assert.equal(duplicate.duplicate, true);
  assert.match(changed.path, /annual-report_[a-f0-9]{8}\.pdf$/u);
  assert.equal(changed.duplicate, false);
  assert.equal(fs.readFileSync(first.path, "utf8"), "version one");
  assert.equal(fs.readFileSync(changed.path, "utf8"), "version two");
  assert.deepEqual(fs.readdirSync(rawPath).sort(), [path.basename(changed.path), "annual-report.pdf"].sort());
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

test("parses identifier JSON when a PDF dependency writes a warning to stdout", async () => {
  const { parsePeUploadIdentificationOutput } = await loadSubject();
  const payload = { groups: [], failed: [] };
  assert.deepEqual(
    parsePeUploadIdentificationOutput(
      `warning: The fitz API is deprecated\n${JSON.stringify(payload)}\n`,
    ),
    payload,
  );
});
