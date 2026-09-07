import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateUploadFileNames } from "@/lib/file-upload";
import {
  PE_SUPPORTED_EXTENSIONS,
  queuePeIngest,
  type PeResearchUpload,
} from "@/lib/pe-ingest";
import { getPeProject, peProjectStorePaths } from "@/lib/pe-project-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024;

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function requestErrorStatus(message: string): number {
  if (/already running|已有.+任务正在运行/iu.test(message)) return 409;
  if (/already exists|selected twice|duplicate document filename/iu.test(message)) return 409;
  if (/Legacy .*Pipeline|Legacy documents table|schema version/iu.test(message)) return 409;
  if (/required|not found|unsupported|invalid pdf|MIME|file name/iu.test(message)) return 400;
  return 500;
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const form = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    const datasetId = textField(form, "datasetId").trim();
    if (!datasetId) {
      return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    }
    const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) return NextResponse.json({ error: "files are required" }, { status: 400 });
    const names = files.map((file) => file.name);
    const nameError = validateUploadFileNames(names);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each document must be 100MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Document uploads must total 300MB or less" }, { status: 413 });
    }
    const unsupported = files.find((file) => (
      !PE_SUPPORTED_EXTENSIONS.has(path.extname(file.name).toLocaleLowerCase())
    ));
    if (unsupported) {
      return NextResponse.json({ error: `Only PDF, XLSX, and XLSM files are supported: ${unsupported.name}` }, { status: 400 });
    }

    const uploads: PeResearchUpload[] = [];
    for (const file of files) {
      uploads.push({
        filename: file.name,
        mimeType: file.type,
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
    const project = getPeProject(datasetId);
    const job = queuePeIngest({
      project,
      registryPath: peProjectStorePaths().registryPath,
      uploads,
    });
    return NextResponse.json({ job, project }, { status: job.status === "completed" ? 200 : 202 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Document upload request is too large" }, { status: 413 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: requestErrorStatus(message) });
  }
}
