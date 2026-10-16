import { after, type NextRequest } from "next/server";
import {
  cancelFrameworkIteration, cancelResearchMonitorRun, executeIterationModelUpdate, getFrameworkIteration, getIterationModelConfig, getIterationModelUpdateResult, getResearchFramework,
  getResearchMonitor, informationSourceConfig, listPeModelVersions, promoteIterationModelUpdate, readIterationModelWorkbook,
  requestResearchMonitorRun, ResearchError, saveIterationModelConfig, saveResearchMonitor,
  type SaveIterationModelConfigInput,
  resetStoppedMonitorIterations,
} from "@earendil-works/pe-boot";
import { iterationRequestContext } from "@/lib/framework-iteration-access";
import { noStoreJson } from "@/lib/pe-gateway/route-helpers";
import { listPeProjectDocuments } from "@/lib/pe-project-documents";
import { ensureResearchMonitorWorker } from "@/lib/research-monitor-worker";
import { serverIterationRuntimeStatus } from "@/services/pe-research/iteration-runtime.mjs";
import type { PeProjectSummary } from "@/lib/pe-project-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1200;

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new ResearchError(400, "缺少项目或运行标识。");
  return value.trim();
}

function failure(error: unknown) {
  const status = error instanceof ResearchError ? error.status : error instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error("Research workflow request failed", error);
  return noStoreJson({ error: status === 500 ? "追踪配置或模型服务暂不可用，请检查项目和运行环境。" : error instanceof Error ? error.message : "请求失败。" }, { status });
}

