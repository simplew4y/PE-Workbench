import type { AgentSessionWrapper, RpcSessionStartOptions } from "./rpc-manager";
import { getPePlatformRpcOptions } from "./pe-platform-runtime";
import { PeModelServiceError } from "./pe-gateway/model-service";

declare global {
  var __peAuthorizedAgentTokens: WeakMap<AgentSessionWrapper, string> | undefined;
}

const MODEL_COMMANDS = new Set(["prompt", "steer", "follow_up", "compact", "navigate_tree"]);
export function peCommandUsesModel(command: string): boolean { return MODEL_COMMANDS.has(command); }

/** Local desktop authorization must never reuse another account's model token. */
export async function authorizePeAgentCommand(
  agent: AgentSessionWrapper,
  command: string,
  loadOptions: (options?: { thinkingLevel?: string }) => Promise<RpcSessionStartOptions> = getPePlatformRpcOptions,
): Promise<void> {
  if (!peCommandUsesModel(command) || agent.inner.model?.provider !== "pe-platform") return;
  const options = await loadOptions({ thinkingLevel: agent.inner.agent?.state?.thinkingLevel ?? "off" });
  const token = options.platformProvider?.apiKey;
  if (!token) throw new PeModelServiceError(401, "platform_login_required", "请连接云端账户使用平台模型，或切换当前会话到自定义模型");
  const tokens = globalThis.__peAuthorizedAgentTokens ??= new WeakMap();
  if (agent.isRunning()) {
    if (tokens.get(agent) !== token) {
      throw new PeModelServiceError(409, "platform_account_changed", "平台账户已变化，请等待当前任务结束后重新发送");
    }
    return;
  }
  // Refresh metadata and credentials, but preserve the session's explicit model.
  await agent.applyModelSource({ ...options, initialModel: { provider: "pe-platform", modelId: agent.inner.model.id } });
  tokens.set(agent, token);
}
