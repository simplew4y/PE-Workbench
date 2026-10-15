import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as form from "../lib/research-workflow-form.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./ResearchWorkflowControls.tsx", import.meta.url), "utf8");
const stateNames = [...source.matchAll(/const \[([\w]+),[^\n]+?= useState/g)].map(match => match[1]);
const code = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(snapshot) {
  const values = new Map([["snapshot", snapshot]]);
  const requests = [];
  let cursor = 0;
  const exports = {};
  runInNewContext(code, {
    exports, URLSearchParams, crypto, AbortController,
    fetch: async (_url, init) => {
      if (init.method === "POST") requests.push(JSON.parse(init.body));
      return Response.json(init.method === "POST" ? {} : snapshot);
    },
    require(id) {
      if (id === "react") return { ...React,
        useState(initial) {
          const name = stateNames[cursor++];
          assert.ok(name);
          if (!values.has(name)) values.set(name, initial);
          return [values.get(name), value => values.set(name, typeof value === "function" ? value(values.get(name)) : value)];
        },
        useRef: initial => ({ current: initial }), useCallback: callback => callback, useEffect() {},
      };
      if (id.endsWith(".css")) return { default: {} };
      if (id === "@/lib/research-workflow-form") return form;
      return require(id);
    },
  });
  return { requests, render() {
    cursor = 0;
    const wrapper = exports.ResearchWorkflowControls({ datasetId: "project", runId: "round" });
    return wrapper.type(wrapper.props);
  } };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (React.isValidElement(tree)) return text(tree.props.children);
  return typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
function button(tree, label) {
  const found = nodes(tree, node => node.type === "button" && text(node) === label)[0];
  assert.ok(found, label);
  return found;
}
function fixture() {
  return {
    modelConfig: null, modelResult: null, modelVersions: null, modelError: null,
    observations: null, documents: [],
    monitor: { config: { enabled: true, pipeline: "iteration", intervalHours: 24 }, revision: 3, runs: [] },
    serverRuntime: { available: false, modelId: null, reason: "服务端未配置" },
  };
}

test("a model read error leaves rebind and credential-independent pause available", async () => {
  const snapshot = fixture(); snapshot.modelError = "原模型丢失，请重新绑定";
  const app = harness(snapshot);
  const tree = app.render();
  assert.match(text(tree), /原模型丢失/);
  assert.equal(button(tree, "绑定模型输入").props.disabled, false);
  const pause = button(tree, "立即暂停追踪");
  assert.equal(pause.props.disabled, false);
  pause.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.requests, [{ action: "monitor-pause", datasetId: "project", runId: "round", revision: 3 }]);
});

test("saving edits while paused sends the new interval rather than a pause-only request", async () => {
  const snapshot = fixture(); snapshot.monitor.config.enabled = false;
  const app = harness(snapshot);
  const interval = nodes(app.render(), node => node.type === "input" && node.props.type === "number")[0];
  interval.props.onChange({ target: { value: "48" } });
  const save = button(app.render(), "保存追踪设置");
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests[0].action, "monitor-save");
  assert.equal(app.requests[0].intervalHours, 48);
  assert.equal(app.requests[0].enabled, false);
});

test("promotion history remains visible after another version becomes the current model", () => {
  const snapshot = fixture();
  snapshot.modelResult = {
    status: "candidate", modelVersionId: "model-a", proposal: [], manualProposals: [], skips: [],
    promotionReceipt: { actor: "researcher", promotedAt: "2026-10-12T00:00:00Z", configRevisionBefore: 1, configRevisionAfter: 2 },
  };
  snapshot.modelVersions = { current_version_id: "model-b" };
  const tree = harness(snapshot).render();
  assert.match(text(tree), /本轮模型已验收采用/);
  assert.match(text(tree), /曾采用 · 已非当前基线/);
  assert.match(text(tree), /操作者 researcher/);
  assert.doesNotMatch(text(tree), /保留原基线|设为下一轮模型基线|尚未替换基线/);
  snapshot.modelVersions.current_version_id = "model-a";
  assert.match(text(harness(snapshot).render()), /当前模型基线/);
});
