import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ensurePePromptAvailable, PeAccountClientError } = await jiti.import("./pe-account-client.ts");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("blocks a zero-balance platform prompt before it reaches the agent", async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    if (String(input) === "/api/runtime-mode") return jsonResponse({ multi_user: true });
    return jsonResponse({
      source: "platform",
      platform: {
        available: true,
        balance_cny: "0.000000",
        models: [{ id: "deepseek" }],
        default_model: "deepseek",
        selected_model: "deepseek",
        error: null,
      },
      custom: { configured: null },
    });
  };
  try {
    await assert.rejects(
      ensurePePromptAvailable(),
      (error) => error instanceof PeAccountClientError
        && error.status === 402
        && error.code === "insufficient_balance",
    );
    assert.deepEqual(paths, ["/api/runtime-mode", "/api/model-service"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not apply platform balance checks to a custom model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/runtime-mode") return jsonResponse({ multi_user: true });
    return jsonResponse({
      source: "custom",
      platform: {
        available: true,
        balance_cny: "0.000000",
        models: [],
        default_model: null,
        selected_model: null,
        error: null,
      },
      custom: { configured: true },
    });
  };
  try {
    await ensurePePromptAvailable();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps local single-user mode independent from the account backend", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ multi_user: false });
  };
  try {
    await ensurePePromptAvailable();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
