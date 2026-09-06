import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function fixture(t, projectName = "阳光电源研究") {
  const [{ resolvePeProjectPaths }, { createPeProject, peProjectStorePaths }] = await Promise.all([
    jiti.import("./pe-ingest/index.ts"),
    jiti.import("./pe-project-store.ts"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-workbench-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: projectName }, options);
  const registryPath = peProjectStorePaths(options).registryPath;
  return {
    project,
    projectRoot: project.root,
    registryPath,
    paths: resolvePeProjectPaths(project, registryPath),
  };
}

test("maps a registered dataset to canonical project directories", async (t) => {
  const { project, projectRoot, registryPath, paths } = await fixture(t);
  assert.equal(paths.datasetId, project.datasetId);
  assert.equal(paths.projectPath, fs.realpathSync(projectRoot));
  assert.equal(paths.registryPath, registryPath);
  assert.equal(paths.rawPath, path.join(projectRoot, "raw"));
  assert.equal(paths.textPath, path.join(projectRoot, "meta", "text"));
  assert.equal(paths.documentsPath, path.join(projectRoot, "meta", "documents"));
  assert.equal(paths.collectionPath, path.join(projectRoot, "meta", "collection.sqlite3"));
});

test("stores one raw file per filename and rejects same-name uploads", async (t) => {
  const { writePeRawFile } = await jiti.import("./pe-ingest/paths.ts");
  const { paths } = await fixture(t);
  const first = writePeRawFile(paths, "annual-report.pdf", Buffer.from("version one"));

  assert.equal(first.rawPath, "raw/annual-report.pdf");
  assert.throws(
    () => writePeRawFile(paths, "annual-report.pdf", Buffer.from("version one")),
    /filename already exists/u,
  );
  assert.throws(
    () => writePeRawFile(paths, "annual-report.pdf", Buffer.from("version two")),
    /filename already exists/u,
  );
  assert.throws(
    () => writePeRawFile(paths, "ANNUAL-REPORT.PDF", Buffer.from("version three")),
    /filename already exists/u,
  );
});

test("rejects a registered dataset whose ID does not match its project directory", async (t) => {
  const { resolvePeProjectPaths } = await jiti.import("./pe-ingest/index.ts");
  const { project, projectRoot, registryPath } = await fixture(t, "真实项目");
  assert.throws(
    () => resolvePeProjectPaths({ datasetId: `${project.datasetId}_wrong`, root: projectRoot }, registryPath),
    /dataset does not match/u,
  );
});

test("persists queued jobs without allowing arbitrary job paths", async (t) => {
  const { createPeIngestJob, findActivePeIngestJob, newPeIngestJob, readPeIngestJob } = await jiti.import("./pe-ingest/jobs.ts");
  const { paths } = await fixture(t, "dataset_job");
  const job = newPeIngestJob(paths.datasetId);
  createPeIngestJob(paths, job);
  assert.deepEqual(readPeIngestJob(paths, job.jobId), job);
  assert.deepEqual(findActivePeIngestJob(paths), job);
  assert.throws(() => readPeIngestJob(paths, "../secret"), /Invalid ingest job ID/u);
});

test("requires PDF extension, MIME, and magic bytes", async () => {
  const { validatePePdfUpload } = await jiti.import("./pe-ingest/index.ts");
  assert.equal(validatePePdfUpload({
    filename: "report.pdf",
    mimeType: "application/pdf",
    content: Buffer.from("%PDF-1.7"),
  }), null);
  assert.match(validatePePdfUpload({
    filename: "report.txt",
    mimeType: "application/pdf",
    content: Buffer.from("%PDF-1.7"),
  }), /Unsupported/u);
  assert.match(validatePePdfUpload({
    filename: "report.pdf",
    mimeType: "text/plain",
    content: Buffer.from("%PDF-1.7"),
  }), /MIME/u);
  assert.match(validatePePdfUpload({
    filename: "report.pdf",
    mimeType: "application/pdf",
    content: Buffer.from("plain text"),
  }), /header/u);
});

test("rejects project-relative traversal and symlinks that escape the workspace", async (t) => {
  const { ensureDirectoryWithin, resolveProjectFile } = await jiti.import("./pe-ingest/paths.ts");
  const { paths } = await fixture(t, "dataset_paths");
  assert.throws(() => resolveProjectFile(paths, "raw/../meta/collection.sqlite3"), /Invalid project-relative/u);
  if (process.platform === "win32") return;

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, "outside.pdf");
  fs.writeFileSync(outsideFile, "%PDF-1.7");
  fs.symlinkSync(outsideFile, path.join(paths.rawPath, "escape.pdf"));
  assert.throws(() => resolveProjectFile(paths, "raw/escape.pdf"), /escapes/u);
  fs.symlinkSync(outside, path.join(paths.metaPath, "escape-dir"));
  assert.throws(() => ensureDirectoryWithin(paths.metaPath, "escape-dir"), /escapes/u);
});
