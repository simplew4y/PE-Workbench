import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? SessionManager\.open/);
  }
});

test("session deletion garbage-collects only attachment directories with no surviving references", () => {
  assert.doesNotMatch(detailRoute, /collectReferencedAttachmentDirectories/);
  assert.match(detailRoute, /sessionHeader.id === id/);
  assert.match(detailRoute, /readAttachmentReferenceHistories\(join\(getAgentDir\(\), "sessions"\)\)/);
  assert.match(detailRoute, /removeUnreferencedAttachmentDirectories\(attachmentCandidates, remainingSessionEntries, /);
  assert.match(detailRoute, /getRpcSessionInfos\(\)/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});

test("detail projection preserves ordered context, branch selection and deferred payloads", async (t) => {
  const { GET: getContext } = await jiti.import("./[id]/context/route.ts");
  const previousRegistry = globalThis.__piSessions;
  const id = "projected-route-test";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    { type: "message", id: "root", parentId: null, timestamp, message: { role: "user", content: "question" } },
    { type: "message", id: "answer", parentId: "root", timestamp, message: { role: "assistant", provider: "test", model: "test", content: [{ type: "thinking", thinking: "thinking-secret" }, { type: "text", text: "answer" }] } },
    { type: "message", id: "image", parentId: "answer", timestamp, message: { role: "toolResult", toolCallId: "call", content: [{ type: "image", data: "QUJDRA==", mimeType: "image/png" }] } },
    { type: "message", id: "alternate", parentId: "root", timestamp, message: { role: "user", content: "alternate question" } },
  ];
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => entries,
    getLeafId: () => "image",
    getTree: () => [{ entry: entries[0], children: [
      { entry: entries[1], children: [{ entry: entries[2], children: [] }] },
      { entry: entries[3], children: [] },
    ] }],
    getSessionName: () => undefined,
    getSessionFile: () => "",
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true, inner: { sessionManager }, sessionFile: "", sessionId: id,
  }]]);
  t.after(() => { globalThis.__piSessions = previousRegistry; });
  const params = { params: Promise.resolve({ id }) };
  const read = async (handler, suffix) => {
    const response = await handler(new Request("http://localhost/api/sessions/" + id + suffix), params);
    assert.equal(response.status, 200);
    return response.json();
  };
  const detail = await read(getSessionDetail, "?deferThinking=1&deferMedia=1");
  const history = await read(getContext, "/context?leafId=image&deferThinking=1&deferMedia=1");
  assert.deepEqual(detail.context, history.context);
  assert.deepEqual(detail.context.entryIds, ["root", "answer", "image"]);
  assert.equal(new Set(detail.context.entryIds).size, detail.context.messages.length);
  assert.deepEqual(detail.context.messages.map((m) => m.role), ["user", "assistant", "toolResult"]);
  assert.equal(detail.context.messages[1].content[0].deferred, true);
  assert.ok(!JSON.stringify(detail).includes("thinking-secret"));
  assert.ok(!JSON.stringify(detail).includes("QUJDRA=="));
  const full = await read(getContext, "/context?leafId=image");
  assert.equal(full.context.messages[1].content[0].thinking, "thinking-secret");
  assert.equal(full.context.messages[2].content[0].data, "QUJDRA==");
  const alternate = await read(getContext, "/context?leafId=alternate");
  assert.deepEqual(alternate.context.entryIds, ["root", "alternate"]);
  const again = await read(getSessionDetail, "?deferThinking=1&deferMedia=1");
  assert.deepEqual(again.context, detail.context);
});

test("detail errors still return an explicit failure response", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "failed-route-test";
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    inner: { sessionManager: { getSessionFile() { throw new Error("fixture read failure"); } } },
  }]]);
  t.after(() => { globalThis.__piSessions = previousRegistry; });
  const response = await getSessionDetail(new Request("http://localhost/api/sessions/" + id), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /fixture read failure/);
});
