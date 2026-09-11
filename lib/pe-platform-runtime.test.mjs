import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const { platformRpcOptions } = await createJiti(import.meta.url).import("./pe-platform-runtime.ts");

const source = readFileSync(new URL("./pe-platform-runtime.ts", import.meta.url), "utf8");

test("platform models keep backend context limits and CNY prices", () => {
  assert.match(source, /contextWindow: model\.context_window/);
  assert.match(source, /maxTokens: model\.max_output_tokens/);
  assert.match(source, /input: model\.input_price_cny_per_million/);
  assert.match(source, /output: model\.output_price_cny_per_million/);
  assert.doesNotMatch(source, /context_window \?\? 128_000/);
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
