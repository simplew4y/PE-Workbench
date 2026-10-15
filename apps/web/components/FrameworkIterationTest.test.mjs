import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as helpers from "./framework-iteration-workspace.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./FrameworkIterationTest.tsx", import.meta.url), "utf8");
const stateNames = [...source.matchAll(/const \[([\w]+),[^\n]+?= useState/g)].map(match => match[1]);
const code = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(status = "review_required") {
  const run = { id: "run-1", status, stage: "publish", sourceMode: "sources", basisVersionId: "v1", createdAt: "2026-10-12T00:00:00Z", modelId: "real-model", changeReview: true, usage: [], diagnostics: [], artifacts: [], reviewReasons: [], inputs: [], sourceConfig: { companyName: "Company", companyTicker: "1234.HK" } };
  return { run, runRuntime: "platform", files: [], runs: [run], nextCursor: null, settings: { testProject: false }, framework: { currentVersionId: "v1", versions: [{ id: "v1", version: 1, content: { title: "Saved framework", sections: {} } }], drafts: [] }, modelId: "real-model", modelError: null, changeReview: { plan: { id: "plan-1", changes: [] }, events: [], revision: 2 }, sourceQueries: [], sourceData: [], availableSources: [{ id: "wind-financials", available: true }] };
}

function harness(overrides = {}, request = async () => { throw new Error("Unexpected network request"); }) {
  const values = new Map(Object.entries({ projects: [{ datasetId: "project", root: "/project", name: "Project", companyName: "Company", companyTicker: "1234.HK" }], datasetId: "project", runId: "run-1", snapshot: fixture(), view: "overview", initializing: false, inputMode: "sources", ...overrides }));
  const refs = [];
  const effects = [];
  let stateCursor = 0;
  let refCursor = 0;
  const exports = {};
  runInNewContext(code, {
    exports, FormData, crypto, URLSearchParams, AbortController, Error, fetch: request,
    document: { getElementById: () => null },
    require(id) {
      if (id === "react") return { ...React,
        useState(initial) {
          const name = stateNames[stateCursor++];
          assert.ok(name, "Every state hook must be named in the component");
          if (!values.has(name)) values.set(name, initial);
          return [values.get(name), value => values.set(name, typeof value === "function" ? value(values.get(name)) : value)];
        },
        useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
        useEffect(effect) { effects.push(effect); }, useCallback(callback) { return callback; },
      };
      if (id.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
      if (id === "next/link") return { default: "a" };
      if (id === "./framework-iteration-workspace") return helpers;
      if (id === "@/lib/iteration-source-data") return { windReviewTasks: () => [] };
      if (id === "@/lib/pe-account-client") return {};
      if (id.startsWith("./")) return new Proxy({}, { get: (_, key) => String(key) });
      return require(id);
    },
  });
  function render(workspace = true) {
    stateCursor = 0; refCursor = 0; effects.length = 0;
    const tree = exports.FrameworkIterationTest({ workspace });
    effects[0]();
    effects[1]();
    return tree;
  }
  return { render, values };
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
  assert.ok(found, `Button ${label} exists`);
  return found;
}

test("workspace separates overview, updates, evidence and full version history", () => {
  const app = harness();
  let tree = app.render();
  assert.match(text(tree), /研究追踪工作台/);
  assert.match(text(tree), /当前研究结果 · v1/);
  assert.equal(nodes(tree, node => node.type === "FrameworkChangeReview").length, 0);
  button(tree, "本轮更新1 待审").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, node => node.type === "FrameworkChangeReview").length, 1);
  assert.equal(nodes(tree, node => node.type === "IterationSourceData").length, 0);
  assert.equal(nodes(tree, node => node.props["aria-current"] === "step").length, 1);
  button(tree, "证据").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, node => node.type === "IterationSourceData").length, 1);
  assert.equal(nodes(tree, node => node.type === "FrameworkChangeReview").length, 0);
});

test("model failure disables startup without hiding history or review", () => {
  const snapshot = fixture(); snapshot.modelId = ""; snapshot.modelError = "余额不足";
  const app = harness({ snapshot, platform: { source: "platform", platform: { selected_model: "old-model" } }, view: "updates" });
  const tree = app.render();
  assert.match(text(tree), /余额不足/);
  assert.equal(button(tree, "采集并开始更新").props.disabled, true);
  const review = nodes(tree, node => node.type === "FrameworkChangeReview")[0];
  assert.equal(review.props.editable, true);
  assert.equal(review.props.busy, false);
  assert.equal(nodes(tree, node => node.type === "select")[1].props.children[1].length, 1);
});

test("missing and legacy baselines have actionable guidance and no start", () => {
  for (const legacy of [false, true]) {
    const snapshot = fixture();
    snapshot.framework = { currentVersionId: legacy ? "legacy" : null, versions: legacy ? [{ id: "legacy", version: 1, content: { title: "old" } }] : [], drafts: [] };
    const tree = harness({ snapshot }).render();
    assert.match(text(tree), /先确认一份完整研究基线/);
    assert.equal(button(tree, "采集并开始更新").props.disabled, true);
    assert.ok(nodes(tree, node => node.type === "a" && node.props.href === "/").length);
  }
});

