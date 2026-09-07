import { NextRequest, NextResponse } from "next/server";
import { queuePeExcelRetry } from "@/lib/pe-ingest";
import { getPeProject, peProjectStorePaths } from "@/lib/pe-project-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const body = await request.json() as { datasetId?: string; filename?: string };
    const datasetId = body.datasetId?.trim() ?? "";
    const filename = body.filename?.trim() ?? "";
    if (!datasetId || !filename) {
      return NextResponse.json({ error: "datasetId and filename are required" }, { status: 400 });
    }
    const project = getPeProject(datasetId);
    const job = queuePeExcelRetry(project, peProjectStorePaths().registryPath, filename);
    return NextResponse.json({ job, project }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|required/iu.test(message) ? 400 : /正在运行|already/iu.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
