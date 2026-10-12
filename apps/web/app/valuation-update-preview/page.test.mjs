import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("./preview.module.css", import.meta.url), "utf8");

test("valuation update preview transpiles without syntax diagnostics", () => {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error), []);
});

test("valuation update preview exposes approval, attribution, drill-down and version history", () => {
  assert.match(source, /确认批准并设为基线/);
  assert.match(source, /归因来自按变更组依次重算的结果/);
  assert.match(source, /下游公式路径/);
  assert.match(source, /版本历史/);
  assert.match(source, /reviewNote\.trim\(\)\.length >= 8/);
  assert.match(source, /keepOpenIssue/);
});

test("preview remains usable on narrow screens and presents a native approval dialog", () => {
  assert.match(source, /<dialog ref=\{dialogRef\}/);
  assert.match(source, /dialogRef\.current\?\.showModal\(\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.changeLayout/);
});
