import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listPeProjectDocuments, updatePeSource } from "@/lib/pe-project-documents";
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

export async function PATCH(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = await request.json();
    if (!body || typeof body.datasetId !== "string" || typeof body.key !== "string"
      || !["rename", "remove"].includes(body.action)
      || (body.action === "rename" && typeof body.name !== "string")) {
      return NextResponse.json({ error: "Invalid source operation" }, { status: 400 });
    }
    updatePeSource(body.datasetId, body.key, body.action, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const storageError = peStorageErrorResponse(error);
    if (storageError) return storageError;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update source" }, { status: 400 });
  }
}
