import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";
import { isGenerativeUiToolCall } from "./generative-ui/tool.ts";
import { humanizePeModelError } from "./pe-model-errors.ts";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return humanizePeModelError(message.errorMessage?.trim()) || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image" || (block.type === "toolCall" && isGenerativeUiToolCall(block));
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/** Keep source indices intact for lazily loaded historical thinking blocks. */
export function withAssistantBlocks(message: AssistantMessage, content: AssistantContentBlock[]): AssistantMessage {
  const selected = new Set(content);
  return {
    ...message,
    content: message.content.map((block) => selected.has(block) ? block : { type: "thinking", thinking: "" }),
  };
}

/** Internal confirmation prompts stay in agent history, but are not chat content. */
export function isFrameworkConfirmationMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return /^\[framework-confirmation:[^\]\r\n]+\](?:\s|$)/.test(text);
}
