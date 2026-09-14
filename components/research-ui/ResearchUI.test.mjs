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
runInNewContext(outputText, { exports, require: (id) => id.endsWith(".css") ? { default: {} } : require(id) });

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
