import { NextRequest, NextResponse } from "next/server";
import { type CardType, isPeConsensusEnabled, listPeConsensusCards } from "@earendil-works/pe-boot";
import { getPeProject } from "@/lib/pe-project-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isPeConsensusEnabled()) {
    return NextResponse.json({ error: "Consensus feature is disabled" }, { status: 404 });
  }
  const query = request.nextUrl.searchParams;
  const datasetId = query.get("datasetId")?.trim();
  if (!datasetId) return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
  const types = query.getAll("card_type");
  const limit = Number(query.get("limit") ?? 20);
  if (types.some((type) => !["consensus", "divergence", "single_view"].includes(type))
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "Invalid card_type or limit" }, { status: 400 });
  }
  try {
    const project = getPeProject(datasetId);
    return NextResponse.json(listPeConsensusCards(project.root, {
      datasetId, cardTypes: types as CardType[], limit,
      itemKey: query.get("item_key") ?? undefined,
      includeSources: query.get("include_sources") === "true",
    }));
  } catch (error) {
    const missing = error instanceof Error && /Project not found/iu.test(error.message);
    return NextResponse.json({ error: missing ? "Project not found" : "Unable to read project consensus" }, { status: missing ? 404 : 500 });
  }
}
