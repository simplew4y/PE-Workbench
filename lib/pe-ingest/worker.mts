import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePeDocument } from "@earendil-works/pe-boot";
import type { PeIngestFileResult, PeIngestJob } from "./contracts.ts";
import { failPeIngestJob, readPeIngestJobFile, updatePeIngestJob } from "./jobs.ts";
import {
  ensureDirectoryWithin,
  isPathInside,
  registeredPePdfArtifactPaths,
  resolvePeProjectPathsFromJobFile,
  resolveProjectFile,
  sha256,
  stablePeId,
} from "./paths.ts";
import { processPePdf } from "./pdf/parser.ts";
import {
  commitParsedPeDocument,
  findPeDocumentByFilename,
  findPeDocumentByHash,
  registeredPePdfInput,
  updatePeProjectRegistry,
} from "./repository.ts";
import { assertPeCollectionDataset } from "./schema.ts";

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function cleanupExpiredStaging(stagingRoot: string, currentJobId: string): void {
  const now = Date.now();
  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (entry.name === currentJobId || !/^[a-f0-9]{16}$/u.test(entry.name)) continue;
    const candidate = path.join(stagingRoot, entry.name);
    const metadata = lstatSync(candidate);
    if (now - metadata.mtimeMs < STAGING_MAX_AGE_MS) continue;
    if (metadata.isSymbolicLink()) {
      rmSync(candidate, { force: true });
      continue;
    }
    if (!metadata.isDirectory()) continue;
    const resolved = realpathSync(candidate);
    if (isPathInside(stagingRoot, resolved)) rmSync(resolved, { recursive: true, force: true });
  }
}

function appendResult(job: PeIngestJob, result: PeIngestFileResult): void {
  job.result.files.push(result);
  if (result.status === "created") job.result.createdCount += 1;
  else job.result.failedCount += 1;
}

function failureMessage(error: unknown, fileType?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (fileType === "pdf" && /password|encrypted/iu.test(message)) return "PDF 已加密，暂不支持解析。";
  if (fileType === "pdf" && /InvalidPDF|invalid pdf|header|corrupt|format/iu.test(message)) {
    return "PDF 文件已损坏或格式无效。";
  }
  return message;
}

