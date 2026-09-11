import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  MessageView,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("shows complete platform usage with CNY pricing", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "pe-platform",
    model: "deepseek-v4-flash",
    content: [{ type: "text", text: "Done" }],
    usage: {
      input: 1_000,
      output: 200,
      reasoning: 80,
      cacheRead: 300,
      cacheWrite: 0,
      totalTokens: 1_500,
      cost: { input: 0.01, output: 0.01, cacheRead: 0.003, cacheWrite: 0, total: 0.023 },
    },
  });

  assert.match(html, /1,000 in/);
  assert.match(html, /80 reasoning/);
  assert.match(html, /300 cache R/);
  assert.match(html, /0 cache W/);
  assert.match(html, /1,500 total/);
  assert.match(html, /¥0\.0230/);
  assert.doesNotMatch(html, /\$0\.0230/);
});

test("renders pe_render_ui as a native standalone surface instead of tool chrome", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{
      type: "toolCall",
      toolCallId: "call-ui-1",
      toolName: "pe_render_ui",
      input: {
        version: 1,
        component: {
          kind: "company_overview",
          name: "比亚迪",
          metrics: [
            { label: "营业收入", value: "8,039.65 亿元" },
            { label: "归母净利润", value: "326.19 亿元" },
            { label: "员工", value: "869,622 人" },
          ],
        },
      },
    }],
  });

  assert.match(html, /aria-label="company: 比亚迪"/);
  assert.match(html, /data-pe-palette=/);
  assert.match(html, /data-pe-variant=/);
  assert.match(html, /8,039\.65 亿元/);
  assert.doesNotMatch(html, />pe_render_ui</);
});

test("renders pe_render_ui when the provider JSON-encodes component", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{
      type: "toolCall",
      toolCallId: "call-ui-stringified",
      toolName: "pe_render_ui",
      input: {
        version: 1,
        component: JSON.stringify({
          kind: "kpi_strip",
          title: "经营摘要",
          metrics: [
            { label: "收入", value: "100 亿元" },
            { label: "利润", value: "10 亿元" },
          ],
        }),
      },
    }],
  });

  assert.match(html, /经营摘要/);
  assert.match(html, /100 亿元/);
  assert.doesNotMatch(html, /界面数据无效/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});
