import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { PeGatewayModelService, PeModelServiceError } = await jiti.import("./model-service.ts");
const { PeGatewaySessionStore } = await jiti.import("./session-store.ts");
const { GatewayTokenCipher } = await jiti.import("./token-cipher.ts");

const alice = {
  id: "11111111-1111-4111-8111-111111111111",
  balanceCny: "20.000000",
};
const bob = {
  id: "22222222-2222-4222-8222-222222222222",
  balanceCny: "30.000000",
};
const session = { accessToken: "account-access" };

test("defaults to platform and keeps source selection isolated by user", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-model-service-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 4)),
  );
  let modelCalls = 0;
  let tokenCalls = 0;
  const backend = {
    async models(accessToken) {
      modelCalls += 1;
      assert.equal(accessToken, "account-access");
      return {
        models: [{ id: "platform-model" }],
        defaultModel: "platform-model",
        available: true,
        error: null,
      };
    },
    async modelAccessToken(accessToken) {
      tokenCalls += 1;
      assert.equal(accessToken, "account-access");
      return {
        accessToken: "platform-secret",
        expiresIn: 3600,
        gatewayBaseUrl: "https://gateway.example/v1",
      };
    },
  };
  try {
    const service = new PeGatewayModelService(backend, store, () => true);
    assert.equal(service.sourceForUser(alice.id), "platform");
    service.setSource(alice.id, "custom");
    assert.equal(service.sourceForUser(alice.id), "custom");
    assert.equal(service.sourceForUser(bob.id), "platform");

    const state = await service.state(session, alice);
    assert.equal(state.source, "custom");
    assert.equal(state.platform.balanceCny, "20.000000");
    assert.deepEqual(state.platform.models, [{ id: "platform-model" }]);
    assert.equal(state.platform.selectedModel, "platform-model");
    assert.equal(store.getPlatformModel(alice.id), "platform-model");
    assert.equal(service.setPlatformModel(alice.id, "platform-model", state.platform), "platform-model");
    assert.throws(
      () => service.setPlatformModel(alice.id, "missing-model", state.platform),
      /unavailable/,
    );
    assert.equal(state.custom.configured, true);
    assert.equal(modelCalls, 1);

    const customRuntime = await service.platformRuntime(session, alice);
    assert.equal(customRuntime, null);
    assert.equal(modelCalls, 1);
    assert.equal(tokenCalls, 0);

    const preview = await service.platformRuntime(session, alice, { ...state, source: "platform" });
    assert.equal(preview.selectedModel, "platform-model");
    assert.equal(service.sourceForUser(alice.id), "custom", "preparing a session switch must not persist the new source");

    service.setSource(alice.id, "platform");
    const firstRuntime = await service.platformRuntime(session, alice);
    const secondRuntime = await service.platformRuntime(session, alice);
    assert.equal(firstRuntime.selectedModel, "platform-model");
    assert.equal(firstRuntime.access.accessToken, "platform-secret");
    assert.equal(secondRuntime.access.gatewayBaseUrl, "https://gateway.example/v1");
    assert.equal(tokenCalls, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not fall back across model sources when the selected source fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-model-no-fallback-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 5)),
  );
  let tokenCalls = 0;
  const backend = {
    async models() {
      return {
        models: [],
        defaultModel: null,
        available: false,
        error: "platform unavailable",
      };
    },
    async modelAccessToken() {
      tokenCalls += 1;
      throw new Error("must not be called");
    },
  };
  try {
    const service = new PeGatewayModelService(backend, store);
    service.setSource(alice.id, "custom");
    assert.equal(await service.platformRuntime(session, alice), null);
    assert.equal(tokenCalls, 0);

    service.setSource(alice.id, "platform");
    await assert.rejects(
      () => service.platformRuntime(session, alice),
      /platform unavailable/u,
    );
    assert.equal(tokenCalls, 0);
    assert.equal(service.sourceForUser(alice.id), "platform");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects zero-balance platform access before issuing a model token", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-model-balance-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 7)),
  );
  let tokenCalls = 0;
  const backend = {
    async models() {
      return {
        models: [{ id: "platform-model" }],
        defaultModel: "platform-model",
        available: true,
        error: null,
      };
    },
    async modelAccessToken() {
      tokenCalls += 1;
      throw new Error("must not issue a token without balance");
    },
  };
  try {
    const service = new PeGatewayModelService(backend, store);
    const emptyBalanceUser = { ...alice, balanceCny: "0.000000" };
    await assert.rejects(
      () => service.platformRuntime(session, emptyBalanceUser),
      (error) => error instanceof PeModelServiceError
        && error.status === 402
        && error.code === "insufficient_balance",
    );
    assert.equal(tokenCalls, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
