import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the hook's actual async callbacks with controlled fetch completion.
// React rendering and scrolling are covered separately by browser acceptance.
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const names = ["loadSession", "loadContext", "handleNavigate", "handleLeafChange"];
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of names) assert.ok(declarations.has(name), name);
const code = ts.transpileModule(
  names.map((name) => `const ${declarations.get(name)};`).join("\n")
    + `\n({ ${names.join(", ")} });`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness() {
  const state = { messages: ["original"], entryIds: ["original"], activeLeafId: "original", loading: false, error: null };
  const requests = [];
  const commands = [];
  const scope = {
    useCallback: (fn) => fn,
    URLSearchParams,
    console,
    sessionIdRef: { current: "session" },
    sessionHookMountedRef: { current: true },
    historyLoadIdRef: { current: 0 },
    modelSwitchPendingRef: { current: false },
    bashRunningRef: { current: false },
    normalizeQueuedMessages: (value) => value,
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    sendAgentCommand: async (sid, command) => { commands.push({ sid, ...command }); },
  };
  for (const key of ["messages", "entryIds", "activeLeafId", "loading", "error", "data",
    "currentModelOverride", "thinkingLevel", "contextUsage", "systemPrompt",
    "extensionStatuses", "extensionWidgets", "queuedMessages"]) {
    scope["set" + key[0].toUpperCase() + key.slice(1)] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
  }
  const callbacks = vm.runInNewContext(code, scope);
  const respond = (index, leaf, status = 200) => requests[index].resolve({
    status, ok: status >= 200 && status < 300,
    json: async () => ({ leafId: leaf, context: { messages: [leaf], entryIds: [leaf] } }),
  });
  return { ...callbacks, state, requests, commands, scope, respond };
}

test("late branch success cannot replace the latest messages, IDs, leaf or navigation command", async () => {
  const h = harness();
  const first = h.handleLeafChange("first");
  const second = h.handleLeafChange("second");
  assert.equal(h.state.loading, true);
  h.respond(1, "second");
  await second;
  h.respond(0, "first");
  await first;
  assert.deepEqual(h.state.messages, ["second"]);
  assert.deepEqual(h.state.entryIds, ["second"]);
  assert.equal(h.state.activeLeafId, "second");
  assert.equal(h.state.loading, false);
  assert.deepEqual(h.commands, [{ sid: "session", type: "navigate_tree", targetId: "second" }]);
});

test("late branch failure cannot replace a successful branch with an error", async () => {
  const h = harness();
  const old = h.loadContext("session", "old");
  const current = h.loadContext("session", "current");
  h.respond(1, "current");
  assert.equal(await current, true);
  h.requests[0].reject(new Error("offline"));
  assert.equal(await old, false);
  assert.equal(h.state.error, null);
  assert.deepEqual(h.state.messages, ["current"]);
});

test("older completion cannot dismiss a newer request's loading indicator", async () => {
  const h = harness();
  const old = h.loadContext("session", "old");
  const current = h.loadContext("session", "current");
  h.respond(0, "old");
  await old;
  assert.equal(h.state.loading, true);
  assert.equal(h.state.activeLeafId, "original");
  h.respond(1, "current");
  await current;
  assert.equal(h.state.loading, false);
});

test("branch failure is visible and retry recovers without premature backend navigation", async () => {
  const h = harness();
  const failed = h.handleNavigate("failed");
  h.respond(0, "failed", 500);
  await failed;
  assert.match(h.state.error, /HTTP 500/);
  assert.equal(h.state.loading, false);
  assert.equal(h.state.activeLeafId, "original");
  assert.deepEqual(h.commands, []);
  const retry = h.handleNavigate("retry");
  assert.equal(h.state.loading, true);
  h.respond(1, "retry");
  await retry;
  assert.equal(h.state.error, null);
  assert.equal(h.state.activeLeafId, "retry");
  assert.deepEqual(h.commands, [{ sid: "session", type: "navigate_tree", targetId: "retry" }]);
});

test("late initial session fetch cannot overwrite a newer branch choice", async () => {
  const h = harness();
  const initial = h.loadSession("session", true);
  const branch = h.loadContext("session", "branch");
  h.respond(1, "branch");
  await branch;
  h.respond(0, "initial");
  await initial;
  assert.deepEqual(h.state.messages, ["branch"]);
  assert.equal(h.state.activeLeafId, "branch");
});

test("newer session refresh supersedes pending branch data and clears its loader", async () => {
  const h = harness();
  const branch = h.loadContext("session", "branch");
  const refresh = h.loadSession("session");
  h.respond(1, "refresh");
  await refresh;
  h.respond(0, "branch");
  await branch;
  assert.deepEqual(h.state.messages, ["refresh"]);
  assert.equal(h.state.loading, false);
});

test("session switch and unmount prevent late branch navigation and state updates", async () => {
  for (const invalidate of [
    (h) => { h.scope.sessionIdRef.current = "other"; },
    (h) => { h.scope.sessionHookMountedRef.current = false; },
    (h) => { h.scope.historyLoadIdRef.current += 1; },
  ]) {
    const h = harness();
    const pending = h.handleLeafChange("old");
    invalidate(h);
    h.respond(0, "old");
    await pending;
    assert.deepEqual(h.state.messages, ["original"]);
    assert.deepEqual(h.commands, []);
  }
});

test("messages are usable while optional state is pending; late state cannot overwrite a branch", async () => {
  const h = harness();
  const initial = h.loadSession("session", true, true);
  h.respond(0, "initial");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].url, /\/state$/);
  assert.equal(h.state.loading, false);
  assert.deepEqual(h.state.messages, ["initial"]);
  const branch = h.loadContext("session", "branch");
  h.respond(2, "branch");
  await branch;
  h.requests[1].resolve({
    ok: true, json: async () => ({ running: true, state: { systemPrompt: "stale" } }),
  });
  assert.equal(await initial, null);
  assert.equal(h.state.systemPrompt, undefined);
  assert.deepEqual(h.state.messages, ["branch"]);
});

test("late detail 404 and network failure cannot clear newer content or set errors", async () => {
  for (const failure of ["404", "network"]) {
    const h = harness();
    const old = h.loadSession("session", true);
    const current = h.loadSession("session", true);
    h.respond(1, "current");
    await current;
    if (failure === "404") h.respond(0, "old", 404);
    else h.requests[0].reject(new Error("offline"));
    await old;
    assert.deepEqual(h.state.messages, ["current"]);
    assert.equal(h.state.error, null);
    assert.equal(h.state.loading, false);
  }
});
