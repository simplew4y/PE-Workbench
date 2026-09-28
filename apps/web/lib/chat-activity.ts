import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types";

export interface RunningChatTool {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  progress?: string;
}

export interface ChatActivityOptions {
  /** Only messages belonging to the current turn. */
  messages: readonly AgentMessage[];
  streamingMessage?: AssistantMessage | null;
  runningTools?: readonly RunningChatTool[];
  isCompacting?: boolean;
  retrying?: boolean;
  waitingForInput?: boolean;
  completed?: boolean;
}

type ActivityCopy = readonly [chinese: string, english: string];

const TOOL_ACTIVITIES: Readonly<Record<string, ActivityCopy>> = {
  pe_workbook_inspect: ["正在查看表格结构", "Inspecting workbook structure"],
  pe_workbook_search: ["正在检索表格", "Searching workbook content"],
  pe_excel_range: ["正在读取表格数据", "Reading spreadsheet data"],
  pe_excel_render: ["正在查看表格区域", "Viewing spreadsheet cells"],
  pe_formula_trace: ["正在追溯计算公式", "Tracing formulas"],
  pe_pdf_search: ["正在检索文档", "Searching documents"],
  pe_pdf_list: ["正在查找文档版本", "Finding document versions"],
  pe_pdf_read: ["正在阅读文档", "Reading documents"],
  pe_document_open: ["正在打开原始文档", "Opening source document"],
  pe_dataset_search: ["正在检索项目资料", "Searching project sources"],
  pe_source_detail: ["正在核对原始来源", "Checking source evidence"],
  pe_valuation_output_locate: ["正在定位估值结果", "Locating valuation outputs"],
  pe_valuation_date_resolve: ["正在核对估值日期", "Checking valuation dates"],
  pe_model_validate: ["正在检查模型", "Checking the model"],
  pe_valuation_report: ["正在生成估值报告", "Preparing valuation report"],
  pe_consensus_cards: ["正在读取机构观点", "Reading institutional views"],
  pe_driver_discover: ["正在查找模型驱动因素", "Finding model drivers"],
  pe_driver_sensitivity: ["正在计算敏感性", "Calculating sensitivities"],
  pe_research_note_save: ["正在保存研究笔记", "Saving research notes"],
  pe_dataset_memo: ["正在保存研究备忘录", "Saving research memo"],
  pe_render_ui: ["正在生成可视化", "Preparing visualization"],
  read: ["正在读取文件", "Reading files"],
  write: ["正在写入文件", "Writing files"],
  edit: ["正在修改文件", "Editing files"],
  bash: ["正在执行命令", "Running a command"],
  exec_command: ["正在执行命令", "Running a command"],
  grep: ["正在搜索文件内容", "Searching file contents"],
  find: ["正在查找文件", "Finding files"],
  ls: ["正在查看文件目录", "Listing files"],
  web_search: ["正在检索外部资料", "Searching external sources"],
  web_fetch: ["正在读取网页", "Reading a web page"],
};

function toolActivity(name: string, input: Record<string, unknown> = {}): ActivityCopy {
  // Match complete names, including the final part of MCP namespaces. Arbitrary
  // substrings (for example "read" in "thread") do not identify an operation.
  const normalized = name.toLowerCase().split(/__|\./).pop() ?? "";
  if (normalized === "pe_investment_framework") {
    if (input.operation === "read") return ["正在读取投资框架", "Reading investment framework"];
    if (input.operation === "propose") return ["正在整理投资框架草案", "Preparing investment framework draft"];
    return ["正在处理投资框架", "Working on investment framework"];
  }
  if (normalized === "pe_stock_tracking") {
    if (input.operation === "refresh") return ["正在更新市场行情", "Refreshing market prices"];
    if (input.operation === "configure") return ["正在设置股票追踪", "Configuring stock tracking"];
    if (input.operation === "trade") return ["正在记录模拟交易", "Recording a simulated trade"];
    return ["正在读取股票追踪资料", "Reading stock tracking data"];
  }
  if (normalized === "pe_trusted_source") {
    if (input.operation === "status") return ["正在检查数据源状态", "Checking data source status"];
    if (input.operation === "list") return ["正在查找已有数据", "Finding saved market data"];
    if (input.category === "financials") return ["正在获取财务数据", "Retrieving financial data"];
    if (input.category === "analytics") return ["正在计算估值指标", "Calculating valuation metrics"];
    if (input.category === "quote") return ["正在获取市场行情", "Retrieving market prices"];
    return ["正在获取外部资料", "Retrieving external sources"];
  }
  if (normalized === "pe_history_compare") {
    return input.operation === "compare"
      ? ["正在对比历史版本", "Comparing historical versions"]
      : ["正在读取历史版本", "Reading historical versions"];
  }
  return TOOL_ACTIVITIES[normalized] ?? ["正在处理任务", "Working on the task"];
}

/** Derive a compact status from observable activity, never from reasoning text. */
export function getChatActivity(options: ChatActivityOptions, locale = "zh-CN"): string {
  const { messages, streamingMessage, runningTools = [] } = options;
  const copy = (value: ActivityCopy) => value[locale.startsWith("zh") ? 0 : 1];
  const assistantMessages = messages.filter((message): message is AssistantMessage => message.role === "assistant");

  if (options.completed) {
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (lastAssistant?.stopReason === "aborted") return copy(["已停止 · 查看过程", "Stopped · View process"]);
    if (lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage?.trim()) {
      return copy(["处理失败 · 查看过程", "Failed · View process"]);
    }
    if (messages.some((message) => message.role === "toolResult" && message.isError)) {
      return copy(["查看处理过程 · 含失败步骤", "View process · Includes failed steps"]);
    }
    return copy(["查看处理过程", "View process"]);
  }

  if (options.waitingForInput) return copy(["等待你的输入", "Waiting for your input"]);
  if (options.isCompacting) return copy(["正在整理对话上下文", "Organizing conversation context"]);
  if (options.retrying) return copy(["正在重试请求", "Retrying the request"]);

  const toolCalls = new Map<string, ToolCallContent>();
  for (const message of [...assistantMessages, ...(streamingMessage ? [streamingMessage] : [])]) {
    for (const block of message.content) {
      if (block.type === "toolCall") toolCalls.set(block.toolCallId, block);
    }
  }

  if (runningTools.length > 0) {
    const labels = [...new Set(runningTools.map((tool) => (
      copy(toolActivity(tool.name, tool.input ?? toolCalls.get(tool.id)?.input))
    )))];
    return labels.length === 1 ? labels[0] : `${labels[0]} · ${copy(["另有任务进行中", "More tasks in progress"])}`;
  }

  // This also reconstructs useful activity after a refresh, before live tool
  // events reconnect. Completed tool results cannot become active again.
  const completedToolIds = new Set(messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []));
  const pendingTools = [...toolCalls.values()].filter((tool) => !completedToolIds.has(tool.toolCallId));
  if (pendingTools.length > 0) {
    const pending = pendingTools[pendingTools.length - 1];
    if (pending.rawInput !== undefined) return copy(["正在准备工具调用", "Preparing a tool call"]);
    return copy(toolActivity(pending.toolName, pending.input));
  }
  if (streamingMessage?.content.some((block) => block.type === "text" && block.text.trim())) {
    return copy(["正在组织回答", "Composing a response"]);
  }
  if (completedToolIds.size > 0) return copy(["正在整理分析结果", "Reviewing analysis results"]);
  return copy(["正在梳理问题", "Working through the request"]);
}
