import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const { outputText } = ts.transpileModule(readFileSync(new URL("./PeMonitorPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exports = {};
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const coreReport = await jiti.import("../../../packages/pe-boot/src/research/report.ts");
const { frameworkFixture } = await jiti.import("../../../packages/pe-boot/test/fixtures/framework.ts");
runInNewContext(outputText, { exports, require: (id) => id === "@earendil-works/pe-boot/framework-report" ? coreReport : id.endsWith(".css") ? { default: {} } : id === "./PeSourceCitation" ? { PeSourceCitation: () => null } : require(id) });
const project = { datasetId: "p", root: "/project", companyName: "公司", name: "公司" };
const config = { enabled: true, mode: "review", intervalHours: 24, includeMemos: true, queries: [], objective: "核对" };
const run = { id: "run", startedAt: "2026-09-14T00:00:00Z", status: "review_required", draftId: "draft", events: [], changes: [] };
function render(status, baseVersionId = "current", runStatus = "review_required", mode = "all") {
  return renderToStaticMarkup(React.createElement(exports.PeMonitorPanel, {
    project, mode, refresh() {}, monitor: { config, revision: 1, workerOnline: true, runs: [{ ...run, status: runStatus }] },
    framework: { currentVersionId: "current", drafts: [{ id: "draft", status, revision: 1, baseVersionId, content: frameworkFixture() }], versions: [] },
  }));
}
test("decisions follow the actual draft state; stale suggestions cannot be accepted", () => {
  assert.match(render("open"), /有一份调整建议待你确认/);
  assert.match(render("open", "old"), /<button[^>]*disabled=""[^>]*>接受调整/);
  assert.match(render("published"), /投资框架已更新/);
  assert.doesNotMatch(render("published"), />接受调整</);
  assert.match(render("rejected"), /本次建议未采用/);
  assert.match(render("published", "current", "running"), /正在检查最新资料/);
});

test("monitor reads gaps from seven-section documents and prevents legacy draft publication", () => {
  const html = renderToStaticMarkup(React.createElement(exports.PeMonitorPanel, {
    project, refresh() {}, monitor: { config, revision: 1, workerOnline: true, runs: [run] },
    framework: { currentVersionId: "current", drafts: [{ id: "draft", status: "open", baseVersionId: "current", content: { title: "旧版", objective: "目标", horizon: "一年", items: [], coverageGaps: [] } }],
      versions: [{ id: "current", content: frameworkFixture({ coverageGaps: ["主体仍待核验", "税率未核实"] }) }] },
  }));
  assert.match(html, /主体仍待核验/);
  assert.match(html, /税率未核实/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>接受调整/);
  assert.match(html, /重新生成完整投资框架后确认/);
});
test("settings and history start collapsed, and incomplete checks never imply no change", () => {
  const html = render("rejected", "current", "failed");
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /自动跟踪设置/);
  const empty = renderToStaticMarkup(React.createElement(exports.PeMonitorPanel, {
    project, refresh() {}, monitor: { config, revision: 1, workerOnline: true, runs: [{ ...run, draftId: null, status: "source_error" }] },
    framework: { currentVersionId: "current", drafts: [], versions: [] },
  }));
  assert.match(empty, /本次检查尚未完成/);
  assert.doesNotMatch(empty, /本次复盘未调整框架/);
});

test("header settings view opens controls while activity view omits settings", () => {
  const settings = render("open", "current", "review_required", "settings");
  assert.match(settings, /<details[^>]*open=""/);
  assert.match(settings, /保存设置/);
  assert.doesNotMatch(settings, /有一份调整建议待你确认/);
  const activity = render("open", "current", "review_required", "activity");
  assert.match(activity, /有一份调整建议待你确认/);
  assert.doesNotMatch(activity, /保存设置/);
});
