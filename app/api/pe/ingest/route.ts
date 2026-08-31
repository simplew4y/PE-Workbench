import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateUploadFileNames } from "@/lib/file-upload";
import {
  PE_SUPPORTED_EXTENSIONS,
  findActivePeIngestJob,
  resolvePeProjectPaths,
  startPeIngestJob,
  writeQueuedPeIngestJob,
  type PeIngestJob,
} from "@/lib/pe-ingest";
import { getPeProject, peProjectStorePaths } from "@/lib/pe-project-store";
import { isApiRequestAllowed } from "@/lib/request-security";

const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const form = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    const datasetId = textField(form, "datasetId").trim();
    if (!datasetId) return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    const project = getPeProject(datasetId);
    const cwd = textField(form, "cwd").trim();
    if (cwd && fs.realpathSync(cwd) !== fs.realpathSync(project.root)) {
      return NextResponse.json({ error: "Project identity does not match cwd" }, { status: 409 });
    }

    const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) return NextResponse.json({ error: "files are required" }, { status: 400 });
    const names = files.map((file) => file.name);
    const nameError = validateUploadFileNames(names);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each research file must be 100MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Research uploads must total 300MB or less" }, { status: 413 });
    }

    const unsupported = names.filter((name) => !PE_SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()));
    if (unsupported.length > 0) {
      return NextResponse.json({ error: `Unsupported research file: ${unsupported[0]}` }, { status: 400 });
    }

    const paths = resolvePeProjectPaths(project, peProjectStorePaths().registryPath);
    const activeJob = findActivePeIngestJob(paths);
    if (activeJob) {
      return NextResponse.json(
        { error: "A research indexing job is already running for this project", job: activeJob },
        { status: 409 },
      );
    }
    fs.mkdirSync(paths.uploadsPath, { recursive: true });
    for (const file of files) {
      const target = path.join(paths.uploadsPath, file.name);
      const temporary = path.join(paths.uploadsPath, `.${file.name}.${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      fs.renameSync(temporary, target);
    }

    const jobId = crypto.randomBytes(8).toString("hex");
    const job: PeIngestJob = {
      jobId,
      datasetId: paths.datasetId,
      status: "queued",
      message: "资料已上传，等待解析。",
      projectPath: paths.projectPath,
      createdAt: new Date().toISOString(),
    };
    writeQueuedPeIngestJob(paths, job);
    startPeIngestJob(paths, job, {
      datasetName: project.name,
      companyName: project.companyName,
      companyTicker: project.companyTicker,
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Research upload request is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
