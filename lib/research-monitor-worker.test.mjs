import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { initializePeCollectionDatabase, saveStockTracker } from "@earendil-works/pe-boot";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { registerStockTrackingWorker } = await jiti.import("./research-monitor-worker.ts");

test("only successful agent configuration starts the worker, and startup failure preserves the saved result", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pe-tracking-hook-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let handler;
  registerStockTrackingWorker({ on(name, callback) { assert.equal(name, "tool_result"); handler = callback; } });
  const details = { kind: "pe_stock_tracking", mutation: "configured", datasetId: "dataset_missing", trackerId: "saved-id" };
  const event = { toolName: "pe_stock_tracking", isError: false, content: [{ type: "text", text: "saved" }], details };
  assert.equal(await handler({ ...event, isError: true }, { cwd }), undefined);
  assert.equal(await handler({ ...event, details: { ...details, mutation: null } }, { cwd }), undefined);
  assert.equal(await handler({ ...event, toolName: "other_tool" }, { cwd }), undefined);
  const result = await handler(event, { cwd });
  assert.equal(result.details.trackerId, "saved-id");
  assert.match(result.details.workerError, /规则已保存.*未能启动/);
  assert.equal(result.content[0].text, "saved");
});

test("shared worker can run a paused tracking project without model configuration or a published framework", { timeout: 15000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pe-tracking-worker-"));
  for (const name of ["raw", "meta", "generated"]) mkdirSync(join(cwd, name));
  const datasetId = "dataset_worker_test";
  initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "Worker test" });
  saveStockTracker(cwd, datasetId, {
    name: "Paused", code: "0700.HK", currency: "HKD", enabled: false,
    startDate: "2026-01-01", targetDate: "2027-12-31", rule: { kind: "fixed", bear: 80, base: 120, bull: 150 },
  }, 0);
  const child = spawn(process.execPath, [resolve("services/pe-research/worker.mjs"), "--cwd", cwd, "--dataset", datasetId, "--monitor", "--once"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent"), PE_RESEARCH_PROVIDER: "", PE_RESEARCH_MODEL: "", WIND_API_KEY: "" },
  });
  t.after(() => { child.kill(); rmSync(cwd, { recursive: true, force: true }); });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  assert.equal(code, 0, stderr);
});