export async function runPeIngestJob(jobFile: string): Promise<PeIngestJob> {
  const job = readPeIngestJobFile(jobFile);
  const paths = resolvePeProjectPathsFromJobFile(jobFile, job.datasetId);
  assertPeCollectionDataset(paths.collectionPath, paths.datasetId);
  const stagingRoot = ensureDirectoryWithin(paths.metaPath, ".ingest-staging");
  cleanupExpiredStaging(stagingRoot, job.jobId);
  const jobStaging = ensureDirectoryWithin(paths.metaPath, ".ingest-staging", job.jobId);
  ensureDirectoryWithin(paths.metaPath, "documents");
  ensureDirectoryWithin(paths.metaPath, "text");
  const controller = new AbortController();
  const stop = (signalName: string) => controller.abort(new Error(`Document worker received ${signalName}`));
  const onTerm = () => stop("SIGTERM");
  const onInterrupt = () => stop("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInterrupt);
  job.status = "running";
  job.workerPid = process.pid;
  job.heartbeatAt = new Date().toISOString();
  job.startedAt = new Date().toISOString();
  job.message = `正在顺序解析 ${job.files.length} 份文档。`;
  updatePeIngestJob(paths, job);
  const heartbeat = setInterval(() => {
    job.heartbeatAt = new Date().toISOString();
    try {
      updatePeIngestJob(paths, job);
    } catch {
      controller.abort(new Error("Document worker could not update its heartbeat"));
    }
  }, 10_000);
  heartbeat.unref();
  try {
    for (const input of job.files) {
      controller.signal.throwIfAborted();
      try {
        if (path.basename(input.originalFilename) !== input.originalFilename) {
          throw new Error("Invalid document filename in ingest job");
        }
        if (input.fileType === "xlsx" || input.fileType === "xlsm") {
          if (!input.docId) throw new Error("Excel ingest input has no registered document ID");
          const prepared = await preparePeDocument(
            paths.projectPath,
            { docId: input.docId, datasetId: paths.datasetId },
            controller.signal,
          );
          appendResult(job, {
            originalFilename: input.originalFilename,
            docId: input.docId,
            status: "created",
            warnings: prepared.warnings,
            warningCount: prepared.warnings.length,
          });
          job.warnings.push(...prepared.warnings.map((warning) => `${input.originalFilename}: ${warning}`));
          updatePeIngestJob(paths, job);
          continue;
        }

        if (input.registrationKind === "catalog") {
          if (!input.docId) throw new Error("Registered PDF ingest input has no document ID");
          const registered = registeredPePdfInput(paths, input.docId);
          if (registered.originalFilename !== input.originalFilename || registered.rawPath !== input.rawPath
            || registered.sha256 !== input.sha256) throw new Error("Registered PDF input changed after retry was queued");
        } else {
          const existingByName = findPeDocumentByFilename(paths.collectionPath, paths.datasetId, input.originalFilename);
          if (existingByName) throw new Error(`Document filename already exists: ${input.originalFilename}`);
          const existingByHash = findPeDocumentByHash(paths.collectionPath, paths.datasetId, input.sha256);
          if (existingByHash) throw new Error(`The same document content already exists as ${existingByHash.originalFilename}`);
        }
        const rawAbsolutePath = resolveProjectFile(paths, input.rawPath);
        if (sha256(readFileSync(rawAbsolutePath)) !== input.sha256) {
          throw new Error("Raw PDF content changed after upload");
        }
        const docId = input.registrationKind === "catalog" ? input.docId! : stablePeId("doc", paths.datasetId, input.sha256);
        if (input.registrationKind === "catalog") registeredPePdfArtifactPaths(docId, job.jobId);
        const stagingDocumentDirectory = path.join(jobStaging, docId);
        if (existsSync(stagingDocumentDirectory)) {
          const resolved = realpathSync(stagingDocumentDirectory);
          if (!isPathInside(jobStaging, resolved)) throw new Error("Document staging path escapes the job directory");
          rmSync(resolved, { recursive: true, force: true });
        }
        mkdirSync(stagingDocumentDirectory);
        const parsed = await processPePdf({
          datasetId: paths.datasetId,
          originalFilename: input.originalFilename,
          rawPath: input.rawPath,
          rawAbsolutePath,
          sha256: input.sha256,
          stagingDocumentDirectory,
          ...(input.registrationKind === "catalog" ? { registeredDocument: { docId, generation: job.jobId } } : {}),
        });
        controller.signal.throwIfAborted();
        if (sha256(readFileSync(rawAbsolutePath)) !== input.sha256) {
          throw new Error("Raw PDF content changed while it was being parsed");
        }
        commitParsedPeDocument(paths, stagingDocumentDirectory, parsed);
        appendResult(job, {
          originalFilename: input.originalFilename,
          status: "created",
          docId: parsed.docId,
          warningCount: parsed.warnings.length,
          warnings: parsed.warnings,
        });
        job.warnings.push(...parsed.warnings.map((warning) => `${input.originalFilename}: ${warning}`));
      } catch (error) {
        controller.signal.throwIfAborted();
        appendResult(job, {
          originalFilename: input.originalFilename,
          docId: input.docId,
          status: "failed",
          error: failureMessage(error, input.fileType),
        });
      }
      updatePeIngestJob(paths, job);
    }

    try {
      updatePeProjectRegistry(paths);
    } catch (error) {
      job.warnings.push(`项目列表统计更新失败：${failureMessage(error)}`);
    }
    if (job.result.createdCount === 0 && job.result.failedCount > 0) {
      job.status = "failed";
      job.message = `${job.result.failedCount} 份文档均解析失败。`;
    } else if (job.result.failedCount > 0 || job.warnings.length > 0) {
      job.status = "completed_with_warnings";
      job.message = `文档处理完成：${job.result.createdCount} 份成功，${job.result.failedCount} 份失败。`;
    } else {
      job.status = "completed";
      job.message = `文档处理完成：${job.result.createdCount} 份成功。`;
    }
    job.finishedAt = new Date().toISOString();
    updatePeIngestJob(paths, job);
    if (existsSync(jobStaging)) {
      const resolved = realpathSync(jobStaging);
      if (isPathInside(stagingRoot, resolved) && statSync(resolved).isDirectory()) {
        rmSync(resolved, { recursive: true, force: true });
      }
    }
    return job;
  } catch (error) {
    failPeIngestJob(paths, job, failureMessage(error));
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  }
}

function commandJobFile(): string {
  const flagIndex = process.argv.indexOf("--job-file");
  const value = flagIndex >= 0 ? process.argv[flagIndex + 1] : "";
  if (!value) throw new Error("usage: worker.mts --job-file JOB_FILE");
  return path.resolve(value);
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  runPeIngestJob(commandJobFile()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
