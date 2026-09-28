import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const libs = new Map(await Promise.all(["ansi", "terminal-input", "message-display", "turn-written-files", "generative-ui/tool", "chat-activity", "tool-presets", "framework-proposal", "chat-lazy-load"]
  .map(async (name) => [`@/lib/${name}`, await jiti.import(`../lib/${name}.ts`)])));
const report = await jiti.import("../../../packages/pe-boot/src/research/report.ts");
const { frameworkFixture } = await jiti.import("../../../packages/pe-boot/test/fixtures/framework.ts");
let state;
let expanded = false;
const seenMessages = [];
const seenConfirmations = [];
const exports = {};
const code = ts.transpileModule(readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
runInNewContext(code, { exports, require: (id) => {
  if (libs.has(id)) return libs.get(id);
  if (id === "@earendil-works/pe-boot/framework-report") return report;
  if (id.endsWith(".css")) return { default: {} };
  if (id === "@/hooks/useKeyboardShortcuts") return { registerAbortHandler() {} };
  if (id === "@/hooks/useI18n") return { useI18n: () => ({ t: (key) => key, locale: "zh-CN" }) };
  if (id === "@/hooks/useIsMobile") return { useIsMobile: () => true };
  if (id === "@/hooks/useDragDrop") return { useDragDrop: () => ({}) };
  if (id === "@/hooks/useAgentSession") return { useAgentSession: () => state };
  if (id === "./ChatMinimap") return { ChatMinimap: () => null, useMessageRefs: () => React.useRef([]) };
  if (id === "./ChatInput") return { ChatInput: () => null };
  if (id === "./ExtensionStatusBar") return { ExtensionStatusBar: () => null };
  if (id === "./PeResearchNotebook") return { PeResearchNotebook: () => null, ResearchCardCapture: ({ children }) => children };
  if (id === "./PeFrameworkPanel") return {
    usePeResearch: () => ({}), PeResearchRail: () => null,
    PeFrameworkConfirmation: (props) => { seenConfirmations.push(props); return React.createElement("button", null, "确定投资框架"); },
  };
  if (id === "./ProcessDetailsGroup") return { ProcessDetailsGroup: ({ label, children }) => React.createElement("details", { "data-process": true }, React.createElement("summary", null, label), expanded ? children : null) };
  if (id === "./MessageView") return { MessageView: (props) => {
    seenMessages.push(props);
    const { message } = props;
    return React.createElement("article", { "data-role": message.role }, typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), message.errorMessage);
  } };
  return require(id);
} });

const assistant = (content, extra = {}) => ({ role: "assistant", model: "test", provider: "test", content, ...extra });
const call = (id) => ({ type: "toolCall", toolCallId: id, toolName: "pe_investment_framework", input: { operation: "propose" } });
const document = frameworkFixture();
const saved = { role: "toolResult", toolCallId: "saved", toolName: "pe_investment_framework", isError: false, content: [], details: { kind: "pe_framework_draft", datasetId: "project", draft: { id: "draft", revision: 1, content: document } } };
const messages = [{ role: "user", content: "生成投资框架" }, assistant([call("failed")]), { role: "toolResult", toolCallId: "failed", isError: true, content: [{ type: "text", text: "读取超时" }] }, assistant([call("saved")]), saved];
function render(tail = [], options = {}) {
  expanded = options.expanded ?? false;
  seenMessages.length = 0;
  seenConfirmations.length = 0;
  const turn = options.messages ?? [...messages, ...tail];
  state = {
    messages: turn, entryIds: turn.map((_, index) => `entry-${index}`),
    streamState: { isStreaming: options.running ?? false, streamingMessage: null }, agentRunning: options.running ?? false,
    modelNames: {}, modelList: [], modelThinkingLevels: {}, modelThinkingLevelMaps: {}, queuedMessages: { steering: [], followUp: [] }, notices: [],
    sessionIdRef: { current: "session" }, messagesEndRef: { current: null }, scrollContainerRef: { current: null }, lastUserMsgRef: { current: null },
  };
  return renderToStaticMarkup(React.createElement(exports.ChatWindow, { session: { id: "session", cwd: "/project" }, newSessionCwd: null, newSessionDraftKey: null }));
}

test("the stored framework is a visible answer exactly once after failed attempts recover", () => {
  const html = render([assistant([{ type: "text", text: "模型最终简述" }], { stopReason: "stop" })]);
  assert.match(html, /完整投资框架/);
  assert.match(html, /投资框架已保存 · 查看处理过程/);
  assert.doesNotMatch(html, /模型最终简述|含失败步骤|处理失败/);
  const answers = seenMessages.filter((item) => item.message.role === "assistant");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].message.content[0].text, report.renderInvestmentFrameworkMarkdown(document));
  assert.equal(answers[0].defaultMermaidPreview, true);
  assert.equal(seenConfirmations.length, 1);
  assert.equal(seenConfirmations[0].showPreview, false);
});

test("a saved framework and confirmation survive absent, empty, failed and interrupted final replies", () => {
  for (const tail of [[], [assistant([])], [assistant([], { stopReason: "error", errorMessage: "模型服务断开" })], [assistant([], { stopReason: "aborted" })]]) {
    const html = render(tail);
    assert.match(html, /完整投资框架/);
    assert.match(html, /确定投资框架/);
    assert.equal(seenMessages.find((item) => item.message.role === "assistant").message.content[0].text, report.renderInvestmentFrameworkMarkdown(document));
    assert.doesNotMatch(html, /模型服务断开/);
  }
});

test("saved framework is immediately readable while follow-up generation is still active", () => {
  const html = render([], { running: true });
  assert.match(html, /完整投资框架/);
  assert.match(html, /确定投资框架/);
  assert.equal(seenConfirmations[0].showPreview, false);
});

test("expanded process retains the real failed follow-up and tool results", () => {
  const html = render([assistant([], { stopReason: "error", errorMessage: "模型服务断开" })], { expanded: true });
  assert.match(html, /模型服务断开/);
  assert.match(html, /投资框架已保存 · 后续回复失败，查看过程/);
  assert.equal(seenMessages.find((item) => item.message.role === "assistant" && item.message.content.some((block) => block.type === "toolCall" && block.toolCallId === "failed")).toolResults.get("failed").isError, true);
});

test("an unsuccessful proposal never invents a saved framework or confirmation", () => {
  const html = render([], { messages: [...messages.slice(0, -1), { ...saved, isError: true }, assistant([], { stopReason: "error", errorMessage: "未保存" })] });
  assert.doesNotMatch(html, /完整投资框架|投资框架已保存|确定投资框架/);
  assert.match(html, /未保存/);
  assert.equal(seenConfirmations.length, 0);
});

test("an exhausted framework timeout has a visible failure even when the tool ends the turn without a final reply", () => {
  const error = "工作簿引用读取连续两次超时，草案尚未保存。请稍后重试。";
  const html = render([], { messages: [messages[0], assistant([call("timeout")]), {
    role: "toolResult", toolCallId: "timeout", toolName: "pe_investment_framework", isError: false,
    content: [{ type: "text", text: error }], details: { kind: "pe_framework_error", error, code: "ETIMEDOUT", attempts: 2, retryExhausted: true, technicalError: "raw workbook diagnostics" },
  }] });
  assert.match(html, /投资框架未保存 · 查看处理过程/);
  assert.ok(html.includes(error));
  assert.doesNotMatch(html, /完整投资框架|投资框架已保存|确定投资框架|raw workbook diagnostics/);
  assert.equal(seenConfirmations.length, 0);
});
