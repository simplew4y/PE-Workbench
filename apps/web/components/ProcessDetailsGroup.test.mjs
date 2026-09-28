import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("starts collapsed without mounting process content", () => {
  function ExpensiveDetails() {
    throw new Error("Collapsed process content must not mount");
  }
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ProcessDetailsGroup, { label: "读取表格", active: true },
      React.createElement(ExpensiveDetails))));
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(html, /读取表格/);
  assert.match(html, /Expand process details/);
  assert.match(html, /role="status"/);
  assert.match(html, /hidden=""/);
});

test("completed process remains discoverable with no live animation", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ProcessDetailsGroup, { label: "查看处理过程" }, "Tool details")));
  assert.match(html, /查看处理过程/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /role="status"|animate-pulse|Tool details/);
});
