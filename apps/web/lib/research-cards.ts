import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildResearchCardContext, ResearchError, type ResearchCardOrigin } from "@earendil-works/pe-boot";
import { getPeProject } from "./pe-project-store";
import { assertPeUserPathAllowed } from "./pe-multi-user-paths";
import { samePath } from "./paths";
import { resolveSessionPath } from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { parsePeSourceHref } from "./pe-source";
import { isRenderedResearchExcerpt } from "./research-excerpt";
import { getTurnFrameworkReport } from "./framework-proposal";
import type { ToolResultMessage } from "./types";

export function researchProject(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new ResearchError(400, "请选择研究项目");
  const project = getPeProject(value);
  assertPeUserPathAllowed(project.root);
  return project;
}

export function researchEvidenceIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const reference = parsePeSourceHref(match[1]);
    if (reference) ids.add(reference.evidenceId);
  }
  for (const match of text.matchAll(/\b(?:source:[A-Za-z0-9_-]+|(?:page|cell|fact|chunk):[A-Za-z0-9_-]+)/g)) ids.add(match[0]);
  if (ids.size > 100) throw new ResearchError(400, "来源过多，请缩小保存的回答范围");
  return [...ids];
}

/** The browser supplies an entry identity, never authoritative source text or evidence. */
export async function readResearchCardOrigin(root: string, value: unknown): Promise<{ origin: ResearchCardOrigin; evidenceIds: string[] }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResearchError(400, "请选择来源回答");
  const input = value as Record<string, unknown>;
  if (typeof input.sessionId !== "string" || input.sessionId.length > 128 || typeof input.entryId !== "string" || input.entryId.length > 128)
    throw new ResearchError(400, "无效的来源回答");
  const running = getRpcSession(input.sessionId);
  const path = await resolveSessionPath(input.sessionId);
  if (path) assertPeUserPathAllowed(path);
  const manager = running?.isAlive() ? running.inner.sessionManager : path ? SessionManager.open(path) : null;
  if (!manager || manager.getSessionId() !== input.sessionId || !samePath(manager.getCwd(), root))
    throw new ResearchError(404, "找不到当前项目的来源会话");
  const entry = manager.getEntry(input.entryId);
  if (entry?.type !== "message" || entry.message.role !== "assistant") throw new ResearchError(404, "找不到来源回答");
  const frameworkCalls = entry.message.content.flatMap((block) => block.type === "toolCall"
    ? [{ type: "toolCall" as const, toolCallId: block.id, toolName: block.name, input: block.arguments }] : []);
  const callIds = new Set(frameworkCalls.map((block) => block.toolCallId));
  const frameworkResults = new Map<string, ToolResultMessage>();
  for (const candidate of manager.getEntries()) {
    if (candidate.type !== "message" || candidate.message.role !== "toolResult" || !callIds.has(candidate.message.toolCallId)
      || !manager.getBranch(candidate.id).some((ancestor) => ancestor.id === entry.id)) continue;
    frameworkResults.set(candidate.message.toolCallId, {
      ...candidate.message,
      content: candidate.message.content.filter((block) => block.type === "text"),
    });
  }
  const original = getTurnFrameworkReport(frameworkCalls, frameworkResults)
    ?? entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  const excerpt = typeof input.excerpt === "string" ? input.excerpt.trim() : "";
  if (input.format !== undefined && input.format !== "rendered") throw new ResearchError(400, "无效的摘录格式");
  if (!excerpt || excerpt.length > 20000 ||
    !(input.format === "rendered" ? isRenderedResearchExcerpt(original, excerpt) : original.includes(excerpt)))
    throw new ResearchError(400, "无法核对选中摘录，请重新选择原回答中的文字（最多 20000 字符）");
  const answerEvidenceIds = researchEvidenceIds(original);
  let evidenceIds = answerEvidenceIds;
  if (input.evidenceIds !== undefined) {
    if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length > 100 || input.evidenceIds.some((id) => typeof id !== "string"))
      throw new ResearchError(400, "无效的摘录资料入口");
    evidenceIds = [...new Set(input.evidenceIds as string[])];
    const available = new Set(answerEvidenceIds);
    if (evidenceIds.some((id) => !available.has(id))) throw new ResearchError(400, "摘录资料入口不属于来源回答");
  }
  return {
    origin: { sessionId: input.sessionId, entryId: input.entryId, excerpt, messageTimestamp: entry.message.timestamp ?? null },
    evidenceIds,
  };
}

export function prepareResearchCardPrompt(cwd: string, message: unknown, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResearchError(400, "无效的研究上下文");
  const input = value as Record<string, unknown>;
  const project = researchProject(input.datasetId);
  if (!samePath(cwd, project.root)) throw new ResearchError(403, "研究卡片与目标会话不属于同一项目");
  if (typeof message !== "string" || !message.trim() || message.length > 8000) throw new ResearchError(400, "请填写本次研究问题（最多 8000 字符）");
  const context = buildResearchCardContext(project.root, project.datasetId, input.selection as Array<{ id: string; revision: number }>);
  return `${message.trim()}\n\n---\n## 本次选用的研究记录\n\n${context}`;
}
