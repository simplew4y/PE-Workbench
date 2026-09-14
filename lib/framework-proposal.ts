import type { AssistantContentBlock, ToolResultMessage } from "./types";

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