function saveAutomaticUpdates(project: PeProjectSummary, enabled: boolean, revision: number) {
  const server = serverIterationRuntimeStatus();
  if (!server.available || !server.modelId) throw new ResearchError(409, server.reason || "后台分析服务暂不可用，请稍后重试。");
  const state = getResearchFramework(project.root, project.datasetId);
  const current = state.versions.find((version) => version.id === state.currentVersionId);
  if (!current) throw new ResearchError(409, "请先保存一份投资框架。");
  return saveResearchMonitor(project.root, project.datasetId, {
    pipeline: "iteration", runtime: "server", modelId: server.modelId, updatePolicy: "direct", automaticSetup: true,
    company: { name: project.companyName, ticker: project.companyTicker }, enabled, mode: "auto", intervalHours: 168,
    objective: "自动读取现有框架和项目最新文件，识别模型、估值日期及关键输入，结合Wind更新框架与模型，并用简短中文说明变化。", queries: [], includeMemos: false,
  }, revision);
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const { project } = await iterationRequestContext(request, text(params.get("datasetId")));
    let monitor = getResearchMonitor(project.root, project.datasetId);
    if (monitor.config?.automaticSetup && monitor.runs[0]?.status === "running" && !monitor.workerOnline) {
      resetStoppedMonitorIterations(project.root, project.datasetId);
      monitor = getResearchMonitor(project.root, project.datasetId);
    }
    if ((monitor.config?.enabled || monitor.manualRequested) && !monitor.workerOnline) after(async () => {
      try { await ensureResearchMonitorWorker(project.root, project.datasetId); } catch { /* The page exposes the offline worker status and a manual restart. */ }
    });
    const runId = params.has("runId") ? text(params.get("runId")) : params.get("latest") === "1" ? monitor.runs[0]?.iterationId ?? null : null;
    const run = runId ? getFrameworkIteration(project.root, project.datasetId, runId) : null;
    if (params.get("download") === "model") {
      if (!runId) throw new ResearchError(400, "请选择模型所属的运行轮次。");
      const file = readIterationModelWorkbook(project.root, project.datasetId, runId);
      return new Response(new Uint8Array(file.bytes), { headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="model-${runId}.xlsx"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
      } });
    }
    const config = getIterationModelConfig(project.root, project.datasetId);
    const docId = params.has("docId") ? text(params.get("docId")) : config?.docId;
    let versions: Awaited<ReturnType<typeof listPeModelVersions>> | null = null;
    let modelError: string | null = null;
    if (docId) {
      try { versions = await listPeModelVersions(project.root, { datasetId: project.datasetId, docId }, request.signal); }
      catch { modelError = "无法读取所选模型原件或版本，请检查文件或重新绑定；追踪设置仍可操作。"; }
    }
    return noStoreJson({
      modelConfig: config,
      modelResult: runId ? getIterationModelUpdateResult(project.root, project.datasetId, runId) : null,
      modelVersions: versions,
      modelError,
      observations: run?.artifacts.find((artifact) => artifact.stage === "extract")?.value ?? null,
      documents: listPeProjectDocuments(project.datasetId).documents.filter((document) => document.fileType === "xlsx" && document.isCurrent !== false && document.docId && ["completed", "completed_with_warnings"].includes(document.status)),
      monitor,
      latestRunId: runId,
      serverRuntime: serverIterationRuntimeStatus(),
    });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError(400, "Invalid request");
    const input = body as Record<string, unknown>;
    const { project, userId } = await iterationRequestContext(request, text(input.datasetId));
    const { root, datasetId } = project;
    switch (input.action) {
      case "updates-save": {
        if (input.applyUpdates !== true || typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new ResearchError(400, "请明确选择更新方式后保存。");
        if (getResearchMonitor(root, datasetId).revision !== input.revision) throw new ResearchError(409, "更新设置已改变，请刷新后重试。");
        if (input.enabled && !resetStoppedMonitorIterations(root, datasetId)) throw new ResearchError(409, "正在更新中，请等待本轮完成。");
        saveAutomaticUpdates(project, input.enabled, Number(input.revision));
        let workerError: string | null = null;
        try { await ensureResearchMonitorWorker(root, datasetId); } catch { workerError = "设置已保存，后台未能启动，请点击立即更新重试。"; }
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId), workerError });
      }
      case "updates-run": {
        const monitor = getResearchMonitor(root, datasetId);
        if (!serverIterationRuntimeStatus().available) throw new ResearchError(409, "后台分析模型不可用。");
        if (!resetStoppedMonitorIterations(root, datasetId) || monitor.manualRequested) {
          await ensureResearchMonitorWorker(root, datasetId);
          return noStoreJson({ monitor: getResearchMonitor(root, datasetId) }, { status: 202 });
        }
        if (!monitor.config?.automaticSetup || monitor.config.modelId !== serverIterationRuntimeStatus().modelId) saveAutomaticUpdates(project, monitor.config?.enabled ?? false, monitor.revision);
        requestResearchMonitorRun(root, datasetId);
        await ensureResearchMonitorWorker(root, datasetId);
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId) }, { status: 202 });
      }
      case "updates-cancel": {
        const monitor = getResearchMonitor(root, datasetId);
        const linked = monitor.runs.find((run) => run.id === text(input.monitorRunId));
        if (!linked || ["published", "no_change", "cancelled", "rejected"].includes(linked.status)) throw new ResearchError(409, "这轮更新已结束。");
        if (linked.iterationId && !["published", "no_change", "rejected", "cancelled"].includes(getFrameworkIteration(root, datasetId, linked.iterationId).status)) cancelFrameworkIteration(root, datasetId, linked.iterationId);
        cancelResearchMonitorRun(root, datasetId, linked.id);
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId) });
      }
      case "model-save":
        return noStoreJson({ modelConfig: saveIterationModelConfig(root, datasetId, input.config as SaveIterationModelConfigInput) });
      case "model-promote":
        if (input.acknowledgeIndependentModel !== true || !Number.isSafeInteger(input.revision)) throw new ResearchError(400, "请确认模型单独验收并提供当前配置版本。");
        return noStoreJson({ modelConfig: promoteIterationModelUpdate(root, datasetId, text(input.runId), Number(input.revision), userId) });
      case "model-run": {
        const runId = text(input.runId);
        const run = getFrameworkIteration(root, datasetId, runId);
        if (!["review_required", "published", "no_change"].includes(run.status)) throw new ResearchError(409, "请等待本轮分析完成后再生成模型。");
        after(async () => { await executeIterationModelUpdate(root, datasetId, runId, AbortSignal.timeout(15 * 60_000)); });
        return noStoreJson({ accepted: true }, { status: 202 });
      }
      case "monitor-pause": {
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new ResearchError(400, "无效配置版本。");
        const current = getResearchMonitor(root, datasetId);
        if (!current.config) throw new ResearchError(409, "尚无追踪计划。");
        saveResearchMonitor(root, datasetId, { ...current.config, enabled: false }, Number(input.revision));
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId), workerError: null });
      }
      case "monitor-save": {
        if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || typeof input.collectSources !== "boolean") throw new ResearchError(400, "无效追踪设置。");
        const server = serverIterationRuntimeStatus();
        if (input.enabled && (!server.available || input.acknowledgeServerCosts !== true)) throw new ResearchError(409, server.reason || "启用前请确认后台模型及信息源费用。");
        const current = getResearchMonitor(root, datasetId);
        const modelId = server.modelId || current.config?.modelId;
        if (!modelId) throw new ResearchError(409, "请先配置服务端追踪模型。");
        saveResearchMonitor(root, datasetId, {
          pipeline: "iteration", runtime: "server", modelId, enabled: input.enabled, mode: "review",
          intervalHours: input.intervalHours, objective: "以新证据检查现有判断，保留局部修订依据并等待审阅。", queries: [], includeMemos: false,
          ...(input.collectSources ? { sourceConfig: informationSourceConfig(project.companyName, project.companyTicker, ["wind-financials"]) } : {}),
        }, Number(input.revision));
        let workerError: string | null = null;
        try { await ensureResearchMonitorWorker(root, datasetId); }
        catch { workerError = "设置已保存，但后台进程未启动；请重试启动。"; }
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId), workerError });
      }
      case "monitor-run":
        if (getResearchMonitor(root, datasetId).config?.pipeline !== "iteration") throw new ResearchError(409, "请先保存统一追踪设置。");
        requestResearchMonitorRun(root, datasetId);
        await ensureResearchMonitorWorker(root, datasetId);
        return noStoreJson({ monitor: getResearchMonitor(root, datasetId) }, { status: 202 });
      default: throw new ResearchError(400, "Unknown workflow action");
    }
  } catch (error) { return failure(error); }
}
