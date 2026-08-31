import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { PeSourceError, resolvePeEvidenceSource } from "@/lib/pe-source-server";

export const runtime = "nodejs";

function inlineFilename(filename: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(filename).replaceAll("'", "%27")}`;
}

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
    const source = resolvePeEvidenceSource(cwd, evidenceId);
    if (source.payload.kind !== "pdf" || !source.filePath) {
      return NextResponse.json({ error: "This evidence is not a PDF source" }, { status: 400 });
    }

    const size = statSync(source.filePath).size;
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": inlineFilename(source.payload.filename),
      "Content-Type": "application/pdf",
    };
    const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/u);
    if (range) {
      const requestedStart = range[1] ? Number(range[1]) : undefined;
      const requestedEnd = range[2] ? Number(range[2]) : undefined;
      const start = requestedStart ?? Math.max(0, size - (requestedEnd ?? size));
      const end = Math.min(size - 1, requestedStart === undefined ? size - 1 : (requestedEnd ?? size - 1));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(source.filePath, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(source.filePath)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: { ...commonHeaders, "Content-Length": String(size) },
    });
  } catch (error) {
    if (error instanceof PeSourceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Failed to stream PE evidence source", error);
    return NextResponse.json({ error: "无法读取引用原文件。" }, { status: 500 });
  }
}
