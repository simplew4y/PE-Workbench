import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const { outputText } = ts.transpileModule(readFileSync(new URL("./PeFrameworkPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const coreReport = await jiti.import("../../../packages/pe-boot/src/research/report.ts");
const { frameworkFixture } = await jiti.import("../../../packages/pe-boot/test/fixtures/framework.ts");
const reportExports = {};
const reportCode = ts.transpileModule(readFileSync(new URL("../lib/framework-report.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(reportCode, { exports: reportExports, require: (id) => id === "@earendil-works/pe-boot/framework-report" ? coreReport : require(id) });
const renderedDocuments = [];
runInNewContext(outputText, { exports, URLSearchParams, require: (id) => {
  if (id === "@/lib/framework-report") return reportExports;
  if (id === "@earendil-works/pe-boot/framework-report") return coreReport;
  if (id.endsWith(".css")) return { default: {} };
  if (id === "./PeSourceCitation") return { PeSourceCitation: ({ children }) => React.createElement("button", null, children) };
  if (id === "./MarkdownBody") return { MarkdownBody: ({ children, cwd, defaultMermaidPreview }) => { renderedDocuments.push({ markdown: children, cwd, defaultMermaidPreview }); return React.createElement("div", null, children); } };
  if (id === "./FrameworkTimeline") return { FrameworkTimeline: () => null };
  if (id === "./research-ui/ResearchUI") return {
    FrameworkConfirmation: ({ preview, status }) => React.createElement("div", { "data-confirmation-status": status }, preview),
    ResearchRail: ({ artifacts }) => React.createElement("div", null, artifacts.find((item) => item.id === "framework").content),
  };
  if (["./PeMonitorPanel", "./PeStockTracking"].includes(id)) return {};
  return require(id);
} });

const headings = ["研究设定", "当前判断", "公司如何创造价值", "投资判断与其他解释", "市场预期、估值与回报", "什么情况下我们错了", "证据、未知问题与版本变化"];
const item = { id: "one", kind: "thesis", subject: "短主题", claim: "完整判断不能被截断丢弃", rationale: "缓存值、未重算，不能判断上行空间", verification: "验证条件", invalidation: "失效条件", origin: "research", evidenceIds: ["source:original"] };
const content = frameworkFixture({ items: [item], coverageGaps: ["主体映射未完成：代码待确认"] });

test("seven-section document is the default and preserves reasoning, caveats, evidence and graphics", () => {
  const html = renderToStaticMarkup(React.createElement(exports.FrameworkText, { cwd: "/project", content }));
  const rendered = renderedDocuments.at(-1);
  assert.equal(rendered.markdown, coreReport.renderInvestmentFrameworkMarkdown(content));
  assert.equal(rendered.cwd, "/project");
  assert.equal(rendered.defaultMermaidPreview, true);
  for (const text of [...headings, item.claim, item.rationale, item.verification, item.invalidation, "source%3Aoriginal", "订单交付产生收入", "每季度", "短期补库存"]) assert.ok(rendered.markdown.includes(text), text);
  assert.match(rendered.markdown, /(?:```|~~~)mermaid/);
  assert.match(rendered.markdown, /\|.*订单增长.*\|/);
  assert.match(html, /aria-pressed="true">完整投资框架/);
  assert.match(html, /下载完整投资框架/);
  assert.doesNotMatch(html, /<details/);
});

test("proposal preview, confirmed reader and Markdown download use the same complete document", () => {
  const draft = { id: "draft", revision: 1, baseVersionId: null, status: "open", content };
  const research = { project: { datasetId: "project", root: "/project", name: "公司" }, view: "framework", setView() {}, refresh() {},
    snapshot: { framework: { currentVersionId: null, versions: [], drafts: [draft] }, continuations: [], memos: [] } };
  const proposal = { datasetId: "project", draftId: "draft", revision: 1, toolCallId: "tool-call" };
  renderToStaticMarkup(React.createElement(exports.PeFrameworkConfirmation, { proposal, research, sessionId: "session", ensureEventsConnected: async () => {} }));
  const preview = renderedDocuments.at(-1).markdown;
  const version = { id: "version", version: 1, content };
  const published = { ...research, snapshot: { ...research.snapshot, framework: { ...research.snapshot.framework, currentVersionId: version.id, versions: [version] } } };
  const html = renderToStaticMarkup(React.createElement(exports.PeResearchRail, { research: published }));
  assert.equal(renderedDocuments.at(-1).markdown, preview);
  assert.equal(reportExports.frameworkReportMarkdown(content), preview);
  assert.match(html, /download=version/);
});

test("chat can retain confirmation without repeating an already displayed investment framework", () => {
  const draft = { id: "draft", revision: 1, baseVersionId: null, status: "open", content };
  const research = { project: { datasetId: "project", root: "/project", name: "公司" }, snapshot: { framework: { currentVersionId: null, versions: [], drafts: [draft] }, continuations: [] } };
  const before = renderedDocuments.length;
  const html = renderToStaticMarkup(React.createElement(exports.PeFrameworkConfirmation, {
    proposal: { datasetId: "project", draftId: "draft", revision: 1, toolCallId: "call" }, research,
    sessionId: "session", ensureEventsConnected: async () => {}, showPreview: false,
  }));
  assert.match(html, /data-confirmation-status="draft"/);
  assert.equal(renderedDocuments.length, before);
});

test("legacy versions stay readable without fabricated chapters and legacy drafts cannot be confirmed", () => {
  const legacy = { title: "旧框架", objective: "目标", horizon: "两年", items: [item], coverageGaps: ["缺口"] };
  const html = renderToStaticMarkup(React.createElement(exports.FrameworkText, { content: legacy, cwd: "/project" }));
  assert.match(html, /旧版框架全文/);
  assert.equal(renderedDocuments.at(-1).defaultMermaidPreview, false);
  assert.match(html, /旧版/);
  assert.ok(renderedDocuments.at(-1).markdown.includes(item.rationale));
  assert.doesNotMatch(renderedDocuments.at(-1).markdown, /公司如何创造价值/);
  const research = { project: { datasetId: "project", root: "/project" }, snapshot: { framework: { currentVersionId: null, versions: [], drafts: [{ id: "draft", revision: 1, baseVersionId: null, status: "open", content: legacy }] }, continuations: [] } };
  const confirmation = renderToStaticMarkup(React.createElement(exports.PeFrameworkConfirmation, { research, proposal: { datasetId: "project", draftId: "draft", revision: 1 }, sessionId: "session", ensureEventsConnected: async () => {} }));
  assert.match(confirmation, /重新生成完整投资框架后确认/);
  assert.doesNotMatch(confirmation, /data-confirmation-status/);
});

test("version diff covers changes in all seven sections including evidence and monitoring actions", () => {
  const after = structuredClone(content);
  after.sections.researchSetup.preferences = "保守估值";
  after.sections.currentAssessment.evidenceIds = ["source:new"];
  after.sections.businessModel.drivers[0].mechanism = "新增经营机制";
  after.sections.investmentJudgments.items[0].counterEvidenceIds = ["source:counter"];
  after.sections.valuation.scenarios[0].value = 120;
  after.sections.monitoring.rules[0].action = "下调需求预测";
  after.sections.evidenceAndChanges.coverageGaps = ["新资料缺口"];
  const changes = reportExports.frameworkVersionDiff(content, after);
  assert.equal(changes.length, 7);
  assert.deepEqual(Array.from(changes, (change) => change.title), headings);
  const values = JSON.stringify(changes);
  for (const value of ["source:counter", "source:new", "120", "下调需求预测", "新资料缺口"]) assert.ok(values.includes(value), value);
  assert.equal(reportExports.frameworkVersionDiff(content, content).length, 0);
});

test("version diff includes added, removed, evidence-only and metadata changes", () => {
  const before = {title: "标题", objective: "目标", horizon: "两年", items: [item, {...item,id:"removed"}], coverageGaps: []};
  const after = {...before, horizon: "三年", items: [{...item,evidenceIds:["new"]}, {...item,id:"added"}]};
  const changes = reportExports.frameworkVersionDiff(before, after);
  assert.equal(changes.length, 4);
  assert.equal(changes.find(c => c.id === "one").fields[0].label, "证据引用");
  assert.equal(changes.find(c => c.id === "removed").kind, "移除");
  assert.equal(changes.find(c => c.id === "added").kind, "新增");
  assert.equal(reportExports.frameworkVersionDiff(before,before).length, 0);
  assert.ok(reportExports.frameworkReportMarkdown(before).includes(item.rationale));
  const transition = reportExports.frameworkVersionDiff(before, content);
  assert.equal(transition[0].id, "report-document");
  assert.equal(transition[0].fields[0].after, reportExports.frameworkReportMarkdown(content));
});
