import type { AgentMessage, AssistantMessage, ToolCallContent } from "../types";

export function isGenerativeUiToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "pe_render_ui" || name.endsWith(":pe_render_ui") || name.endsWith("__pe_render_ui");
}

export function isGenerativeUiToolCall(block: ToolCallContent): boolean {
  return isGenerativeUiToolName(block.toolName);
}

export function hasGenerativeUiToolCall(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && (message as AssistantMessage).content.some((block) => (
    block.type === "toolCall" && isGenerativeUiToolCall(block)
  ));
}
