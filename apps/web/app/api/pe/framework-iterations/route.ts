import { createHash } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { getIterationChangeReview, listIterationChangeReviewHistory, saveIterationChangeDecisions, publishIterationChangeReview, attachIterationIngest, cancelFrameworkIteration, createFrameworkIteration, decideFrameworkIteration, failIterationSubmission, getFrameworkIteration, getResearchFramework, iterationProjectSettings, listFrameworkIterations, ResearchError, setIterationTestProject, type FrameworkIteration } from "@earendil-works/pe-boot";
import { noStoreJson } from "@/lib/pe-gateway/route-helpers";
import { executeFrameworkIteration, iterationPlatform, resumeServerFrameworkIteration } from "@/lib/framework-iteration-runtime";
import { iterationRequestContext } from "@/lib/framework-iteration-access";
import { peProjectStorePaths } from "@/lib/pe-project-store";
import { isApiRequestAllowed } from "@/lib/request-security";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { queuePeIngest, readPeIngestJob, resolvePeProjectPaths, validatePeResearchUpload } from "@/lib/pe-ingest";
import { validateUploadFileNames } from "@/lib/file-upload";
import { availableInformationSources, informationSourceConfig, listInformationSourceQueries, listIterationSourceData, readIterationSourceArchive } from "@earendil-works/pe-boot";
import { getIterationModelUpdateResult, getResearchMonitor } from "@earendil-works/pe-boot";
import { serverIterationRuntimeStatus } from "@/services/pe-research/iteration-runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1200;
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new ResearchError(400, "缺少项目或运行标识。");
  return value.trim();
}
function publicRun(run: FrameworkIteration) {
  const value: Partial<FrameworkIteration> = { ...run, sourceMode: run.sourceMode ?? "documents" };
  delete value.leaseToken;
  delete value.leaseUntil;
  return value;
}
function iterationRunRuntime(cwd: string, datasetId: string, run: FrameworkIteration): "server" | "platform" {
  return run.diagnostics.some((entry) => entry.tool === "pe_server_runtime")
    || getResearchMonitor(cwd, datasetId).runs.some((entry) => entry.pipeline === "iteration" && entry.iterationId === run.id)
    ? "server" : "platform";
}
function failure(error: unknown) {
  const status = error instanceof ResearchError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  return noStoreJson({ error: status === 500 ? "迭代服务暂不可用，请检查运行环境。" : error instanceof Error ? error.message : "请求失败。" }, { status });
}
export async function GET(request: NextRequest) {
  try {
    const { project, sessionId } = await iterationRequestContext(request, text(request.nextUrl.searchParams.get("datasetId")));
    const historyBefore = request.nextUrl.searchParams.get("historyBefore");
    const runs = listFrameworkIterations(project.root, project.datasetId, historyBefore === null ? undefined : text(historyBefore)).map(publicRun);
    const nextCursor = runs.length === 100 ? runs.at(-1)!.id : null;
    if (request.nextUrl.searchParams.get("historyOnly") === "1") return noStoreJson({ runs, nextCursor });
    const id = request.nextUrl.searchParams.get("runId");
    const run = id ? getFrameworkIteration(project.root, project.datasetId, text(id)) : null;
    const files = run?.ingestJobId ? readPeIngestJob(resolvePeProjectPaths(project, peProjectStorePaths().registryPath), run.ingestJobId).result.files : [];
    const sourceQueries = run?.sourceMode === "sources" ? listInformationSourceQueries(project.root, project.datasetId, run.id) : [];
    const download = request.nextUrl.searchParams.get("download");
    if (run && (download === "source-raw" || download === "source-text")) {
      const queryId = text(request.nextUrl.searchParams.get("sourceQueryId"));
      const content = readIterationSourceArchive(project.root, project.datasetId, run.id, queryId, download === "source-raw" ? "raw" : "text");
      return new Response(content, { headers: { "Content-Type": download === "source-raw" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="source-${queryId}.${download === "source-raw" ? "json" : "txt"}"`, "Cache-Control": "private, no-store" } });
    }
    const runRuntime = run ? iterationRunRuntime(project.root, project.datasetId, run) : null;
    if (run && request.nextUrl.searchParams.get("download") === "report") {
      const framework = getResearchFramework(project.root, project.datasetId);
      const serverBilling = runRuntime === "server";
      const report = { project: project.name, files, sourceQueries, windCost: null, windCostNote: "供应商未返回计费金额，不估造费用。", run: publicRun(run), baseline: framework.versions.find((v) => v.id === run.basisVersionId), draft: framework.drafts.find((d) => d.id === run.draftId), publication: framework.versions.find((v) => v.id === run.versionId), changeReview: getIterationChangeReview(project.root, project.datasetId, run), reviewHistory: listIterationChangeReviewHistory(project.root, project.datasetId, run.id), costCurrency: "CNY", costNote: "目录估算，实际费用以平台结算为准", manualVerification: "本报告记录系统产物；原文数值、期间、单位及研究结论仍需人工核查。" };
      const delivery = { ...report, runRuntime, modelDelivery: getIterationModelUpdateResult(project.root, project.datasetId, run.id), ...(serverBilling ? { costCurrency: null, costNote: "服务端模型按供应商账单计费；未估算金额，usage.cost=0不代表免费。" } : {}) };
      return new Response(`# 投资框架迭代运行报告\n\n项目：${project.name}\n\n模型：${run.modelId}\n\n状态：${run.status}\n\n\`\`\`json\n${JSON.stringify(delivery, null, 2)}\n\`\`\`\n`, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="iteration-${run.id}.md"`, "Cache-Control": "private, no-store" } });
    }
    const sourceData = run?.sourceMode === "sources" ? listIterationSourceData(project.root, project.datasetId, run.id) : [];
    let modelId = "";
    let modelError: string | null = null;
    try { modelId = (await iterationPlatform(sessionId, undefined, true)).platform.selectedModel; }
    catch (error) { modelError = error instanceof ResearchError ? error.message : "模型服务暂不可用，仍可查看历史和审阅已有结果。"; }
    return noStoreJson({ run: run ? publicRun(run) : null, runRuntime, files, sourceQueries, sourceData, availableSources: availableInformationSources(), runs, nextCursor, settings: iterationProjectSettings(project.root, project.datasetId), framework: getResearchFramework(project.root, project.datasetId), modelId, modelError, changeReview: run ? getIterationChangeReview(project.root, project.datasetId, run) : null });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      if (!isApiRequestAllowed(request)) throw new ResearchError(403, "Untrusted API request");
      const form = await parseFormDataWithinLimit(request, 302 * 1024 * 1024);
      const { project, sessionId, userId } = await iterationRequestContext(request, text(form.get("datasetId")));
      const { platform } = await iterationPlatform(sessionId);
      const files = form.getAll("files").filter((file): file is File => typeof file !== "string");
      if (!files.length || files.length > 100 || files.some((f) => !f.size || f.size > 100 * 1024 * 1024) || files.reduce((size, f) => size + f.size, 0) > 300 * 1024 * 1024) throw new ResearchError(413, "上传文件为空或超过数量、大小限制。");
      const nameError = validateUploadFileNames(files.map((f) => f.name));
      if (nameError) throw new ResearchError(400, nameError);
      const uploads = [];
      for (const file of files) {
        const upload = { filename: file.name, mimeType: file.type, content: Buffer.from(await file.arrayBuffer()) };
        const error = validatePeResearchUpload(upload);
        if (error) throw new ResearchError(400, error);
        uploads.push(upload);
      }
      const uploadIdentity = JSON.stringify(uploads.map((u) => ({ filename: u.filename, hash: createHash("sha256").update(u.content).digest("hex") })));
      const run = createFrameworkIteration(project.root, project.datasetId, { requestId: text(form.get("requestId")), basisVersionId: text(form.get("basisVersionId")), modelId: platform.selectedModel, uploadIdentity, changeReview: form.get("changeReview") === "true" });
      if (run.status !== "queued" || run.ingestJobId) return noStoreJson({ run: publicRun(run) });
      try {
        const job = queuePeIngest({ project, registryPath: peProjectStorePaths().registryPath, uploads, parseOnly: true });
        attachIterationIngest(project.root, project.datasetId, run.id, job.jobId);
      } catch (error) {
        failIterationSubmission(project.root, project.datasetId, run.id);
        if (error instanceof Error && /already exists|same document|已有|Duplicate/i.test(error.message)) throw new ResearchError(409, error.message);
        throw error;
      }
      const attached = getFrameworkIteration(project.root, project.datasetId, run.id);
      after(async () => { await executeFrameworkIteration(project, attached, sessionId, userId); });
      return noStoreJson({ run: publicRun(attached) }, { status: 202 });
    }
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError(400, "Invalid request");
    const input = body as Record<string, unknown>;
    const { project, sessionId, userId } = await iterationRequestContext(request, text(input.datasetId));
    switch (input.action) {
      case "create-sources": {
        const prior = listFrameworkIterations(project.root, project.datasetId).find(run => run.requestId === text(input.requestId));
        if (prior) {
          const ticker = (typeof input.companyTicker === "string" ? input.companyTicker : project.companyTicker).trim().toUpperCase();
          const companyName = (project.companyName || (typeof input.companyName === "string" ? input.companyName : "")).trim();
          if (prior.sourceMode !== "sources" || prior.basisVersionId !== text(input.basisVersionId) || prior.sourceConfig?.companyTicker !== ticker || prior.sourceConfig.companyName !== companyName || JSON.stringify(prior.sourceConfig.sourceIds) !== JSON.stringify(input.sourceIds)) throw new ResearchError(409, "请求标识已用于不同的迭代输入。");
          return noStoreJson({ run: publicRun(prior) });
        }
        const authorized = await iterationPlatform(sessionId);
        if (authorized.userId !== userId) throw new ResearchError(403, "任务账户已变化。");
        const ticker = (typeof input.companyTicker === "string" ? input.companyTicker : project.companyTicker).trim().toUpperCase();
        if (/^[A-Z0-9.-]+\.[A-Z]{1,3}$/u.test(project.companyTicker.trim().toUpperCase()) && project.companyTicker.trim().toUpperCase() !== ticker) throw new ResearchError(409, "证券代码与项目身份冲突，请先核实项目公司设置。");
        const config = informationSourceConfig(project.companyName || (typeof input.companyName === "string" ? input.companyName : ""), ticker, input.sourceIds);
        if (!availableInformationSources().find(source => source.id === "wind-financials")?.available) throw new ResearchError(409, "服务端尚未配置有效的 Wind 凭证。");
        const run = createFrameworkIteration(project.root, project.datasetId, { requestId: text(input.requestId), basisVersionId: text(input.basisVersionId), modelId: authorized.platform.selectedModel, uploadIdentity: JSON.stringify(config), sourceMode: "sources", sourceConfig: config, changeReview: true });
        if (run.status === "queued") after(async () => { await executeFrameworkIteration(project, run, sessionId, userId); });
        return noStoreJson({ run: publicRun(run) }, { status: run.status === "queued" ? 202 : 200 });
      }
      case "test-project":
        if (typeof input.enabled !== "boolean") throw new ResearchError(400, "Invalid test project flag");
        setIterationTestProject(project.root, project.datasetId, input.enabled);
        return noStoreJson({ settings: iterationProjectSettings(project.root, project.datasetId) });
      case "resume": {
        const run = getFrameworkIteration(project.root, project.datasetId, text(input.runId));
        if (!["queued", "blocked", "failed"].includes(run.status)) throw new ResearchError(409, "任务不能恢复。");
        if (iterationRunRuntime(project.root, project.datasetId, run) === "server") {
          const server = serverIterationRuntimeStatus();
          if (!server.available || server.modelId !== run.modelId) throw new ResearchError(409, "本轮后台模型不可用或已变更，请修复服务端配置后重试，不能切换到聊天账户继续计费。");
          after(async () => { await resumeServerFrameworkIteration(project, run); });
          return noStoreJson({ run: publicRun(run) }, { status: 202 });
        }
        await iterationPlatform(sessionId, run.modelId);
        after(async () => { await executeFrameworkIteration(project, run, sessionId, userId); });
        return noStoreJson({ run: publicRun(run) }, { status: 202 });
      }
      case "cancel":
        cancelFrameworkIteration(project.root, project.datasetId, text(input.runId));
        return noStoreJson({ run: publicRun(getFrameworkIteration(project.root, project.datasetId, text(input.runId))) });
      case "review-decide": {
        const run = getFrameworkIteration(project.root, project.datasetId, text(input.runId));
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !Array.isArray(input.changeIds)
          || input.changeIds.length > 2000 || input.changeIds.some((id) => typeof id !== "string")
          || !["accepted", "rejected", "pending"].includes(String(input.decision)) || typeof input.note !== "string") {
          throw new ResearchError(400, "无效审查请求。");
        }
        return noStoreJson({ changeReview: saveIterationChangeDecisions(project.root, project.datasetId, run, {
          planId: text(input.planId), revision: Number(input.revision), changeIds: input.changeIds as string[],
          decision: input.decision as "accepted" | "rejected" | "pending", note: input.note,
        }, userId) });
      }
      case "review-publish": {
        const run = getFrameworkIteration(project.root, project.datasetId, text(input.runId));
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || typeof input.acknowledgeWarnings !== "boolean") {
          throw new ResearchError(400, "无效发布请求。");
        }
        await publishIterationChangeReview(project.root, project.datasetId, run, {
          planId: text(input.planId), revision: Number(input.revision), acknowledgeWarnings: input.acknowledgeWarnings,
          actorId: userId,
        }, request.signal);
        return noStoreJson({ run: publicRun(getFrameworkIteration(project.root, project.datasetId, run.id)) });
      }
      case "accept": case "reject":
        if (input.action === "accept" && getFrameworkIteration(project.root, project.datasetId, text(input.runId)).changeReview) {
          throw new ResearchError(409, "本轮启用了逐项审查，请先保存修改决定并发布组装结果。");
        }
        return noStoreJson({ run: publicRun(await decideFrameworkIteration(project.root, project.datasetId, text(input.runId), input.action === "accept", request.signal)) });
      default: throw new ResearchError(400, "Unknown iteration action");
    }
  } catch (error) { return failure(error); }
}
