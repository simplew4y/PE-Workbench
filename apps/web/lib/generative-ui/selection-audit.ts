import { parseGenerativeUiSurface } from "./parser.ts";
import { isGenerativeUiToolName } from "./tool.ts";

type RecordValue = Record<string, unknown>;
type SelectionCall = {
  id: string;
  input: unknown;
  status: "pending" | "success" | "error";
};

export type SelectionTurn = {
  turnId: string;
  prompt: string;
  text: string;
  completion: "complete" | "pending" | "error";
  toolCounts: Record<string, number>;
  calls: SelectionCall[];
};

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Deliberately exclude thinking, image bytes, and tool results.
  return content.flatMap((value) => {
    const block = record(value);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

/** Read one explicitly supplied session and one parent chain, never scan a session directory. */
export function auditSelectionSession(jsonl: string, leafId?: string): SelectionTurn[] {
  const entries = new Map<string, RecordValue>();
  let lastId: string | undefined;
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry: RecordValue | undefined;
    try { entry = record(JSON.parse(line)); } catch { throw new Error(`Invalid session JSON at line ${index + 1}`); }
    if (!entry || typeof entry.type !== "string") throw new Error(`Invalid session entry at line ${index + 1}`);
    if (entry.type === "session") continue;
    if (typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")) {
      throw new Error(`Expected version-3 entry id/parentId at line ${index + 1}`);
    }
    if (entries.has(entry.id)) throw new Error(`Duplicate session entry: ${entry.id}`);
    entries.set(entry.id, entry);
    lastId = entry.id;
  }
  const chain: RecordValue[] = [];
  const visited = new Set<string>();
  let id: string | null | undefined = leafId ?? lastId;
  while (id != null) {
    if (visited.has(id)) throw new Error(`Session parent cycle: ${id}`);
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) throw new Error(`Session entry not found: ${id}`);
    chain.push(entry);
    id = entry.parentId as string | null;
  }
  const turns: SelectionTurn[] = [];
  let turn: SelectionTurn | undefined;
  for (const entry of chain.reverse()) {
    const message = record(entry.message);
    if (entry.type !== "message" || !message) continue;
    if (message.role === "user") {
      turn = { turnId: entry.id as string, prompt: textContent(message.content), text: "", completion: "pending", toolCounts: Object.create(null), calls: [] };
      turns.push(turn);
    } else if (turn && message.role === "assistant") {
      const text = textContent(message.content);
      if (text) turn.text += (turn.text ? "\n\n" : "") + text;
      const blocks = Array.isArray(message.content) ? message.content : [];
      let hasTool = false;
      for (const value of blocks) {
        const block = record(value);
        if (block?.type !== "toolCall") continue;
        hasTool = true;
        const name = block.name ?? block.toolName;
        if (typeof name !== "string") continue;
        turn.toolCounts[name] = (turn.toolCounts[name] ?? 0) + 1;
        if (isGenerativeUiToolName(name)) {
          const callId = block.id ?? block.toolCallId;
          if (typeof callId !== "string") throw new Error("UI tool call is missing its id");
          if (turn.calls.some((call) => call.id === callId)) throw new Error(`Duplicate UI tool call: ${callId}`);
          turn.calls.push({ id: callId, input: block.arguments ?? block.input, status: "pending" });
        }
      }
      turn.completion = message.stopReason === "error" || message.stopReason === "aborted" ? "error"
        : !hasTool && message.stopReason === "stop" ? "complete" : "pending";
    } else if (turn && message.role === "toolResult") {
      const call = turn.calls.find((item) => item.id === message.toolCallId);
      if (call) call.status = message.isError === true ? "error" : "success";
    }
  }
  for (const item of turns) {
    if (item.completion === "complete" && item.calls.some((call) => call.status === "pending")) item.completion = "pending";
  }
  return turns;
}

/** Structural facts only: frequency is diagnostic, never a quality/novelty score. */
export function summarizeSelectionTurns(turns: SelectionTurn[]) {
  const successfulKindCounts: Record<string, number> = Object.create(null);
  const observations = turns.map((turn) => {
    const choices = turn.calls.map((call) => {
      const parsed = parseGenerativeUiSurface(call.input);
      if (!parsed.success) return { status: call.status, valid: false, kinds: [] as string[], error: parsed.error };
      const surface = parsed.surface;
      const kinds = surface.component.kind === "research_brief" ? surface.component.blocks.map((block) => block.kind) : [surface.component.kind];
      if (call.status === "success") for (const kind of kinds) successfulKindCounts[kind] = (successfulKindCounts[kind] ?? 0) + 1;
      return { status: call.status, valid: true, composition: surface.component.kind === "research_brief" ? "brief" : "leaf", kinds, theme: surface.presentation?.theme ?? "neutral", customPalette: surface.presentation?.palette !== undefined, treatment: surface.presentation?.treatment ?? "minimal", interaction: surface.presentation?.interaction ?? "static" };
    });
    return { turnId: turn.turnId, completion: turn.completion, toolCounts: turn.toolCounts, choices };
  });
  return { turns: observations, successfulKindCounts, note: "Observed selection only; not a factual, visual-quality or diversity score. Pending/failed calls are not successful renderings. Browser rendering is not verified by tool success." };
}
