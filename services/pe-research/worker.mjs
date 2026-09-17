import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createPiResearchEngine, getResearchMonitor, getStockTracking, runDueStockTrackers, runResearchMonitor, runNextResearchJob } from "@earendil-works/pe-boot";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { join } from "node:path";

const { values } = parseArgs({ options: {
  registry: { type: "string" }, dataset: { type: "string" }, once: { type: "boolean", default: false },
  cwd: { type: "string" }, monitor: { type: "boolean", default: false },
} });
if ((!values.registry && !values.cwd) || !values.dataset) throw new Error("Usage: worker.mjs --registry PATH|--cwd PATH --dataset DATASET_ID [--monitor] [--once]");
const registryPath = values.registry ? realpathSync(values.registry) : null;
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let release;
let runtime;
try {
  do {
    // Read only the explicitly selected registered project; never scan arbitrary directories.
    let project = values.cwd ? { dataset_root: values.cwd } : null;
    if (registryPath) {
      const registry = new DatabaseSync(registryPath, { readOnly: true, timeout: 10_000 });
      try { project = registry.prepare("SELECT dataset_root FROM datasets WHERE dataset_id=?").get(values.dataset); }
      finally { registry.close(); }
    }
    if (!project || typeof project.dataset_root !== "string") throw new Error("Selected project is not registered");
    const cwd = realpathSync(project.dataset_root);
    if (!release) release = await lockfile.lock(join(cwd, "meta/collection.sqlite3"), { lockfilePath: join(cwd, "meta/research-worker.lock"), stale: 30_000, update: 10_000, onCompromised: () => controller.abort() });
    // Price collection and deterministic valuation do not require an LLM account.
    const engine = { generate: async (...args) => {
      const settings = SettingsManager.create(cwd);
      const provider = process.env.PE_RESEARCH_PROVIDER || settings.getDefaultProvider();
      const model = process.env.PE_RESEARCH_MODEL || settings.getDefaultModel();
      if (!provider || !model) throw new Error("Select a default model or set PE_RESEARCH_PROVIDER and PE_RESEARCH_MODEL");
      runtime ??= await ModelRuntime.create({ allowModelNetwork: false, signal: controller.signal });
      return createPiResearchEngine(cwd, values.dataset, runtime, provider, model).generate(...args);
    } };
    let processed = false;
    if (values.monitor) {
      const researchEnabled = !!getResearchMonitor(cwd, values.dataset).config?.enabled;
      const trackingEnabled = getStockTracking(cwd, values.dataset).trackers.some((tracker) => tracker.config.enabled);
      if (!researchEnabled && !trackingEnabled) break;
      if (trackingEnabled) processed = (await runDueStockTrackers(cwd, values.dataset, controller.signal)) > 0;
      if (researchEnabled) processed = (await runResearchMonitor(cwd, values.dataset, engine, controller.signal)) || processed;
    } else {
      processed = await runNextResearchJob(cwd, values.dataset, engine, controller.signal);
    }
    if (values.once) break;
    await setTimeout(processed ? 100 : 5_000, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : "Research worker failed");
    process.exitCode = 1;
  }
} finally {
  if (release) await release();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
