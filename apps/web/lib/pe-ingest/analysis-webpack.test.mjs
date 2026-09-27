import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import webpackModule from "next/dist/compiled/webpack/webpack.js";

test("analysis module compiles for Node without import.meta warnings", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pe-analysis-webpack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(new URL("./analysis.ts", import.meta.url), "utf8");
  writeFileSync(path.join(root, "entry.mjs"), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText);
  const compiler = webpackModule.webpack({
    mode: "development", target: "node", devtool: false,
    entry: path.join(root, "entry.mjs"),
    output: { path: path.join(root, "output"), filename: "analysis.cjs" },
    // Keep Node dependencies external, as in the application's server bundle.
    externals: [({ request }, callback) => path.isAbsolute(request) ? callback() : callback(null, `commonjs ${request}`)],
    module: { parser: { javascript: { url: false } } },
  });
  t.after(() => new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve())));
  const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
  const { errors, warnings } = stats.toJson({ all: false, errors: true, warnings: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
