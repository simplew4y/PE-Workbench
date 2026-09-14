import { frameworkReportMarkdown } from "@/lib/framework-report";
import { NextResponse } from "next/server";
import {
  cancelResearchJob, createResearchDraft, enqueueResearchJob, getResearchFramework,
  listResearchJobs, publishResearchDraft, ResearchError, restoreResearchVersion, updateResearchDraft,
  listPeMemoHistory, getPeMemoVersion,
  listResearchContinuations,
  getResearchMonitor, saveResearchMonitor, requestResearchMonitorRun,
} from "@earendil-works/pe-boot";
import { getPeProject } from "@/lib/pe-project-store";
import { assertPeUserPathAllowed } from "@/lib/pe-multi-user-paths";
import { peStorageErrorResponse } from "@/lib/pe-storage-errors";
import { continueResearch, validateResearchSession } from "@/lib/research-continuation";
import { ensureResearchMonitorWorker } from "@/lib/research-monitor-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_000) throw new ResearchError(400, `${name} is required`);
  return value;
}
function expected(value: unknown): string | null {
  if (value === null) return null;
  return text(value, "expectedVersionId");
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string")) throw new ResearchError(400, "Invalid selection");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ResearchError(400, "Invalid draft revision");
  return value;
}
function failure(error: unknown): Response {
  if (error instanceof ResearchError) return NextResponse.json({ error: error.message }, { status: error.status });
  const storage = peStorageErrorResponse(error);
  if (storage) return storage;
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  console.error("Research request failed", error);
  return NextResponse.json({ error: "Unable to access project research" }, { status: 500 });
}
function projectFor(value: unknown) {
  const project = getPeProject(text(value, "datasetId"));
  assertPeUserPathAllowed(project.root);
  return project;
}

export async function GET(request: Request) {
  try {
    const project = projectFor(new URL(request.url).searchParams.get("datasetId"));
    const framework = getResearchFramework(project.root, project.datasetId);
    const downloadId = new URL(request.url).searchParams.get("download");
    if (downloadId !== null) {
      const version = framework.versions.find((entry) => entry.id === downloadId);
      if (!version) throw new ResearchError(404, "Framework version not found");
      return new Response(frameworkReportMarkdown(version.content), { headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="investment-framework-v${version.version}.md"`,
        "Cache-Control": "no-store",
      } });
    }
    const history = listPeMemoHistory(project.root, { datasetId: project.datasetId });
    const memos = history.series.flatMap((series) => series.current_memo_version_id
      ? [getPeMemoVersion(project.root, series.current_memo_version_id, project.datasetId)] : []);
    return NextResponse.json({ framework, memos, monitor: getResearchMonitor(project.root, project.datasetId), continuations: listResearchContinuations(project.root, project.datasetId), jobs: listResearchJobs(project.root, project.datasetId) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError(400, "Invalid request");
    const input = body as Record<string, unknown>;
    const { root, datasetId } = projectFor(input.datasetId);
    switch (input.action) {
      case "monitor-save": {
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new ResearchError(400, "Invalid monitor revision");
        saveResearchMonitor(root, datasetId, input.config, Number(input.revision));
        await ensureResearchMonitorWorker(root, datasetId);
        return NextResponse.json({ monitor: getResearchMonitor(root, datasetId) });
      }
      case "monitor-run":
        requestResearchMonitorRun(root, datasetId);
        await ensureResearchMonitorWorker(root, datasetId);
        return NextResponse.json({ monitor: getResearchMonitor(root, datasetId) }, { status: 202 });
      case "continue":
        return NextResponse.json({ continuation: await continueResearch(root, datasetId, text(input.versionId, "versionId")) });
      case "confirm": {
        const draftId = text(input.draftId, "draftId");
        const rev = revision(input.revision);
        const sessionId = text(input.sessionId, "sessionId");
        const toolCallId = text(input.toolCallId, "toolCallId");
        await validateResearchSession(root, { datasetId, draftId, revision: rev, toolCallId }, sessionId);
        const version = publishResearchDraft(root, datasetId, {
          draftId, revision: rev, expectedVersionId: expected(input.expectedVersionId),
          requestId: `confirm_${draftId}_${rev}`, continuation: { sessionId, toolCallId },
        });
        return NextResponse.json({ version, continuation: listResearchContinuations(root, datasetId).find((item) => item.versionId === version.id) });
      }
      case "generate":
        return NextResponse.json({ job: enqueueResearchJob(root, datasetId, text(input.objective, "objective"), strings(input.docIds), text(input.requestId, "requestId"), expected(input.expectedVersionId)) }, { status: 202 });
      case "create":
        return NextResponse.json({ draft: createResearchDraft(root, datasetId, input.content, strings(input.docIds), expected(input.expectedVersionId)) }, { status: 201 });
      case "save":
      case "reject":
        return NextResponse.json({ draft: updateResearchDraft(root, datasetId, text(input.draftId, "draftId"), revision(input.revision), input.content, input.action === "reject") });
      case "publish":
        return NextResponse.json({ version: publishResearchDraft(root, datasetId, {
          draftId: text(input.draftId, "draftId"), revision: revision(input.revision), expectedVersionId: expected(input.expectedVersionId), requestId: text(input.requestId, "requestId"),
          ...(input.selectedItemIds === undefined ? {} : { selectedItemIds: strings(input.selectedItemIds) }),
        }) });
      case "restore":
        return NextResponse.json({ draft: restoreResearchVersion(root, datasetId, text(input.versionId, "versionId"), expected(input.expectedVersionId)) });
      case "cancel":
        cancelResearchJob(root, datasetId, text(input.jobId, "jobId"));
        return NextResponse.json({ cancelled: true });
      default: throw new ResearchError(400, "Unknown research action");
    }
  } catch (error) { return failure(error); }
}
