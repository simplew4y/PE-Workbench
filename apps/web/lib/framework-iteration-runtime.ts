import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createIterationEngine, recordIterationDiagnostic, recordIterationUsage, ResearchError, runFrameworkIteration, type FrameworkIteration } from "@earendil-works/pe-boot";
import { getPeGatewayRuntime } from "./pe-gateway/runtime";
import { localAccountContext } from "./pe-gateway/local-context";
import { PeModelServiceError } from "./pe-gateway/model-service";
import { platformRpcOptions } from "./pe-platform-runtime";
import { readPeIngestJob, resolvePeProjectPaths } from "./pe-ingest";
import { peProjectStorePaths } from "./pe-project-store";
import type { PeProjectSummary } from "./pe-project-types";

export async function iterationPlatform(sessionId: string, modelId?: string, metadataOnly = false) {
  const gateway = getPeGatewayRuntime();
  const context = await localAccountContext(gateway, sessionId);
  if (!context || context.offline) throw new ResearchError(401, "请登录平台账户后重试。");
  if (gateway.models.sourceForUser(context.user.id) !== "platform") throw new ResearchError(409, "请在模型设置中切换到平台模型。");
  try {
    const platform = metadataOnly ? await gateway.models.catalogRuntime(context.session, context.user) : await gateway.models.platformRuntime(context.session, context.user);
    if (!platform) throw new ResearchError(409, "平台模型暂不可用。");
    if (modelId && !platform.models.some((m) => m && typeof m === "object" && "id" in m && m.id === modelId)) throw new ResearchError(409, "原平台模型已不可用，请新建运行。");
    return { userId: context.user.id, platform: modelId ? { ...platform, selectedModel: modelId } : platform };
  } catch (error) {
    if (error instanceof PeModelServiceError) throw new ResearchError(error.status, error.message);
    throw error;
  }
}

export async function executeFrameworkIteration(project: PeProjectSummary, run: FrameworkIteration, sessionId: string, userId: string) {
  const directories: string[] = [];
  const engine = createIterationEngine(project.root, project.datasetId, async (modelId) => {
    const authorized = await iterationPlatform(sessionId, modelId);
    if (authorized.userId !== userId) throw new ResearchError(403, "任务账户已变化。");
    const directory = mkdtempSync(join(tmpdir(), "pe-platform-iteration-"));
    directories.push(directory);
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false });
    const options = platformRpcOptions("研究员", authorized.platform);
    runtime.registerProvider("pe-platform", options.platformProvider!);
    return runtime;
  }, (usage) => { recordIterationUsage(project.root, project.datasetId, run.id, usage); }, (diagnostic) => { recordIterationDiagnostic(project.root, project.datasetId, run.id, diagnostic); });
  const paths = resolvePeProjectPaths(project, peProjectStorePaths().registryPath);
  try {
    return await runFrameworkIteration(project.root, project.datasetId, run.id, engine, async (value, signal) => {
      if (!value.ingestJobId) throw new ResearchError(409, "上传未附加到运行，请重新提交资料。");
      for (;;) {
        signal.throwIfAborted();
        const job = readPeIngestJob(paths, value.ingestJobId);
        if (job.status === "failed" || job.result.failedCount) throw new ResearchError(409, "部分资料解析失败，请重试资料解析后新建运行。");
        if (job.status === "completed" || job.status === "completed_with_warnings") {
          return { docIds: job.result.files.flatMap((file) => file.docId && file.status === "created" ? [file.docId] : []), warnings: job.warnings };
        }
        await delay(1000, undefined, { signal });
      }
    }, new AbortController().signal);
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
}
