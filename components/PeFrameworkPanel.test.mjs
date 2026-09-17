import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const { outputText } = ts.transpileModule(readFileSync(new URL("./PeFrameworkPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
const require = createRequire(import.meta.url);
const reportExports = {};
const reportCode = ts.transpileModule(readFileSync(new URL("../lib/framework-report.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(reportCode, {exports: reportExports});
runInNewContext(outputText, { exports, require: (id) => id === "@/lib/framework-report" ? reportExports : id.endsWith(".css") ? { default: {} } : id === "./PeSourceCitation" ? { PeSourceCitation: ({children}) => React.createElement("button", null, children) } : ["./MarkdownBody", "./PeMonitorPanel", "./PeStockTracking", "./FrameworkTimeline", "./research-ui/ResearchUI"].includes(id) ? {} : require(id) });
test("framework keeps complete claims and evidence behind short subject headings", () => {
  const item = { id: "one", kind: "thesis", subject: "短主题", claim: "完整判断不能被截断丢弃", rationale: "原始依据", verification: "验证条件", invalidation: "失效条件", origin: "research", evidenceIds: ["e1"] };
  const html = renderToStaticMarkup(React.createElement(exports.FrameworkText, { cwd: "/project", content: { title: "框架", objective: "目标", horizon: "期限", items: [item], coverageGaps: ["缺少资料"] } }));
  assert.match(html, /<h3>短主题<\/h3>/);
  for (const text of [item.claim, item.verification, item.invalidation, "来源 ", "核心论点", "缺少资料"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
});

test("complete report is the default and Markdown includes every section and reference", () => {
  const content = { title: "报告", objective: "研究目标全文", horizon: "两年", items: [{ id: "a", kind: "question", subject: "问题", claim: "判断", rationale: "依据", verification: "验证", invalidation: "失效", origin: "user", evidenceIds: ["evidence-123"] }], coverageGaps: ["缺口"] };
  const markdown = exports.frameworkReportMarkdown(content);
  for (const value of [content.title, content.objective, content.horizon, "问题", "判断", "验证", "失效", "evidence-123", "缺口", "用户假设"]) assert.ok(markdown.includes(value), value);
  const html = renderToStaticMarkup(React.createElement(exports.FrameworkText, {content, cwd: "/project"}));
  assert.match(html, /aria-pressed="true">完整报告/);
  assert.match(html, /下载完整报告/);
  assert.doesNotMatch(html, /<details/);
});

test("reader formatting separates evidence and keeps material uncertainty", () => {
  const parts = reportExports.reportParagraphs("原判断：47×49.745=2,338.03（缓存值、未重算）。新证据：现价尚未核实；不能判断上行空间。Memo并非事实证据。");
  assert.ok(parts.length >= 4);
  assert.ok(parts.join("").includes("47×49.745=2,338.03"));
  assert.ok(parts.join("").includes("不能判断上行空间"));
  assert.ok(!parts.join("").includes("缓存值"));
  const gaps = reportExports.reportCoverage(["Memo 列表为空，无需归并", "主体映射未完成：代码待确认", "缺少原始财报"]);
  assert.equal(gaps.length, 2);
  assert.ok(gaps[0].includes("暂不能直接用于投资判断"));
});

test("paragraph breaks do not split parenthetical explanations", () => {
  const parts = reportExports.reportParagraphs("模型（盈利预测；敏感性）为依据。判断待验证。");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "模型（盈利预测；敏感性）为依据。");
});

test("version diff includes added, removed, evidence-only and metadata changes", () => {
  const item = {id: "a", subject: "主题", kind: "thesis", claim: "判断", rationale: "原因", verification: "验证", invalidation: "失效", origin: "research", evidenceIds: ["old"]};
  const before = {title: "标题", objective: "目标", horizon: "两年", items: [item, {...item,id:"removed"}], coverageGaps: []};
  const after = {...before, horizon: "三年", items: [{...item,evidenceIds:["new"]}, {...item,id:"added"}]};
  const changes = reportExports.frameworkVersionDiff(before, after);
  assert.equal(changes.length, 4);
  assert.equal(changes.find(c => c.id === "a").fields[0].label, "证据引用");
  assert.equal(changes.find(c => c.id === "removed").kind, "移除");
  assert.equal(changes.find(c => c.id === "added").kind, "新增");
  assert.equal(reportExports.frameworkVersionDiff(before,before).length, 0);
  assert.ok(!reportExports.frameworkReportMarkdown(before).includes("原因"));
});
