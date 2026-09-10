import { NextRequest, NextResponse } from "next/server";
import { listPeProjectDocuments } from "@/lib/pe-project-documents";
import { peStorageErrorResponse } from "@/lib/pe-storage-errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const datasetId = request.nextUrl.searchParams.get("datasetId")?.trim() ?? "";
  if (!datasetId) {
    return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(listPeProjectDocuments(datasetId));
  } catch (error) {
    const storageError = peStorageErrorResponse(error);
    if (storageError) return storageError;
    const message = error instanceof Error ? error.message : String(error);
    const notFound = /Project not found/iu.test(message);
    console.error("Unable to list PE project documents:", error);
    return NextResponse.json(
      { error: notFound ? "Project not found" : "Unable to read project documents" },
      { status: notFound ? 404 : 500 },
    );
  }
}
