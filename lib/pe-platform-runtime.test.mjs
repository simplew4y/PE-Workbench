import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const { platformRpcOptions } = await createJiti(import.meta.url).import("./pe-platform-runtime.ts");

const source = readFileSync(new URL("./pe-platform-runtime.ts", import.meta.url), "utf8");

test("platform models keep backend context limits and CNY prices", () => {
  assert.match(source, /contextWindow: Math.min\(model\.context_window/);
  assert.match(source, /maxTokens: Math.min\(model\.max_output_tokens/);
  assert.match(source, /input: model\.input_price_cny_per_million/);
  assert.match(source, /output: model\.output_price_cny_per_million/);
  assert.doesNotMatch(source, /context_window \?\? 128_000/);
});

test("platform capability metadata controls Pi selectors, wire thinking, cache and tiers", async () => {
  for (const format of ["qwen", "deepseek"]) {
    const cost = { input: 2.5, output: 10, cacheRead: 0.5, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 32768, input: 4, output: 16, cacheRead: 0.8, cacheWrite: 4 }] };
    const definition = platformRpcOptions("Tester", {
      access: { gatewayBaseUrl: "https://gateway.invalid/v1", accessToken: "test-only" }, selectedModel: format,
      models: [{ id: format, context_window: 262144, max_output_tokens: 32768,
        input_price_cny_per_million: 2.5, output_price_cny_per_million: 10, cost,
        reasoning: true, input: ["text"],
        thinking_level_map: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
        compat: { thinkingFormat: format, supportsReasoningEffort: format === "deepseek", supportsDeveloperRole: false },
      }],
    }).platformProvider.models[0];
    const model = { ...definition, provider: "pe-platform", api: "openai-completions", baseUrl: "https://gateway.invalid/v1" };
    assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
    assert.deepEqual(model.cost, cost);
    assert.equal(model.contextWindow, 262144);
    for (const reasoning of [undefined, "high"]) {
      let captured;
      const stream = streamSimple(model, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] }, {
        apiKey: "test-only", reasoning, maxTokens: 1234,
        onPayload: (payload) => { captured = payload; throw new Error("intercepted before network"); },
      });
      await stream.result();
      assert.ok(captured, "must serialize through the real Pi adapter");
      assert.equal(captured.max_tokens, 1234);
      assert.equal(captured.max_completion_tokens, undefined);
      if (format === "qwen") assert.equal(captured.enable_thinking, Boolean(reasoning));
      else assert.deepEqual(captured.thinking, { type: reasoning ? "enabled" : "disabled" });
    }
  }
});

test("invalid platform limits fail instead of silently using unsafe defaults", () => {
  assert.match(source, /numericField\(value\.context_window, "context_window", id, 1\)/);
  assert.match(source, /numericField\(value\.max_output_tokens, "max_output_tokens", id, 1\)/);
});

test("platform selection exposes reusable provider registration for existing sessions", () => {
  const options = platformRpcOptions("Tester", {
    access: { gatewayBaseUrl: "https://example.invalid/v1", accessToken: "test-only" },
    selectedModel: "deepseek",
    models: [{
      id: "deepseek", display_name: "DeepSeek", context_window: 256000, max_output_tokens: 8192,
      input_price_cny_per_million: 1, output_price_cny_per_million: 2,
    }],
  });
  assert.deepEqual(options.initialModel, { provider: "pe-platform", modelId: "deepseek" });
  assert.equal(options.platformProvider.models[0].contextWindow, 256000);
  assert.equal(options.platformProvider.apiKey, "test-only");
  assert.equal(options.persistInitialModel, false);
  assert.deepEqual(platformRpcOptions("Tester", null), { userName: "Tester" });
});

test("synced thinking mode refreshes prices and real input/output limits without changing model identity", () => {
  const platform = { access: { gatewayBaseUrl: "https://example.invalid/v1", accessToken: "test-only" }, selectedModel: "stable",
    models: [{ id: "stable", context_window: 1000000, max_output_tokens: 65536,
      input_price_cny_per_million: 1, output_price_cny_per_million: 2,
      cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 },
      thinking_cost: { input: 1, output: 8, cacheRead: .1, cacheWrite: 1 },
      metadata: { max_input_tokens: 997952, reasoning_max_input_tokens: 995904, max_output_tokens_thinking: 32768 } }] };
  const normal = platformRpcOptions("test", platform).platformProvider.models[0];
  const thinking = platformRpcOptions("test", platform, true).platformProvider.models[0];
  assert.equal(normal.contextWindow, 997952);
  assert.equal(thinking.contextWindow, 995904);
  assert.equal(thinking.maxTokens, 32768);
  assert.equal(thinking.cost.output, 8);
  assert.equal(normal.cost.output, 2);
  assert.equal(normal.id, thinking.id);
});
