/** A branch-aware projection of recorded operations, never inferred model reasoning. */
export interface FlowEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: Record<string, unknown>;
  summary?: string;
}
export interface FlowStep {
  id: string;
  title: string;
  status: string;
  at: string;
  durationMs: number | null;
  input: string;
  output: string;
}
export interface ExecutionFlow {
  sessionId: string;
  turnId: string;
  leafId: string;
  steps: FlowStep[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function printable(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (/^(password|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)$/i.test(key)) return "[已隐藏]";
    const obj = record(item);
    if (obj.type === "thinking" || obj.type === "redacted_thinking") return "[不导出内部推理]";
    if (obj.type === "image") return { type: "image", note: "图片二进制省略", mimeType: obj.mimeType };
    return item;
  }, 2) ?? "";
}

function elapsed(start: string, end: string): number | null {
  const result = Date.parse(end) - Date.parse(start);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function buildExecutionFlow(entries: readonly FlowEntry[], sessionId: string, turnId: string, leafId: string): ExecutionFlow {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: FlowEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error("会话分支存在循环");
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) throw new Error("会话分支记录不完整");
    branch.push(entry);
    cursor = entry.parentId;
  }
  branch.reverse();
  const start = branch.findIndex(entry => entry.id === turnId && entry.message?.role === "user");
  if (start < 0) throw new Error("当前分支未找到这条问题");
  let end = branch.findIndex((entry, index) => index > start && entry.message?.role === "user");
  if (end < 0) end = branch.length;
  const steps: FlowStep[] = [];
  const calls = new Map<string, { step: FlowStep; at: string }>();
  let previous = branch[start].timestamp;
  for (const entry of branch.slice(start, end)) {
    const message = entry.message ?? {};
    const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
    if (message.role === "user") {
      steps.push({ id: entry.id, title: "问题 / 开始执行", status: "已记录", at: entry.timestamp, durationMs: null, input: printable(message.content), output: "" });
    } else if (message.role === "assistant") {
      const toolCalls = blocks.filter(block => block.type === "toolCall");
      const text = blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
      steps.push({ id: entry.id, title: toolCalls.length ? "模型生成工具请求" : "模型输出", status: message.stopReason === "error" || message.stopReason === "aborted" ? String(message.stopReason) : "已记录", at: entry.timestamp, durationMs: elapsed(previous, entry.timestamp), input: printable({ provider: message.provider, model: message.model, usage: message.usage }), output: text + (message.errorMessage ? `\n${String(message.errorMessage)}` : "") });
      for (const block of toolCalls) {
        const id = String(block.id ?? block.toolCallId ?? "");
        const step: FlowStep = { id, title: String(block.name ?? block.toolName ?? "工具"), status: "未记录返回", at: entry.timestamp, durationMs: null, input: printable(block.arguments ?? block.input), output: "" };
        calls.set(id, { step, at: entry.timestamp });
        steps.push(step);
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(String(message.toolCallId));
      if (call) {
        call.step.status = message.isError ? "失败" : "已返回";
        call.step.output = printable({ content: message.content, details: message.details });
        call.step.durationMs = elapsed(call.at, entry.timestamp);
        call.step.at = entry.timestamp;
      } else {
        steps.push({ id: entry.id, title: "未配对工具返回", status: message.isError ? "失败" : "已返回", at: entry.timestamp, durationMs: null, input: "", output: printable(message) });
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || message.role === "bashExecution") {
      steps.push({ id: entry.id, title: entry.type === "message" ? "命令执行" : entry.type === "compaction" ? "上下文压缩" : "分支摘要", status: "已记录", at: entry.timestamp, durationMs: null, input: String(message.command ?? ""), output: String(entry.summary ?? message.output ?? "") });
    }
    if (entry.type === "message" || entry.type === "compaction") previous = entry.timestamp;
  }
  return { sessionId, turnId, leafId, steps };
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function renderFlowSvg(flow: ExecutionFlow): string {
  const height = 90 + flow.steps.length * 110;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="100%" height="100%" fill="#f4f6fa"/><text x="40" y="35" font-size="22" font-family="sans-serif">问答执行流程（概览，完整输入输出见HTML）</text>${flow.steps.map((step, index) => {
    const y = 60 + index * 110;
    return `${index ? `<path d="M450 ${y - 25}v20l-5 -6m5 6l5 -6" stroke="#718096" fill="none"/>` : ""}<g><title>${escape(step.title + "\n" + step.status)}</title><rect x="40" y="${y}" width="820" height="85" rx="10" fill="white" stroke="${step.status === "失败" ? "#dc2626" : "#9cacc5"}"/><text x="60" y="${y + 30}" font-family="sans-serif" font-size="17">${index + 1}. ${escape(step.title.slice(0, 65))}</text><text x="60" y="${y + 60}" font-family="sans-serif" font-size="13">${escape(step.status)} · ${step.durationMs === null ? "耗时未知" : (step.durationMs / 1000).toFixed(3) + " 秒（估计）"} · ${escape(step.at)}</text></g>`;
  }).join("")}</svg>`;
}

export function renderFlowHtml(flow: ExecutionFlow): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>问答执行流程</title><style>body{background:#f4f6fa;color:#182538;font:15px/1.6 system-ui,sans-serif;margin:0}main{max-width:1050px;margin:auto;padding:28px}article{border:1px solid #cdd7e5;border-radius:12px;background:white;padding:18px}article.fail{border-color:#dc2626}h2{font-size:18px;margin:0}small{color:#596a80}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3f8;padding:14px;max-height:600px;overflow:auto}summary{cursor:pointer;padding:8px 0}.arrow{text-align:center;color:#68788e;font-size:24px}p{overflow-wrap:anywhere}details{min-width:0}</style><main><h1>问答执行流程</h1><p>Session ${escape(flow.sessionId)} · 问题 ${escape(flow.turnId)} · 分支末端 ${escape(flow.leafId)}</p><p>当前记录快照；运行中请刷新。按工具调用ID配对输入输出，失败后的再次调用分别保留，不推断两者必然为重试。模型耗时含等待与调度；工具耗时是请求落盘至返回的估计，可能包含同批工具等待，不能相加。未记录排队、首字耗时及内部推理。结构化密钥字段已隐藏，自由文本可能仍含敏感资料，分享前请检查。</p>${flow.steps.map((step, index) => `${index ? '<div class="arrow" aria-hidden="true">↓</div>' : ""}<article class="${step.status === "失败" || step.status === "error" ? "fail" : ""}"><h2>${index + 1}. ${escape(step.title)} · ${escape(step.status)}</h2><small>${escape(step.at)} · ${step.durationMs === null ? "耗时未知" : (step.durationMs / 1000).toFixed(3) + " 秒（估计）"} · ${escape(step.id)}</small>${step.input ? `<details><summary>输入 / 参数</summary><pre>${escape(step.input)}</pre></details>` : ""}${step.output ? `<details ${step.status === "失败" ? "open" : ""}><summary>输出 / 返回内容</summary><pre>${escape(step.output)}</pre></details>` : ""}</article>`).join("")}</main></html>`;
}
