import { NextResponse } from "next/server";
import { createResearchCard, listResearchCardRevisions, listResearchCards, restoreResearchCardRevision, updateResearchCard, ResearchError, type ResearchCardStatus } from "@earendil-works/pe-boot";
import { readResearchCardOrigin, researchProject } from "@/lib/research-cards";
import { peStorageErrorResponse } from "@/lib/pe-storage-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  if (error instanceof ResearchError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
  return peStorageErrorResponse(error) ?? NextResponse.json({ error: "无法访问研究积累，请刷新后重试" }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const project = researchProject(search.get("datasetId"));
    const id = search.get("id");
    return id
      ? NextResponse.json({ revisions: listResearchCardRevisions(project.root, project.datasetId, id) })
      : NextResponse.json({ cards: listResearchCards(project.root, project.datasetId) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError(400, "请求格式无效");
    const input = body as Record<string, unknown>;
    const project = researchProject(input.datasetId);
    if (input.action === "restore") {
      if (typeof input.id !== "string") throw new ResearchError(400, "请选择研究卡片");
      return NextResponse.json({ card: restoreResearchCardRevision(project.root, project.datasetId, input.id, input.revision as number, input.targetRevision as number) });
    }
    if (input.action === "update") {
      if (typeof input.id !== "string") throw new ResearchError(400, "请选择研究卡片");
      return NextResponse.json({ card: updateResearchCard(project.root, project.datasetId, input.id, input.revision as number, {
        title: input.title as string, content: input.content as string, status: input.status as ResearchCardStatus, archived: input.archived as boolean,
        frameworkItemIds: input.frameworkItemIds as string[],
      }) });
    }
    if (input.action !== "create" || (input.kind !== "note" && input.kind !== "question")) throw new ResearchError(400, "无效的保存操作");
    const source = input.source ? await readResearchCardOrigin(project.root, input.source) : null;
    if (input.kind === "note" && !source) throw new ResearchError(400, "请从对话回答保存研究成果");
    const card = createResearchCard(project.root, project.datasetId, {
      requestId: input.requestId as string, kind: input.kind, title: input.title as string,
      content: source && input.kind === "note" ? source.origin.excerpt : input.content as string,
      origin: source?.origin ?? null, evidenceIds: source?.evidenceIds ?? [], relatedCardIds: (input.relatedCardIds ?? []) as string[],
      frameworkItemIds: (input.frameworkItemIds ?? []) as string[],
    });
    return NextResponse.json({ card }, { status: 201 });
  } catch (error) { return failure(error); }
}
