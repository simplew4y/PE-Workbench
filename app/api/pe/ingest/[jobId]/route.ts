import { NextRequest, NextResponse } from "next/server";
import { readPeIngestJob, resolvePeProjectPaths } from "@/lib/pe-ingest";
import { getPeProject, peProjectStorePaths } from "@/lib/pe-project-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const datasetId = request.nextUrl.searchParams.get("datasetId")?.trim() ?? "";
    if (!datasetId) return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    const project = getPeProject(datasetId);
    const { jobId } = await params;
    const paths = resolvePeProjectPaths(project, peProjectStorePaths().registryPath);
    return NextResponse.json({ job: readPeIngestJob(paths, jobId) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? "Ingest job not found" : error instanceof Error ? error.message : String(error) },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
}
