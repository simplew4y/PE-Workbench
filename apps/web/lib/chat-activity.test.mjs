import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getChatActivity } = await jiti.import("./chat-activity.ts");

const assistant = (content, extra = {}) => ({ role: "assistant", content, model: "test", provider: "test", ...extra });
const call = (toolCallId, toolName, input = {}) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, isError = false) => ({ role: "toolResult", toolCallId, content: [], isError });

test("describes initial work without guessing from raw reasoning", () => {
  assert.equal(getChatActivity({ messages: [] }), "正在梳理问题");
  assert.equal(getChatActivity({ messages: [], streamingMessage: assistant([{ type: "thinking", thinking: "Secret or speculative topic" }]) }), "正在梳理问题");
  assert.equal(getChatActivity({ messages: [], streamingMessage: assistant([{ type: "text", text: "An answer" }]) }), "正在组织回答");
});

test("uses actual running tool names and resolves operation arguments by id", () => {
  const messages = [assistant([call("one", "pe_investment_framework", { operation: "read" }), call("two", "pe_investment_framework", { operation: "propose" })])];
  assert.equal(getChatActivity({ messages, runningTools: [{ id: "one", name: "pe_investment_framework" }] }), "正在读取投资框架");
  assert.equal(getChatActivity({ messages, runningTools: [{ id: "two", name: "pe_investment_framework" }] }), "正在整理投资框架草案");
  assert.equal(getChatActivity({ messages: [], runningTools: [{ id: "three", name: "pe_stock_tracking", input: { operation: "trade" } }] }), "正在记录模拟交易");
});

test("handles namespaced tools without misleading substring matches", () => {
  assert.equal(getChatActivity({ messages: [], runningTools: [{ id: "1", name: "mcp__pe__pe_excel_range" }] }), "正在读取表格数据");
  assert.equal(getChatActivity({ messages: [], runningTools: [{ id: "2", name: "thread_research", progress: "do not display this raw output" }] }), "正在处理任务");
});

test("keeps concurrent tool activity compact", () => {
  const tools = [{ id: "1", name: "pe_excel_range" }, { id: "2", name: "pe_excel_range" }];
  assert.equal(getChatActivity({ messages: [], runningTools: tools }), "正在读取表格数据");
  assert.equal(getChatActivity({ messages: [], runningTools: [...tools, { id: "3", name: "pe_pdf_read" }] }), "正在读取表格数据 · 另有任务进行中");
});

test("recovers incomplete tool activity and never revives a completed tool", () => {
  const tool = call("1", "pe_excel_range");
  assert.equal(getChatActivity({ messages: [assistant([tool])] }), "正在读取表格数据");
  assert.equal(getChatActivity({ messages: [assistant([tool]), result("1")] }), "正在整理分析结果");
  assert.equal(getChatActivity({ messages: [], streamingMessage: assistant([{ ...tool, rawInput: '{"range":' }]) }), "正在准备工具调用");
  assert.equal(getChatActivity({ messages: [assistant([tool]), result("1")], streamingMessage: assistant([{ type: "text", text: "Found it" }]) }), "正在组织回答");
});

test("waiting, context compaction, and retry states take precedence over stale tool events", () => {
  const options = { messages: [], runningTools: [{ id: "1", name: "pe_excel_range" }] };
  assert.equal(getChatActivity({ ...options, waitingForInput: true, isCompacting: true, retrying: true }), "等待你的输入");
  assert.equal(getChatActivity({ ...options, isCompacting: true, retrying: true }), "正在整理对话上下文");
  assert.equal(getChatActivity({ ...options, retrying: true }), "正在重试请求");
});

test("completed and failed turns do not claim tools are still running", () => {
  assert.equal(getChatActivity({ messages: [assistant([call("1", "pe_excel_range")])], completed: true }), "查看处理过程");
  assert.equal(getChatActivity({ messages: [assistant([], { stopReason: "aborted" })], completed: true }), "已停止 · 查看过程");
  assert.equal(getChatActivity({ messages: [assistant([], { stopReason: "error" })], completed: true }), "处理失败 · 查看过程");
  assert.equal(getChatActivity({ messages: [result("1", true), assistant([{ type: "text", text: "Recovered" }])], completed: true }), "查看处理过程 · 含失败步骤");
  assert.equal(getChatActivity({ messages: [assistant([], { stopReason: "error" }), assistant([{ type: "text", text: "Recovered" }])], completed: true }), "查看处理过程");
});

test("uses English copy when the interface is English", () => {
  assert.equal(getChatActivity({ messages: [], runningTools: [{ id: "1", name: "pe_trusted_source", input: { operation: "fetch", category: "financials" } }] }, "en"), "Retrieving financial data");
  assert.equal(getChatActivity({ messages: [], completed: true }, "en"), "View process");
});