test("all rounds remain selectable including entries beyond the first eight", () => {
  const snapshot = fixture();
  snapshot.runs = Array.from({ length: 13 }, (_, index) => ({ ...snapshot.run, id: `run-${index}`, status: index % 2 ? "failed" : "published" }));
  const app = harness({ snapshot, view: "history" });
  const tree = app.render();
  const history = nodes(tree, node => node.props["aria-current"] === "page" && node.type === "button");
  assert.ok(history.length);
  const entries = nodes(tree, node => node.type === "button" && text(node).includes("基线") === false && text(node).startsWith("v1 →"));
  assert.equal(entries.length, 13);
  entries[12].props.onClick();
  assert.equal(app.values.get("runId"), "run-12");
  assert.equal(app.values.get("snapshot"), null);
  assert.equal(app.values.get("view"), "updates");
});

test("double click sends once; uncertain retries reuse request and baseline even after a newer publication", async () => {
  const requests = [];
  const snapshot = fixture(); snapshot.run = null; snapshot.runs = [];
  const app = harness({ snapshot, runId: "" }, async (_url, init) => {
    requests.push(init);
    if (requests.length === 1) throw new Error("connection lost");
    return Response.json({ run: { id: "saved-run" } });
  });
  let tree = app.render();
  const start = button(tree, "采集并开始更新");
  start.props.onClick(); start.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(app.values.get("retrySubmission"), true);
  snapshot.framework.currentVersionId = "v2";
  snapshot.framework.versions.push({ id: "v2", version: 2, content: { sections: {} } });
  snapshot.runs.push({ ...fixture().run, status: "running" });
  tree = app.render();
  const retry = button(tree, "重试原启动请求");
  assert.equal(retry.props.disabled, false);
  retry.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[1].body).basisVersionId, "v1");
  assert.equal(app.values.get("runId"), "saved-run");
  assert.equal(app.values.get("retrySubmission"), false);
});

test("stale reads disable publishing, while original test route keeps real controls", () => {
  const app = harness({ loadError: "offline", view: "updates" });
  const tree = app.render(false);
  assert.match(text(tree), /投资框架迭代测试/);
  assert.equal(nodes(tree, node => node.type === "FrameworkChangeReview")[0].props.busy, true);
  assert.match(text(tree), /调试与执行记录/);
  assert.match(text(tree), /全部迭代轮次/);
});

test("model and tracking controls receive the real selection in a full-width view", () => {
  const app = harness({ view: "model" });
  const tree = app.render();
  const controls = nodes(tree, node => node.type === "ResearchWorkflowControls")[0];
  assert.equal(controls.props.datasetId, "project");
  assert.equal(controls.props.runId, "run-1");
  assert.equal(typeof controls.props.onRefresh, "function");
  assert.equal(nodes(tree, node => node.type === "aside")[0].props.hidden, true);
  assert.equal(nodes(tree, node => node.props["data-wide"] === true).length, 1);
});

test("server runtime does not present an unknown supplier bill as zero platform cost", () => {
  const snapshot = fixture();
  snapshot.runRuntime = "server";
  snapshot.run.diagnostics.push({ tool: "pe_server_runtime" });
  const tree = harness({ snapshot, view: "updates" }).render();
  assert.match(text(tree), /供应商计费，未估算/);
  assert.doesNotMatch(text(tree), /¥0|实际费用以平台结算为准/);
});

test("server runs resume without a platform model in both workspace and test views", async () => {
  for (const status of ["blocked", "failed", "queued"]) {
    for (const workspace of [true, false]) {
      const snapshot = fixture(status);
      snapshot.runRuntime = "server";
      snapshot.modelId = ""; snapshot.modelError = "平台模型不可用";
      snapshot.run.diagnostics.push({ tool: "pe_server_runtime" });
      const posts = [];
      const app = harness({ snapshot, view: "updates" }, async (_url, init) => {
        if (init.method === "POST") {
          posts.push(JSON.parse(init.body));
          return Response.json({ run: snapshot.run });
        }
        return Response.json(snapshot);
      });
      const tree = app.render(workspace);
      const resume = button(tree, "从有效检查点恢复");
      assert.equal(resume.props.disabled, false);
      assert.equal(button(tree, "采集并开始更新").props.disabled, true);
      resume.props.onClick();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(posts, [{ datasetId: "project", runId: "run-1", action: "resume" }]);
      assert.equal(app.values.get("error"), "");
    }
  }
});

test("resume still respects busy, stale snapshots and platform-run model availability", () => {
  for (const options of [{ server: false }, { server: true, busy: true }, { server: true, loadError: "offline" }]) {
    const snapshot = fixture("blocked"); snapshot.modelId = "";
    if (options.server) { snapshot.runRuntime = "server"; snapshot.run.diagnostics.push({ tool: "pe_server_runtime" }); }
    const tree = harness({ snapshot, view: "updates", busy: options.busy ?? false, loadError: options.loadError ?? "" }).render();
    assert.equal(button(tree, "从有效检查点恢复").props.disabled, true);
  }
});

