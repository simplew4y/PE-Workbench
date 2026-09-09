import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createPeWorkerContextHeaders,
  readPeWorkerContext,
} = await createJiti(import.meta.url).import("./pe-worker-context.ts");

const capability = "pew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const platform = {
  userName: "Alice",
  source: "platform",
  platform: {
    access: {
      accessToken: "platform-secret",
      expiresIn: 3600,
      gatewayBaseUrl: "https://models.example.test/v1/",
    },
    models: [{ id: "model-a", display_name: "Model A" }],
    selectedModel: "model-a",
  },
};

test("round-trips a signed platform context", () => {
  const headers = new Headers(createPeWorkerContextHeaders(platform, capability));
  assert.deepEqual(readPeWorkerContext(headers, capability), {
    ...platform,
    platform: {
      ...platform.platform,
      access: {
        ...platform.platform.access,
        gatewayBaseUrl: "https://models.example.test/v1",
      },
    },
  });
});

test("keeps custom contexts free of platform credentials", () => {
  const headers = new Headers(createPeWorkerContextHeaders({
    userName: "Bob",
    source: "custom",
    platform: platform.platform,
  }, capability));
  assert.deepEqual(readPeWorkerContext(headers, capability), {
    userName: "Bob",
    source: "custom",
  });
});

test("rejects tampering, wrong capabilities, and unsafe gateway URLs", () => {
  const values = createPeWorkerContextHeaders(platform, capability);
  const tampered = new Headers(values);
  tampered.set("x-pe-worker-context", `${values["x-pe-worker-context"]}a`);
  assert.throws(() => readPeWorkerContext(tampered, capability), /signature is invalid/u);
  assert.throws(
    () => readPeWorkerContext(new Headers(values), `${capability}x`),
    /signature is invalid/u,
  );
  assert.throws(
    () => createPeWorkerContextHeaders({
      ...platform,
      platform: {
        ...platform.platform,
        access: { ...platform.platform.access, gatewayBaseUrl: "file:///tmp/model" },
      },
    }, capability),
    /invalid platform gateway URL/u,
  );
});
