import { NextRequest, NextResponse } from "next/server";
import { queuePeExcelRetry } from "@/lib/pe-ingest";
import { getPeProject, peProjectStorePaths } from "@/lib/pe-project-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("datasetId" in body) || !("docId" in body)
      || typeof body.datasetId !== "string" || typeof body.docId !== "string") {
      return NextResponse.json({ error: "datasetId and docId are required" }, { status: 400 });
    }
    const project = getPeProject(body.datasetId);
    const job = queuePeExcelRetry(project, peProjectStorePaths().registryPath, body.docId);
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /任务正在运行/u.test(message) ? 409 : /not found/u.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