test("monitor-linked server run without a runtime marker can resume and uses supplier billing", async () => {
  const snapshot = fixture("failed");
  snapshot.runRuntime = "server"; snapshot.modelId = ""; snapshot.modelError = "平台模型不可用";
  assert.deepEqual(snapshot.run.diagnostics, []);
  const posts = [];
  const app = harness({ snapshot, view: "updates" }, async (_url, init) => {
    if (init.method === "POST") posts.push(JSON.parse(init.body));
    return Response.json(snapshot);
  });
  const tree = app.render();
  const resume = button(tree, "从有效检查点恢复");
  assert.equal(resume.props.disabled, false);
  assert.match(text(tree), /供应商计费，未估算/);
  assert.doesNotMatch(text(tree), /¥0|实际费用以平台结算为准/);
  resume.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posts, [{ datasetId: "project", runId: "run-1", action: "resume" }]);
});

test("an old control refresh cannot fetch a previously selected project", async () => {
  let requests = 0;
  const app = harness({ view: "model" }, async () => { requests++; return Response.json(fixture()); });
  let tree = app.render();
  const controls = nodes(tree, node => node.type === "ResearchWorkflowControls")[0];
  const projectSelect = nodes(tree, node => node.type === "select" && node.props.value === "project")[0];
  projectSelect.props.onChange({ target: { value: "other-project" } });
  tree = app.render();
  await controls.props.onRefresh();
  assert.equal(requests, 0);
  assert.equal(nodes(tree, node => node.type === "ResearchWorkflowControls")[0].props.datasetId, "other-project");
});

test("history pages load only on demand, deduplicate double clicks and survive snapshot polling", async () => {
  const snapshot = fixture(); snapshot.nextCursor = "run-1";
  const older = { ...snapshot.run, id: "older", createdAt: "2026-10-11T00:00:00Z" };
  const pending = Promise.withResolvers();
  const requests = [];
  const app = harness({ snapshot, view: "history" }, async url => {
    requests.push(url);
    return url.includes("historyOnly=1") ? pending.promise : Response.json(snapshot);
  });
  let tree = app.render();
  assert.equal(requests.length, 0);
  const more = button(tree, "加载更早轮次");
  more.props.onClick(); more.props.onClick();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /datasetId=project&historyOnly=1&historyBefore=run-1/);
  tree = app.render();
  assert.equal(button(tree, "正在加载历史…").props.disabled, true);
  pending.resolve(Response.json({ runs: [snapshot.run, older], nextCursor: "older" }));
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.match(text(tree), /已加载 2/);
  assert.equal(requests.length, 1);
  button(tree, "模型与追踪").props.onClick();
  tree = app.render();
  const controls = nodes(tree, node => node.type === "ResearchWorkflowControls")[0];
  await controls.props.onRefresh();
  tree = app.render();
  assert.ok(nodes(tree, node => node.type === "option" && node.props.value === "older").length);
  assert.equal(app.values.get("history").nextCursor, "older");
  assert.equal(app.values.get("history").runs.length, 2);
  assert.equal(requests.filter(url => url.includes("historyOnly=1")).length, 1);
});

test("failed history page keeps existing rounds and retries the same cursor", async () => {
  const snapshot = fixture(); snapshot.nextCursor = "run-1";
  const requests = [];
  const app = harness({ snapshot, view: "history" }, async url => {
    requests.push(url);
    if (requests.length === 1) throw new Error("history offline");
    return Response.json({ runs: [], nextCursor: null });
  });
  button(app.render(), "加载更早轮次").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  let tree = app.render();
  assert.match(text(tree), /history offline/);
  assert.match(text(tree), /已加载 1/);
  snapshot.nextCursor = "new-head-cursor";
  tree = app.render();
  button(tree, "重试加载历史").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = app.render();
  assert.equal(requests[0], requests[1]);
  assert.match(text(tree), /已到历史末尾/);
  assert.doesNotMatch(text(tree), /history offline/);
});

for (const fail of [false, true]) {
  test(`switching project clears history and ignores a late page ${fail ? "error" : "response"}`, async () => {
    const snapshot = fixture(); snapshot.nextCursor = "run-1";
    const pending = Promise.withResolvers();
    let signal;
    const app = harness({ snapshot, view: "history" }, async (_url, init) => { signal = init.signal; return pending.promise; });
    button(app.render(), "加载更早轮次").props.onClick();
    const tree = app.render();
    nodes(tree, node => node.type === "select" && node.props.value === "project")[0].props.onChange({ target: { value: "other" } });
    assert.equal(signal.aborted, true);
    assert.equal(app.values.get("history"), null);
    assert.equal(app.values.get("historyLoading"), false);
    if (fail) pending.reject(new Error("old project failed"));
    else pending.resolve(Response.json({ runs: [snapshot.run], nextCursor: "run-1" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.values.get("history"), null);
    assert.equal(app.values.get("historyError"), "");
    assert.equal(app.values.get("historyLoading"), false);
  });
}
