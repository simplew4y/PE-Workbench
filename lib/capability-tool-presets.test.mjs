import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pe-boot": fileURLToPath(new URL("../../PE-Workbench-pi/packages/pe-boot/src/index.ts", import.meta.url)) },
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function setup(t) {
  let active = ["read", "pe_load_capability", "pe_pdf_list", "third_party"];
  const available = [...active, "bash", "write", "pe_render_ui", "dormant_extension"];
  const inner = {
    agent: { state: { systemPrompt: "PE prompt" } }, isStreaming: false, isCompacting: false, isBashRunning: false,
    sessionManager: { getCwd: () => "/tmp" }, extensionRunner: {}, settingsManager: { setProjectTrusted() {} },
    getAllTools: () => available.map((name) => ({ name })),
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names) => { active = names.filter((name) => available.includes(name)); },
    reload: async (options) => { active = [...available]; options?.beforeSessionStart?.(); },
    dispose() {},
  };
  const policy = {};
  const wrapper = new AgentSessionWrapper(inner, {}, [], policy);
  t.after(() => wrapper.destroy());
  return { wrapper, inner, policy };
}

test("coding presets preserve active extensions and never wake dormant tools", async (t) => {
  const { wrapper, inner } = setup(t);
  await wrapper.send({ type: "set_tools", toolNames: ["read", "bash", "write"] });
  assert.deepEqual(inner.getActiveToolNames(), ["read", "bash", "write", "pe_load_capability", "pe_pdf_list", "third_party"]);
  await wrapper.send({ type: "set_tools", toolNames: [] });
  assert.deepEqual(inner.getActiveToolNames(), []);
  await wrapper.send({ type: "set_tools", toolNames: ["read"] });
  assert.deepEqual(inner.getActiveToolNames(), ["read", "pe_load_capability", "pe_pdf_list", "third_party"]);
});

test("explicit extension lists are exact and busy sessions reject tool changes", async (t) => {
  const { wrapper, inner, policy } = setup(t);
  await wrapper.send({ type: "set_tools", toolNames: ["read", "pe_pdf_list"] });
  assert.deepEqual(policy.allowedTools, ["read", "pe_pdf_list"]);
  assert.deepEqual(inner.getActiveToolNames(), ["read", "pe_pdf_list"]);
  inner.isStreaming = true;
  await assert.rejects(wrapper.send({ type: "set_tools", toolNames: [] }), /当前任务/);
  assert.deepEqual(inner.getActiveToolNames(), ["read", "pe_pdf_list"]);
});

test("preset changes preserve previously loaded UI", async (t) => {
  const { wrapper, inner } = setup(t);
  inner.setActiveToolsByName([...inner.getActiveToolNames(), "pe_render_ui"]);
  await wrapper.send({ type: "set_tools", toolNames: ["read"] });
  assert.ok(inner.getActiveToolNames().includes("pe_render_ui"));
});

test("reload preserves disabled and dormant tool selections", async (t) => {
  const { wrapper, inner } = setup(t);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(inner.getActiveToolNames(), ["read", "pe_load_capability", "pe_pdf_list", "third_party"]);
  await wrapper.send({ type: "set_tools", toolNames: [] });
  await wrapper.send({ type: "reload" });
  assert.deepEqual(inner.getActiveToolNames(), []);
  assert.equal(inner.agent.state.systemPrompt, "");
});
