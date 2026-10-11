import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { excelPython, registerPeDocuments } from "@earendil-works/pe-boot";
import { createJiti } from "jiti";

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

function minimalWorkbook(root) {
  const workbookPath = path.join(root, "worker-fixture.xlsx");
  const script = [
    "import sys",
    "from openpyxl import Workbook",
    "wb=Workbook()",
    "ws=wb.active",
    "ws.title='Forecast'",
    "ws['A1']='Revenue'",
    "ws['B1']=100",
    "ws['B2']='=B1*2'",
    "wb.save(sys.argv[1])",
  ].join(";");
  const created = spawnSync(excelPython(), ["-c", script, workbookPath], { encoding: "utf8" });
  if (created.status !== 0) throw new Error(created.stderr || "Unable to create Excel fixture");
  return fs.readFileSync(workbookPath);
}

test("processes a mixed PDF and Excel job independently", async (t) => {
  const [{ createPeProject, peProjectStorePaths }, ingest, jobs, pathsModule, worker] = await Promise.all([
    jiti.import("../pe-project-store.ts"),
    jiti.import("./index.ts"),
    jiti.import("./jobs.ts"),
    jiti.import("./paths.ts"),
    jiti.import("./worker.mts"),
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
  const workbookBytes = minimalWorkbook(root);
  assert.equal(ingest.validatePeResearchUpload({
    filename: "model.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: workbookBytes,
  }), null);
  const registered = registerPeDocuments(project.root, project.datasetId, [{
    name: "model.xlsx",
    bytes: workbookBytes,
  }]);
  const excelDocument = registered.documents[0];
  const job = jobs.newPeIngestJob(project.datasetId);
  job.parseOnly = true;
  job.files.push(
    { originalFilename: "valid.pdf", rawPath: valid.rawPath, sha256: valid.sha256, fileType: "pdf" },
    { originalFilename: "broken.pdf", rawPath: broken.rawPath, sha256: broken.sha256, fileType: "pdf" },
    {
      originalFilename: "model.xlsx",
      rawPath: String(excelDocument.raw_path),
      sha256: String(excelDocument.sha256),
      docId: String(excelDocument.doc_id),
      fileType: "xlsx",
    },
  );
  const jobFile = jobs.createPeIngestJob(projectPaths, job);

  const result = await worker.runPeIngestJob(jobFile);
  assert.equal(result.status, "completed_with_warnings");
  assert.equal(result.result.createdCount, 2);
  assert.equal(result.result.failedCount, 1);
  assert.equal(result.result.analysis, undefined);
  assert.equal(result.result.files[0].status, "created");
  assert.equal(result.result.files[1].status, "failed");
  assert.equal(result.result.files[2].status, "created");
  assert.equal(fs.existsSync(path.join(
    project.root,
    "meta/text/valid.md",
  )), true);
  assert.equal(fs.existsSync(path.join(project.root, "meta/documents/valid/layout.json")), true);

  const collection = new DatabaseSync(projectPaths.collectionPath, { readOnly: true });
  try {
    const cache = collection.prepare("SELECT cache_path, readable_path FROM document_cache WHERE doc_id = ?").get(excelDocument.doc_id);
    assert.equal(fs.existsSync(path.join(project.root, path.dirname(cache.cache_path), "navigation.json")), true);
    assert.equal(fs.existsSync(path.join(project.root, cache.readable_path)), true);
    assert.equal(collection.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 2);
    assert.equal(collection.prepare("SELECT COUNT(*) AS count FROM pdf_pages").get().count, 1);
    assert.equal(collection.prepare("SELECT COUNT(*) AS count FROM excel_cells").get().count, 0);
  } finally {
    collection.close();
  }
  const registry = new DatabaseSync(peProjectStorePaths(options).registryPath, { readOnly: true });
  try {
    const row = registry.prepare(
      "SELECT status, file_count FROM datasets WHERE dataset_id = ?",
    ).get(project.datasetId);
    assert.deepEqual({ status: row.status, file_count: row.file_count }, { status: "ready", file_count: 2 });
  } finally {
    registry.close();
  }
  assert.equal(fs.existsSync(path.join(project.root, "meta", ".ingest-staging", job.jobId)), false);
});

test("transcribes audio with a mocked ASR stream and skips claim analysis", async (t) => {
  const [{ createPeProject, peProjectStorePaths }, ingest, jobs, pathsModule, worker] = await Promise.all([
    jiti.import("../pe-project-store.ts"),
    jiti.import("./index.ts"),
    jiti.import("./jobs.ts"),
    jiti.import("./paths.ts"),
    jiti.import("./worker.mts"),
  ]);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response([
    'data: {"type": "result", "segment": 0, "total": 1, "start_time": "00:00:00", "end_time": "00:00:01", "text": "上海收入增长", "language": "Chinese"}',
    'data: {"type": "done", "total_segments": 1, "total_text": "上海收入增长"}',
    "",
  ].join("\n"), { headers: { "content-type": "text/event-stream" } });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ingest-asr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { agentDir: path.join(root, "agent") };
  const project = createPeProject({ name: "ASR worker" }, options);
  const projectPaths = ingest.resolvePeProjectPaths(project, peProjectStorePaths(options).registryPath);
  const wav = Buffer.alloc(64, 0);
  wav.write("RIFF", 0);
  wav.write("WAVE", 8);
  const stored = pathsModule.writePeRawFile(projectPaths, "call.wav", wav);
  const job = jobs.newPeIngestJob(project.datasetId);
  job.parseOnly = true;
  job.asr = { serverUrl: "https://asr.example.test", maxChunkSeconds: 600, language: "" };
  job.files.push({
    originalFilename: "call.wav",
    rawPath: stored.rawPath,
    sha256: stored.sha256,
    fileType: "wav",
  });
  const result = await worker.runPeIngestJob(jobs.createPeIngestJob(projectPaths, job));
  assert.equal(result.status, "completed");
  assert.equal(result.result.createdCount, 1);
  assert.equal(result.result.analysis, undefined);
  const markdown = fs.readFileSync(path.join(project.root, "meta/text", `${result.result.files[0].docId}.md`), "utf8");
  assert.match(markdown, /上海收入增长/u);
  const collection = new DatabaseSync(projectPaths.collectionPath, { readOnly: true });
  try {
    const row = collection.prepare("SELECT file_type, parser_name, status FROM documents WHERE original_filename = 'call.wav'").get();
    assert.equal(row?.file_type, "wav");
    assert.equal(row?.parser_name, "qwen3-asr");
    assert.equal(row?.status, "completed");
  } finally {
    collection.close();
  }
});

for (const [name, events] of [
  ["connection closes before done", [{type:"result",segment:0,total:2,text:"第一段"}]],
  ["completion omits a segment", [{type:"result",segment:0,total:2,text:"第一段"},{type:"done",total_segments:2,total_text:"第一段"}]],
]) {
  test(`does not publish audio when ${name}`, async (t) => {
    const [{createPeProject,peProjectStorePaths},ingest,jobs,pathsModule,worker] = await Promise.all([
      jiti.import("../pe-project-store.ts"),jiti.import("./index.ts"),jiti.import("./jobs.ts"),
      jiti.import("./paths.ts"),jiti.import("./worker.mts"),
    ]);
    const originalFetch=globalThis.fetch;
    t.after(()=>{globalThis.fetch=originalFetch;});
    globalThis.fetch=async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}`).join("\n")+"\n");
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"pe-audio-incomplete-"));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const options={agentDir:path.join(root,"agent")};
    const project=createPeProject({name:"Incomplete audio"},options);
    const paths=ingest.resolvePeProjectPaths(project,peProjectStorePaths(options).registryPath);
    const stored=pathsModule.writePeRawFile(paths,"call.wav",Buffer.from("RIFF....WAVE"));
    const job=jobs.newPeIngestJob(project.datasetId);
    job.asr={serverUrl:"https://fixture.invalid",maxChunkSeconds:600,language:""};
    job.files.push({originalFilename:"call.wav",rawPath:stored.rawPath,sha256:stored.sha256,fileType:"wav"});
    const result=await worker.runPeIngestJob(jobs.createPeIngestJob(paths,job));
    assert.equal(result.status,"failed");
    assert.match(result.result.files[0].error,/转写不完整/u);
    const db=new DatabaseSync(paths.collectionPath,{readOnly:true});
    try {assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents").get().count,0);}
    finally {db.close();}
    assert.deepEqual(fs.readdirSync(path.join(project.root,"meta/text")),[]);
  });
}
