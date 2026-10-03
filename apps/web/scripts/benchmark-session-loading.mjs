import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { createJiti } from "jiti";

// Run from apps/web. Uses isolated synthetic data; never calls a model.
const root = mkdtempSync(join(tmpdir(), "pe-session-load-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
const jiti = createJiti(import.meta.url, { alias: { "@": resolve(".") } });
const { GET: detail } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { GET: context } = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { projectTreeForResponse } = await jiti.import("../lib/project-tree.ts");
const { computeSessionTotalActiveMs } = await jiti.import("../lib/session-timing.ts");
const stamp = "2026-01-01T00:00:00.000Z";
const message = (id, parentId, role, content) => ({ type: "message", id, parentId, timestamp: stamp, message: { role, content, ...(role === "assistant" ? { provider: "test", model: "test" } : {}) } });
let seed = 12345;
function payload(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes.toString("base64");
}
const fixtures = [];
function fixture(id, entries) {
  const dir = join(root, "sessions", "fixtures");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, id + ".jsonl");
  writeFileSync(file, [{ type: "session", version: 3, id, timestamp: stamp, cwd: root }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  fixtures.push({ id, file });
}
for (const count of [20, 5000]) {
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(message("m" + i, i ? "m" + (i - 1) : null, i % 2 ? "assistant" : "user", i % 2 ? [{ type: "text", text: "answer " + i + " " + "history ".repeat(64) }] : "question " + i));
  fixture("linear-" + count, entries);
}
const branches = [message("root", null, "user", "inspect branches")];
for (let i = 0; i < 24; i++) {
  branches.push(message("a" + i, "root", "assistant", [{ type: "thinking", thinking: payload(64 * 1024) }, { type: "text", text: "branch " + i }]));
  branches.push(message("t" + i, "a" + i, "toolResult", [{ type: "image", data: payload(256 * 1024), mimeType: "image/png" }]));
}
fixture("branched-media", branches);
const summary = (values) => ({ median: +[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2), min: +Math.min(...values).toFixed(2), max: +Math.max(...values).toFixed(2), samples: values.map((v) => +v.toFixed(2)) });
async function request(id, history = false) {
  const url = "http://127.0.0.1/api/sessions/" + id + (history ? "/context" : "") + "?deferThinking=1&deferMedia=1";
  return (history ? context : detail)(new Request(url), { params: Promise.resolve({ id }) });
}
const report = { node: process.version, samples: 9, fixtures: [], network: [] };
try {
  for (const item of fixtures) {
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    globalThis.__piSessionListCache = undefined;
    const start = performance.now();
    const first = await request(item.id);
    const body = await first.text();
    assert.equal(first.status, 200, body.slice(0, 200));
    const firstMs = performance.now() - start;
    const parsed = JSON.parse(body);
    const timings = { read: [], tree: [], context: [], timing: [], serialize: [], switch: [], history: [] };
    for (let i = 0; i < 9; i++) {
      let t = performance.now();
      const sm = SessionManager.open(item.file);
      const entries = sm.getEntries();
      timings.read.push(performance.now() - t);
      t = performance.now(); const tree = projectTreeForResponse(sm.getTree()); timings.tree.push(performance.now() - t);
      t = performance.now(); const ctx = buildSessionContext(entries, sm.getLeafId(), { deferThinking: true, deferToolResultImages: true }); timings.context.push(performance.now() - t);
      t = performance.now(); computeSessionTotalActiveMs(entries); timings.timing.push(performance.now() - t);
      t = performance.now(); JSON.stringify({ tree, context: ctx }); timings.serialize.push(performance.now() - t);
      t = performance.now(); const response = await request(item.id); const result = await response.json(); timings.switch.push(performance.now() - t);
      assert.deepEqual(result.context, parsed.context);
      t = performance.now(); const history = await (await request(item.id, true)).json(); timings.history.push(performance.now() - t);
      assert.deepEqual(history.context, parsed.context);
    }
    report.fixtures.push({ id: item.id, firstMs: +firstMs.toFixed(2), responseBytes: Buffer.byteLength(body), gzipBytes: gzipSync(body).length, contextHash: createHash("sha256").update(JSON.stringify(parsed.context)).digest("hex"), messageCount: parsed.context.messages.length, timings: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summary(values)])) });
  }
  // Real handler over controlled HTTP: gzip + 20 Mbit/s + 40 ms request delay.
  // Excludes Next compilation and browser DOM rendering.
  const server = createServer(async (req, res) => {
    try {
      await delay(40);
      const response = await request(req.url.slice(1));
      const compressed = gzipSync(await response.text());
      res.writeHead(response.status, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
      for (let offset = 0; offset < compressed.length; offset += 64 * 1024) {
        const chunk = compressed.subarray(offset, offset + 64 * 1024);
        await delay(chunk.length / 2500);
        res.write(chunk);
      }
      res.end();
    } catch (error) { res.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const item of fixtures) {
      const elapsed = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/" + item.id);
        const result = await response.json();
        assert.equal(result.sessionId, item.id);
        elapsed.push(performance.now() - t);
      }
      report.network.push({ id: item.id, milliseconds: summary(elapsed) });
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
