import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { PeSourceError, resolvePeEvidenceSource } from "@/lib/pe-source-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim();
  const evidenceId = url.searchParams.get("evidence_id")?.trim();
  if (!cwd || !evidenceId) {
    return NextResponse.json({ error: "cwd and evidence_id are required" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "PE workspace is not allowed" }, { status: 403 });
  }

  try {
    return NextResponse.json(resolvePeEvidenceSource(cwd, evidenceId).payload);
  } catch (error) {
    if (error instanceof PeSourceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Failed to resolve PE evidence source", error);
    return NextResponse.json({ error: "无法读取引用来源。" }, { status: 500 });
  }
}
