import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Compile just this isolated component; CSS is irrelevant to semantic rendering.
const source = readFileSync(new URL("./ResearchUI.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} });
const exports = {};
const require = createRequire(import.meta.url);
function loadLocal(path) {
  const result = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(code, { exports: result, require: localRequire });
  return result;
}
function localRequire(id) {
  if (id.endsWith(".css")) return { default: {} };
  if (id === "@/hooks/useResizablePanel") return loadLocal("../../hooks/useResizablePanel.ts");
  if (id === "@/lib/panel-layout") return loadLocal("../../lib/panel-layout.ts");
  return require(id);
}
runInNewContext(outputText, { exports, require: localRequire });

test("confirmation cannot be submitted while pending, confirmed or stale; version edges are bounded", () => {
  for (const status of ["draft", "pending", "confirmed", "error", "stale"]) {
    const html = renderToStaticMarkup(React.createElement(exports.FrameworkConfirmation, { status, onConfirm() {} }));
    assert.equal(/<button[^>]*disabled/.test(html), ["pending", "confirmed", "stale"].includes(status));
    assert.equal(html.includes('role="alert"'), status === "error");
  }
  for (const selectedId of ["v1", "v2", "missing"]) {
    const html = renderToStaticMarkup(React.createElement(exports.ArtifactVersions, {
      versions: [{ id: "v1", label: "v1" }, { id: "v2", label: "v2" }], selectedId, onSelect() {},
    }));
    const buttons = html.match(/<button[^>]*>/g);
    assert.equal(buttons[0].includes("disabled"), selectedId !== "v2");
    assert.equal(buttons[1].includes("disabled"), selectedId !== "v1");
  }
});

test("all research tabs share the compact width and an accessible resize handle", () => {
  const artifacts = [{ id: "framework", label: "框架", content: "内容" }, { id: "tracking", label: "追踪", content: "图表", wide: true }];
  for (const artifact of artifacts) {
    const html = renderToStaticMarkup(React.createElement(exports.ResearchRail, { artifacts, selectedId: artifact.id, onSelect() {} }));
    assert.match(html, /--research-panel-width:400px/);
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-valuenow="400"/);
    assert.match(html, /aria-label="调整研究面板宽度"/);
  }
  const css = readFileSync(new URL("./research-ui.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.panel\.wide/);
  assert.match(css, /width: var\(--research-panel-width, 400px\)/);
});
