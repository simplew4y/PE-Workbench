import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getResearchMonitor, getStockTracking } from "@earendil-works/pe-boot";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

// The chat tool persists configuration; the web host owns the background process.
export function registerStockTrackingWorker(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "pe_stock_tracking" || event.isError || !event.details || typeof event.details !== "object") return;
    const details = event.details as Record<string, unknown>;
    if (details.kind !== "pe_stock_tracking" || details.mutation !== "configured" || typeof details.datasetId !== "string") return;
    try { await ensureResearchMonitorWorker(ctx.cwd, details.datasetId); }
    catch {
      const workerError = "追踪规则已保存，但自动更新进程未能启动。可以手动刷新行情，或重试保存已启用的规则。";
      return { content: [...event.content, { type: "text" as const, text: workerError }], details: { ...details, workerError } };
    }
  });
}

export async function ensureResearchMonitorWorker(cwd: string, datasetId: string) {
  const state = getResearchMonitor(cwd, datasetId);
  if (!state.config?.enabled && !getStockTracking(cwd, datasetId).trackers.some((tracker) => tracker.config.enabled)) return;
  if (await lockfile.check(join(cwd, "meta/collection.sqlite3"), { lockfilePath: join(cwd, "meta/research-worker.lock"), stale: 30_000 })) return;
  const directory = join(cwd, "generated", "monitoring");
  mkdirSync(directory, { recursive: true });
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [join(process.cwd(), "services/pe-research/worker.mjs"), "--cwd", cwd, "--dataset", datasetId, "--monitor"], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", log, log], env: process.env,
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } finally { closeSync(log); }
}
