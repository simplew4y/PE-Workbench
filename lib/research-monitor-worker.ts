import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getResearchMonitor } from "@earendil-works/pe-boot";

export async function ensureResearchMonitorWorker(cwd: string, datasetId: string) {
  const state = getResearchMonitor(cwd, datasetId);
  if (!state.config?.enabled) return;
  if (state.heartbeatAt && Date.now() - state.heartbeatAt < 20_000) return;
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
