import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getResearchFramework, listResearchContinuations, transitionResearchContinuation, ResearchError } from "@earendil-works/pe-boot";
import { resolveSessionPath } from "./session-reader";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { getPePlatformRpcOptions } from "./pe-platform-runtime";
import { authorizePeAgentCommand } from "./pe-agent-authorization";
import { samePath } from "./paths";
import { normalizeToolCalls } from "./normalize";
import { getTurnFrameworkProposal, type FrameworkProposal } from "./framework-proposal";
import type { AgentMessage, AssistantContentBlock, ToolResultMessage } from "./types";

export async function validateResearchSession(root: string, proposal: FrameworkProposal, sessionId: string) {
  const running = getRpcSession(sessionId);
  const path = await resolveSessionPath(sessionId);
  const manager = running?.isAlive() ? running.inner.sessionManager : path ? SessionManager.open(path) : null;
  if (!manager || manager.getSessionId() !== sessionId || !samePath(manager.getCwd(), root))
    throw new ResearchError(404, "找不到此项目的来源会话");
  const messages = manager.getBranch().flatMap((entry) => entry.type === "message" ? [normalizeToolCalls(entry.message as AgentMessage)] : []);
  const calls: AssistantContentBlock[] = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall" && block.toolCallId === proposal.toolCallId) : []);
  const results = new Map(messages.filter((message): message is ToolResultMessage => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const saved = getTurnFrameworkProposal(calls, results);
  if (!saved || saved.datasetId !== proposal.datasetId || saved.draftId !== proposal.draftId || saved.revision !== proposal.revision)
    throw new ResearchError(409, "来源会话或分支已变化，请回到生成这份草稿的对话");
  return { manager, path };
}

export async function continueResearch(root: string, datasetId: string, versionId: string) {
  const receipt = listResearchContinuations(root, datasetId).find((item) => item.versionId === versionId);
  if (!receipt) throw new ResearchError(404, "找不到确认记录");
  const marker = `[framework-confirmation:${versionId}]`;
  const path = await resolveSessionPath(receipt.sessionId);
  if (!path) throw new ResearchError(404, "来源会话已不存在，框架仍已保存");
  const existing = getRpcSession(receipt.sessionId);
  const manager = existing?.isAlive() ? existing.inner.sessionManager : SessionManager.open(path);
  if (manager.getSessionId() !== receipt.sessionId || !samePath(manager.getCwd(), root)) throw new ResearchError(409, "会话所属项目已变化");
  const received = manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user" &&
    (typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).startsWith(marker));
  const queued = existing?.isAlive() && [...existing.inner.getFollowUpMessages(), ...existing.inner.getSteeringMessages()].some((message) => message.startsWith(marker));
  if (received || queued) {
    transitionResearchContinuation(root, datasetId, versionId, receipt.status, "delivered");
    return { ...receipt, status: "delivered" as const, error: null };
  }
  // A prior process may have stopped during admission. Never replay an ambiguous run.
  if (receipt.status === "sending" || receipt.status === "delivered")
    return { ...receipt, error: "续接状态待核对，请检查原会话；不会自动重复执行。" };
  const framework = getResearchFramework(root, datasetId);
  if (framework.currentVersionId !== versionId) throw new ResearchError(409, "正式框架已有新版本，请在对话中基于最新版本继续");
  const version = framework.versions.find((item) => item.id === versionId)!;
  const draft = framework.drafts.find((item) => item.id === receipt.draftId)!;
  await validateResearchSession(root, { datasetId, draftId: receipt.draftId, revision: draft.revision - 1, toolCallId: receipt.toolCallId }, receipt.sessionId);
  let session;
  try {
    session = existing?.isAlive() ? existing : (await startRpcSession(receipt.sessionId, path, undefined, await getPePlatformRpcOptions())).session;
    await authorizePeAgentCommand(session, "prompt");
    await validateResearchSession(root, { datasetId, draftId: receipt.draftId, revision: draft.revision - 1, toolCallId: receipt.toolCallId }, receipt.sessionId);
    if (!session.isAlive() || session.sessionId !== receipt.sessionId) throw new Error("会话已切换，请重试");
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法启动来源会话";
    transitionResearchContinuation(root, datasetId, versionId, receipt.status, "failed", message);
    return { ...receipt, status: "failed" as const, error: message };
  }
  if (!transitionResearchContinuation(root, datasetId, versionId, receipt.status, "sending"))
    return listResearchContinuations(root, datasetId).find((item) => item.versionId === versionId)!;
  try {
    await session.send({ type: "prompt", streamingBehavior: "followUp", message: `${marker}\n用户通过确认按钮确定了投资框架 v${version.version}（versionId=${versionId}）。请先用 pe_investment_framework read 读取并核对该版本，再按照本对话已约定的任务继续研究；如果没有约定下一步，简要说明最需要补充的证据。不要重复发布框架，也不要自行启动持续监控。` });
    transitionResearchContinuation(root, datasetId, versionId, "sending", "delivered");
    return { ...receipt, status: "delivered" as const, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "续接失败";
    transitionResearchContinuation(root, datasetId, versionId, "sending", "failed", message);
    return { ...receipt, status: "failed" as const, error: message };
  }
}
