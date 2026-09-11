import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { authorizePeAgentCommand } = await createJiti(import.meta.url).import("./pe-agent-authorization.ts");

test("a live platform session cannot retain cloud access after local logout", async () => {
  let applied;
  let running = false;
  const agent = { inner: { model: { provider: "pe-platform", id: "session-choice" } }, isRunning: () => running,
    applyModelSource: async (options) => { applied = options; } };
  await assert.rejects(authorizePeAgentCommand(agent, "prompt", async () => ({})), { status: 401 });
  const options = { platformProvider: { apiKey: "alice-token" }, initialModel: { modelId: "account-default" } };
  await authorizePeAgentCommand(agent, "prompt", async () => options);
  assert.equal(applied.initialModel.modelId, "session-choice");
  running = true;
  await authorizePeAgentCommand(agent, "follow_up", async () => options);
  await assert.rejects(authorizePeAgentCommand(agent, "steer", async () => ({ platformProvider: { apiKey: "bob-token" } })), { status: 409 });
  await authorizePeAgentCommand(agent, "get_tools", async () => { throw new Error("local operations must not authenticate"); });
  agent.inner.model.provider = "custom";
  await authorizePeAgentCommand(agent, "prompt", async () => { throw new Error("custom model must not authenticate"); });
});
