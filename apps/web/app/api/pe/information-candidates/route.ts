import { NextResponse } from "next/server";
import {
  getResearchMonitor,
  ingestOfficialFilingCandidate,
  requestResearchMonitorRun,
  type OfficialFilingCandidate,
} from "@earendil-works/pe-boot";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ensureResearchMonitorWorker } from "@/lib/research-monitor-worker";
import { assertPeUserPathAllowed } from "@/lib/pe-multi-user-paths";
import { getPeProject } from "@/lib/pe-project-store";
import { isAuthorizedInformationDelivery } from "@/lib/information-candidate-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  const message = error instanceof Error ? error.message : "Candidate ingestion failed";
  const status = /not found/iu.test(message) ? 404 : /invalid|unsupported|required|hash|must/iu.test(message) ? 400 : 500;
  if (status === 500) console.error("Financial information candidate ingestion failed", error);
  return NextResponse.json({ error: status === 500 ? "Candidate ingestion failed" : message }, { status });
}

export async function POST(request: Request) {
  try {
    if (!isAuthorizedInformationDelivery(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      return NextResponse.json({ error: "multipart/form-data required" }, { status: 415 });
    }
    const form = await parseFormDataWithinLimit(request, 52 * 1024 * 1024);
    const metadataValue = form.get("metadata");
    const file = form.get("file");
    if (typeof metadataValue !== "string" || !(file instanceof File)) {
      return NextResponse.json({ error: "metadata and file are required" }, { status: 400 });
    }
    const metadata: unknown = JSON.parse(metadataValue);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return NextResponse.json({ error: "Invalid candidate metadata" }, { status: 400 });
    }
    const candidate = metadata as OfficialFilingCandidate;
    const project = getPeProject(candidate.datasetId);
    assertPeUserPathAllowed(project.root);
    const ingested = await ingestOfficialFilingCandidate(
      project.root,
      candidate,
      new Uint8Array(await file.arrayBuffer()),
      request.signal,
    );
    const monitor = getResearchMonitor(project.root, project.datasetId);
    let triggered = false;
    if (monitor.config?.enabled) {
      requestResearchMonitorRun(project.root, project.datasetId);
      await ensureResearchMonitorWorker(project.root, project.datasetId);
      triggered = true;
    }
    return NextResponse.json({ ingested, triggered, reviewRequired: true }, { status: 202 });
  } catch (error) {
    return failure(error);
  }
}
