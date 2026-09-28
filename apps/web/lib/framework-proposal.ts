import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { renderInvestmentFrameworkMarkdown, type FrameworkContent } from "@earendil-works/pe-boot/framework-report";

export interface FrameworkProposal { datasetId: string; draftId: string; revision: number; toolCallId: string }

export function getTurnFrameworkProposal(content: AssistantContentBlock[], results: Map<string, ToolResultMessage>): FrameworkProposal | null {
  for (const block of [...content].reverse()) {
    if (block.type !== "toolCall" || block.toolName !== "pe_investment_framework" || block.input.operation !== "propose") continue;
    const result = results.get(block.toolCallId);
    if (!result || result.isError) continue;
    let value = result.details;
    if (!value) {
      try { value = JSON.parse(result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n")); }
      catch { continue; }
    }
    if (!value || typeof value !== "object") continue;
    const data = value as Record<string, unknown>;
    if (data.kind !== "pe_framework_draft" || typeof data.datasetId !== "string" || !data.draft || typeof data.draft !== "object") continue;
    const draft = data.draft as Record<string, unknown>;
    if (typeof draft.id === "string" && typeof draft.revision === "number" && Number.isSafeInteger(draft.revision) && draft.revision > 0) {
      return { datasetId: data.datasetId, draftId: draft.id, revision: draft.revision, toolCallId: block.toolCallId };
    }
  }
  return null;
}

export function getTurnFrameworkReport(content: AssistantContentBlock[], results: Map<string, ToolResultMessage>): string | null {
  const proposal = getTurnFrameworkProposal(content, results);
  if (!proposal) return null;
  const result = results.get(proposal.toolCallId);
  if (!result) return null;
  try {
    const value = result.details ?? JSON.parse(result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n"));
    if (!value || typeof value !== "object" || !("draft" in value)) return null;
    const draft = value.draft;
    if (!draft || typeof draft !== "object" || !("content" in draft)) return null;
    const document = draft.content;
    if (!document || typeof document !== "object" || !("schemaVersion" in document) || document.schemaVersion !== 2) return null;
    return renderInvestmentFrameworkMarkdown(document as FrameworkContent);
  } catch {
    return null;
  }
}

export function getTurnFrameworkFailure(content: AssistantContentBlock[], results: Map<string, ToolResultMessage>): { toolCallId: string; error: string } | null {
  for (const block of [...content].reverse()) {
    if (block.type !== "toolCall" || block.toolName !== "pe_investment_framework" || block.input.operation !== "propose") continue;
    const result = results.get(block.toolCallId);
    if (!result) continue;
    const details = result.details;
    // Tools can end the run with a typed failure result. The agent transport
    // marks normal execute returns as isError=false even when terminate=true.
    if (details && typeof details === "object" && "kind" in details && details.kind === "pe_framework_error"
      && "error" in details && typeof details.error === "string" && details.error.trim()) {
      return { toolCallId: block.toolCallId, error: details.error.trim() };
    }
    if (!result.isError) return null;
  }
  return null;
}
