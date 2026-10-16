import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
test("both actions work with no model selection, mappings or date", async () => {
  const source = readFileSync(new URL("./PeFrameworkUpdates.tsx", import.meta.url), "utf8");
  const names = [...source.matchAll(/const \[([\w]+),[^\n]+?= useState/g)].map(match => match[1]);
  const snapshot = { monitor: { revision: 0, config: null, runs: [], manualRequested: false }, modelResult: null, serverRuntime: { available: true }, frameworkRuntime: { available: true } };
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const action of ["立即更新", "开启自动更新"]) {
    let cursor = 0;
    const exports = {};
    const requests = [];
    runInNewContext(code, { exports, URLSearchParams,
      fetch: async (_url, init) => {
        if (init.method === "POST") requests.push(JSON.parse(init.body));
        return Response.json(snapshot);
      },
      require: (id) => id === "react" ? { ...React,
        useState: initial => [names[cursor++] === "snapshot" ? snapshot : initial, () => {}],
        useEffect() {}, useRef: initial => ({ current: initial }), useCallback: fn => fn,
      } : id.endsWith(".css") ? { default: {} } : require(id),
    });
    const tree = exports.PeFrameworkUpdates({ project: { datasetId: "project" }, framework: { currentVersionId: "v1" }, monitor: snapshot.monitor, refresh() {} });
    function buttons(node) {
      if (Array.isArray(node)) return node.flatMap(buttons);
      if (!React.isValidElement(node)) return [];
      return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
    }
    const button = buttons(tree).find(node => node.props.children === action);
    assert.ok(button);
    assert.equal(Boolean(button.props.disabled), false);
    button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [action === "立即更新" ? { datasetId: "project", action: "updates-run" } : { datasetId: "project", action: "updates-save", enabled: true, revision: 0, applyUpdates: true }]);
  }
});

test("framework sidebar has exactly two actions and never requires model or date configuration", () => {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(new URL("./PeFrameworkUpdates.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  runInNewContext(outputText, { exports, URLSearchParams, require: (id) => id.endsWith(".css") ? { default: {} } : id === "./ResearchWorkflowControls" ? { ResearchWorkflowControls: () => null } : require(id) });
  const html = renderToStaticMarkup(React.createElement(exports.PeFrameworkUpdates, {
    project: { datasetId: "project", companyName: "公司", companyTicker: "9660.HK" }, refresh() {},
    framework: { currentVersionId: "v1", versions: [], drafts: [] },
    monitor: { revision: 1, config: { enabled: false, updatePolicy: "direct", mode: "auto", sourceConfig: { trackingWindow: { valuationDate: "2026-06-30" } } }, runs: [{ id: "run", status: "published", startedAt: "2026-10-15", events: [{ stage: "model", detail: "模型已更新2个输入" }], changes: [{ id: "1", before: "预计增长", after: "需求转弱", reason: "本季销量低于预期" }] }] },
  }));
  assert.match(html, /立即更新/);
  assert.match(html, /开启自动更新/);
  assert.equal((html.match(/<button\b/g) || []).length, 2);
  assert.doesNotMatch(html, /<input|<select|绑定|手动选择|更新设置|模型文件与输入/);
  assert.match(html, /本季销量低于预期/);
  assert.match(html, /需求转弱/);
  assert.match(html, /模型已更新2个输入/);
  assert.doesNotMatch(html, /前往统一审阅/);
});
