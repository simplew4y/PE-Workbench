import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper, ModelSelectionError } = await jiti.import("./rpc-manager.ts");

const custom = { provider: "custom", id: "my-model", input: ["text"], contextWindow: 64000 };
const platformA = { provider: "pe-platform", id: "qwen", input: ["text"], contextWindow: 128000 };
const platformB = { provider: "pe-platform", id: "deepseek", input: ["text"], contextWindow: 256000 };
const provider = { models: [platformA, platformB], apiKey: "test-only" };
const options = (model = platformB) => ({ platformProvider: provider, initialModel: { provider: model.provider, modelId: model.id } });

function fixture(t, initial = custom, initialProvider) {
  const registrations = new Map(initialProvider ? [["pe-platform", initialProvider]] : []);
  const providerState = { current: initialProvider };
  const changes = [];
  const messages = [{ role: "user", content: "existing conversation" }];
  const inner = {
    sessionId: "same-session",
    model: initial,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    extensionRunner: {},
    agent: { state: { messages } },
    sessionManager: { getCwd: () => "/tmp" },
    settingsManager: {
      getEnabledModels: () => undefined,
      getDefaultProvider: () => "custom",
      getDefaultModel: () => custom.id,
    },
    modelRuntime: {
      registerProvider: (id, config) => registrations.set(id, config),
      unregisterProvider: (id) => registrations.delete(id),
      refresh: async () => {},
      getModel: (id, modelId) => registrations.get(id)?.models.find((m) => m.id === modelId),
      getAvailable: async () => [custom, ...[...registrations.values()].flatMap((p) => p.models)],
    },
    async setModel(model) { changes.push(model); inner.model = model; },
    abortBash() {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, providerState);
  t.after(() => wrapper.destroy());
  return { wrapper, inner, registrations, providerState, changes, messages };
}

test("account model selection registers a missing platform provider and switches the same session", async (t) => {
  const f = fixture(t);
  let committed = false;
  const selected = await f.wrapper.applyModelSource(options(), () => {
    assert.equal(f.inner.model, platformB, "persist only after Pi accepted the model");
    committed = true;
  });
  assert.deepEqual(selected, { provider: "pe-platform", modelId: "deepseek" });
  assert.equal(committed, true);
  assert.equal(f.wrapper.sessionId, "same-session");
  assert.equal(f.inner.agent.state.messages, f.messages);
  assert.equal(f.inner.model.contextWindow, 256000);
  assert.equal(f.providerState.current, provider, "reload uses the newly registered provider");
});

test("platform-to-platform and platform-to-custom both replace the effective session model", async (t) => {
  const f = fixture(t, platformA, provider);
  await f.wrapper.applyModelSource(options());
  assert.equal(f.inner.model, platformB);
  const result = await f.wrapper.applyModelSource({});
  assert.deepEqual(result, { provider: "custom", modelId: custom.id });
  assert.equal(f.inner.model, custom);
  assert.equal(f.registrations.has("pe-platform"), false);
  assert.equal(f.providerState.current, undefined, "resource reload cannot resurrect platform registration");
});

for (const field of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"]) {
  test(`rejects model settings while ${field} without saving preferences`, async (t) => {
    const f = fixture(t);
    f.inner[field] = field === "pendingMessageCount" ? 1 : true;
    await assert.rejects(f.wrapper.applyModelSource(options(), () => assert.fail("must not commit")), ModelSelectionError);
    assert.equal(f.inner.model, custom);
    assert.equal(f.registrations.size, 0);
  });
}

test("failed authentication restores the old registration and leaves account preference unchanged", async (t) => {
  const oldProvider = { ...provider, apiKey: "old-test-only" };
  const f = fixture(t, platformA, oldProvider);
  f.inner.setModel = async () => { throw new Error("Authentication failed"); };
  await assert.rejects(f.wrapper.applyModelSource(options(), () => assert.fail("must not commit")), /Authentication failed/);
  assert.equal(f.inner.model, platformA);
  assert.equal(f.providerState.current, oldProvider);
  assert.equal(f.registrations.get("pe-platform"), oldProvider);
});

test("missing custom credentials never silently keep billing the platform", async (t) => {
  const f = fixture(t, platformA, provider);
  f.inner.modelRuntime.getAvailable = async () => [platformA];
  await assert.rejects(f.wrapper.applyModelSource({}, () => assert.fail("must not commit")), /没有可用模型/);
  assert.equal(f.inner.model, platformA);
  assert.equal(f.providerState.current, provider);
});

test("a pending model switch excludes prompts and competing model settings", async (t) => {
  const f = fixture(t);
  let finish;
  f.inner.modelRuntime.refresh = () => new Promise((resolve) => { finish = resolve; });
  const switching = f.wrapper.applyModelSource(options());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.wrapper.send({ type: "prompt", message: "hello" }), /正在切换模型/);
  await assert.rejects(f.wrapper.send({ type: "set_model", provider: "custom", modelId: custom.id }), /正在切换模型/);
  await assert.rejects(f.wrapper.applyModelSource(options(platformA)), ModelSelectionError);
  finish();
  await switching;
  assert.equal(f.inner.model, platformB);
});

test("failed preference commit restores the effective model", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.wrapper.applyModelSource(options(), () => { throw new Error("storage failed"); }), /storage failed/);
  assert.equal(f.inner.model, custom);
  assert.equal(f.registrations.size, 0);
  await f.wrapper.applyModelSource(options());
  assert.equal(f.inner.model, platformB, "failed switch releases its lock");
});

test("real Pi runtime changes model metadata and transcript, and preserves the custom default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-model-switch-"));
  let wrapper;
  try {
    const definition = (id, contextWindow) => ({
      id, name: id, reasoning: false, input: ["text"], contextWindow, maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    const customConfig = { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "test-only", models: [definition("my-model", 64000)] };
    const platformConfig = { ...customConfig, models: [definition("deepseek", 256000)] };
    const providerState = {};
    const services = await createAgentSessionServices({
      cwd: root, agentDir: join(root, "agent"),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [(pi) => {
          pi.registerProvider("custom", customConfig);
          if (providerState.current) pi.registerProvider("pe-platform", providerState.current);
        }],
      },
    });
    services.settingsManager.setDefaultModelAndProvider("custom", "my-model");
    await services.settingsManager.flush();
    const manager = SessionManager.inMemory(root);
    const { session: inner } = await createAgentSessionFromServices({
      services, sessionManager: manager, tools: [],
      model: services.modelRuntime.getModel("custom", "my-model"),
    });
    wrapper = new AgentSessionWrapper(inner, providerState);
    await wrapper.applyModelSource({ platformProvider: platformConfig, initialModel: { provider: "pe-platform", modelId: "deepseek" } });
    assert.equal(inner.model.provider, "pe-platform");
    assert.equal(inner.model.id, "deepseek");
    assert.equal(inner.model.contextWindow, 256000);
    assert.equal(manager.getBranch().filter((entry) => entry.type === "model_change").at(-1).modelId, "deepseek");
    assert.equal(services.settingsManager.getDefaultProvider(), "custom");
    // Reload invokes the same extension factory used by real session startup.
    await inner.reload();
    assert.equal(inner.model.id, "deepseek");
    assert.ok(await inner.modelRuntime.checkAuth("pe-platform"));
    await wrapper.applyModelSource({});
    assert.equal(inner.model.provider, "custom");
    await inner.reload();
    assert.equal(inner.modelRuntime.getModel("pe-platform", "deepseek"), undefined);
    assert.equal(inner.model.contextWindow, 64000);
  } finally {
    wrapper?.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
