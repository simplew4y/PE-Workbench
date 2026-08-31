import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { readPeIngestJob, resolvePeProjectPaths } from "@/lib/pe-ingest";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    const realCwd = fs.realpathSync(cwd);
    if (!isFilePathAllowed(realCwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const { jobId } = await params;
    return NextResponse.json({ job: readPeIngestJob(resolvePeProjectPaths(realCwd), jobId) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? "Ingest job not found" : error instanceof Error ? error.message : String(error) },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
}
