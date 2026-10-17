import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIterationEngine, recordIterationDiagnostic, recordIterationUsage, ResearchError } from "@earendil-works/pe-boot";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function configuration(env) {
  const modelId = env.PE_INGEST_LLM_MODEL?.trim() || null;
  const baseUrl = env.PE_INGEST_LLM_BASE_URL?.trim();
  const apiKey = env.PE_INGEST_LLM_API_KEY?.trim();
  if (!modelId || !baseUrl || !apiKey) throw new Error("未配置完整的服务端追踪模型；请配置 PE_INGEST_LLM_BASE_URL、API_KEY 和 MODEL，或使用手动平台迭代。");
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error("服务端模型地址无效。"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
    throw new Error("服务端模型需使用 HTTPS（本机调试可用 HTTP），地址不得含凭证或查询参数。");
  }
  let extraBody = {};
  try { extraBody = JSON.parse(env.PE_INGEST_LLM_EXTRA_BODY?.trim() || "{}"); }
  catch { throw new Error("PE_INGEST_LLM_EXTRA_BODY 必须是 JSON 对象。"); }
  if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody)) throw new Error("PE_INGEST_LLM_EXTRA_BODY 必须是 JSON 对象。");
  const controlled = ["model", "messages", "tools", "tool_choice", "stream", "stream_options", "max_tokens", "max_completion_tokens", "__proto__", "constructor", "prototype"];
  if (controlled.some((key) => Object.hasOwn(extraBody, key))) throw new Error("PE_INGEST_LLM_EXTRA_BODY 不得覆盖模型、消息、工具、流式协议或输出限制。");
  // DeepSeek V4's published context limit is 1M; a generic 64K cap can shrink
  // subsequent replies to one token after the first workbook reads.
  const deepSeekV4 = endpoint.hostname === "api.deepseek.com" && ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"].includes(modelId);
  const contextWindow = Number(env.PE_INGEST_LLM_CONTEXT_WINDOW?.trim() || (deepSeekV4 ? 1000000 : 64000));
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 16384) throw new Error("PE_INGEST_LLM_CONTEXT_WINDOW 必须是至少 16384 的整数，且不能超过所用模型的实际限制。");
  return { modelId, baseUrl, apiKey, extraBody, contextWindow, maxTokens: deepSeekV4 ? 32768 : 8192 };
}

export function availability(env = process.env) {
  try {
    const config = configuration(env);
    return { available: true, modelId: config.modelId, contextWindow: config.contextWindow, reason: "后台使用服务端配置；费用按提供商账单结算，不使用平台用户余额，界面不估算金额。" };
  } catch (error) {
    return { available: false, modelId: env.PE_INGEST_LLM_MODEL?.trim() || null, reason: error instanceof Error ? error.message : "服务端追踪模型不可用。" };
  }
}

export const serverIterationRuntimeStatus = availability;

export async function createServerIterationRuntime(cwd, datasetId, run, signal) {
  const state = availability();
  if (!state.available) throw new ResearchError(409, state.reason);
  const config = configuration(process.env);
  if (run.datasetId !== datasetId || run.modelId !== config.modelId) throw new ResearchError(409, "计划模型与服务端模型不一致；请重新选择服务端模型，或在手动入口处理旧迭代。");
  const directory = mkdtempSync(join(tmpdir(), "pe-server-monitor-"));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false, signal });
    // Tool calls already carry JSON schemas; text JSON mode can prevent the provider from emitting tool calls.
    const samplingParams = { ...config.extraBody };
    delete samplingParams.response_format;
    runtime.registerProvider("pe-platform", {
      name: "服务端追踪模型", baseUrl: config.baseUrl, api: "openai-completions", apiKey: config.apiKey, authHeader: true,
      models: [{ id: config.modelId, name: config.modelId, reasoning: false, input: ["text"],
        contextWindow: config.contextWindow, maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        samplingParams,
        compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false },
      }],
    });
    recordIterationDiagnostic(cwd, datasetId, run.id, { stage: run.stage, tool: "pe_server_runtime", args: { modelId: config.modelId, contextWindow: config.contextWindow, billing: "provider", costEstimateAvailable: false }, at: new Date().toISOString() });
    const engine = createIterationEngine(cwd, datasetId, async (modelId) => {
      if (modelId !== config.modelId) throw new ResearchError(409, "服务端模型选择已变化。");
      return runtime;
    }, (usage) => recordIterationUsage(cwd, datasetId, run.id, usage), (diagnostic) => recordIterationDiagnostic(cwd, datasetId, run.id, diagnostic));
    return { engine, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
