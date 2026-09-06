import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const compiledWorker = path.resolve("dist/pe-ingest/worker.mjs");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

function minimalTextPdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("processes each job file independently and keeps successful documents", {
  skip: !fs.existsSync(compiledWorker),
}, async (t) => {
  const [{ createPeProject, peProjectStorePaths }, ingest, jobs, pathsModule, worker] = await Promise.all([
    jiti.import("../pe-project-store.ts"),
    jiti.import("./index.ts"),
    jiti.import("./jobs.ts"),
    jiti.import("./paths.ts"),
    import(compiledWorker),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "Worker test" }, options);
  const projectPaths = ingest.resolvePeProjectPaths(project, peProjectStorePaths(options).registryPath);
  const valid = pathsModule.writePeRawFile(
    projectPaths,
    "valid.pdf",
    minimalTextPdf("Revenue and operating profit increased during the year."),
  );
  const broken = pathsModule.writePeRawFile(
    projectPaths,
    "broken.pdf",
    Buffer.from("%PDF-1.7 broken document"),
  );
  const job = jobs.newPeIngestJob(project.datasetId);
  job.files.push(
    { originalFilename: "valid.pdf", rawPath: valid.rawPath, sha256: valid.sha256 },
    { originalFilename: "broken.pdf", rawPath: broken.rawPath, sha256: broken.sha256 },
  );
  const jobFile = jobs.createPeIngestJob(projectPaths, job);

  const result = await worker.runPeIngestJob(jobFile);
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(result.result.createdCount, 1);
  assert.equal(result.result.failedCount, 1);
  assert.equal(result.result.files[0].status, "created");
  assert.equal(result.result.files[1].status, "failed");
  assert.equal(fs.existsSync(path.join(
    project.root,
    "meta/text/valid.md",
  )), true);
  assert.equal(fs.existsSync(path.join(project.root, "meta/documents/valid/layout.json")), true);

  const collection = new DatabaseSync(projectPaths.collectionPath, { readOnly: true });
  try {
    assert.equal(collection.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 1);
    assert.equal(collection.prepare("SELECT COUNT(*) AS count FROM pdf_pages").get().count, 1);
  } finally {
    collection.close();
  }
  const registry = new DatabaseSync(peProjectStorePaths(options).registryPath, { readOnly: true });
  try {
    const row = registry.prepare(
      "SELECT status, file_count FROM datasets WHERE dataset_id = ?",
    ).get(project.datasetId);
    assert.deepEqual({ status: row.status, file_count: row.file_count }, { status: "ready", file_count: 1 });
  } finally {
    registry.close();
  }
  assert.equal(fs.existsSync(path.join(project.root, "meta", ".ingest-staging", job.jobId)), false);
});
