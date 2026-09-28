import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("keeps a generative UI tool call in the final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "prepare verified data" },
    { type: "toolCall", toolCallId: "call-ui", toolName: "pe_render_ui", input: { version: 1 } },
    { type: "text", text: "The main signal is margin compression." },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["toolCall", "text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("preserves deferred thinking source indices when separating process from answer", async () => {
  const { withAssistantBlocks, splitFinalAssistantBlocks, getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);
  const split = splitFinalAssistantBlocks(message);
  const process = withAssistantBlocks(message, split.processBlocks);
  assert.equal(process.content[1], message.content[1]);
  assert.equal(process.content[0].deferred, undefined);
  assert.deepEqual(getDisplayableAssistantBlocks(process), [message.content[1]]);
  assert.deepEqual(getDisplayableAssistantBlocks(withAssistantBlocks(message, split.answerBlocks)), [message.content[2]]);
});

test("separates a visualization from tools without revealing process blocks", async () => {
  const { withAssistantBlocks, getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "private process detail" },
    { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
    { type: "toolCall", toolCallId: "ui-1", toolName: "pe_render_ui", input: {} },
  ]);
  const ui = withAssistantBlocks(message, [message.content[2]]);
  assert.deepEqual(getDisplayableAssistantBlocks(ui), [message.content[2]]);
  assert.deepEqual(getDisplayableAssistantBlocks(withAssistantBlocks(message, message.content.slice(0, 2))), message.content.slice(0, 2));
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("replaces raw platform balance errors with an actionable message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: 'Error: 402: {"message":"insufficient balance","code":"insufficient_balance"}',
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "平台余额不足，暂时无法使用平台模型。请联系管理员充值，或在个人中心 → 模型中切换到自定义模型。",
  );
});

test("hides internal framework confirmations in live and persisted content formats", async () => {
  const { isFrameworkConfirmationMessage } = await loadSubject();
  const text = "[framework-confirmation:601dcab1-ab08-45e4-b0f0-b842d3b43044]\n用户通过确认按钮确定了投资框架 v1";
  assert.equal(isFrameworkConfirmationMessage({ role: "user", content: text }), true);
  assert.equal(isFrameworkConfirmationMessage({ role: "user", content: [{ type: "text", text }] }), true);
  assert.equal(isFrameworkConfirmationMessage({ role: "user", content: "请确认投资框架" }), false);
  assert.equal(isFrameworkConfirmationMessage({ role: "user", content: `解释这条消息：${text}` }), false);
  assert.equal(isFrameworkConfirmationMessage(assistant([{ type: "text", text }])), false);
});
