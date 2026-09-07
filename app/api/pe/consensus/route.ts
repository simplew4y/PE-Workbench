import { NextResponse } from "next/server";
import { isPeConsensusEnabled } from "@earendil-works/pe-boot";
import { loadPeConsensusCards, parseCardTypes } from "@/lib/pe-consensus";

export const runtime = "nodejs";

/**
 * GET /api/pe/consensus?datasetId=...&types=divergence,consensus&itemKey=revenue&limit=50
 *
 * Returns the consensus/divergence cards the ingest worker built for a project,
 * ordered by priority. Each card links to its claims and source evidence; the
 * evidence IDs resolve through /api/pe/source.
 */
export async function GET(request: Request) {
  // The feature is unreleased; without the opt-in the route does not exist.
  if (!isPeConsensusEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  const datasetId = url.searchParams.get("datasetId")?.trim();
  if (!datasetId) {
    return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "");
  try {
    const result = loadPeConsensusCards(datasetId, {
      cardTypes: parseCardTypes(url.searchParams.get("types")),
      itemKey: url.searchParams.get("itemKey")?.trim() || undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Project not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
