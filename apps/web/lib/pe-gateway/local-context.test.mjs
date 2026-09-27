import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { localAccountContext } = await jiti.import("./local-context.ts");
const { PeBackendError } = await jiti.import("./backend-client.ts");
const { PeGatewayModelService } = await jiti.import("./model-service.ts");

test("desktop outage keeps the local identity but never grants platform access", async (t) => {
  const previous = process.env.PE_DESKTOP_MODE;
  process.env.PE_DESKTOP_MODE = "1";
  t.after(() => { if (previous === undefined) delete process.env.PE_DESKTOP_MODE; else process.env.PE_DESKTOP_MODE = previous; });
  const session = { userId: "alice", dataNamespace: "alice-files", email: "alice@example.test", createdAt: 100 };
  let source = "platform";
  let tokenRequests = 0;
  const store = { getSession: () => session, getModelSource: () => source,
    setModelSource: (_user, value) => { source = value; }, getPlatformModel: () => "qwen",
    getPlatformCatalog: () => ({ models: [{ id: "qwen", context_window: 262144 }], defaultModel: "qwen" }) };
  const gateway = { store, auth: { currentUser: async () => { throw new PeBackendError(503, "backend_unavailable", "offline"); } } };
  const context = await localAccountContext(gateway, "outage-test");
  assert.equal(context.offline, true);
  assert.equal(context.session.dataNamespace, "alice-files");
  assert.equal(context.user.isAdmin, false);
  assert.equal(context.user.balanceCny, "unknown");
  const models = new PeGatewayModelService({
    models: async () => { throw new Error("offline identity must not query the provider"); },
    modelAccessToken: async () => { tokenRequests++; throw new Error("must not issue token"); },
  }, store, () => true);
  assert.equal((await models.state(context.session, context.user)).platform.available, false);
  const catalog = await models.catalogRuntime(context.session, context.user);
  assert.equal(catalog.models[0].context_window, 262144);
  assert.equal(catalog.access.expiresIn, 0);
  await assert.rejects(models.platformRuntime(context.session, context.user), { code: "platform_models_unavailable" });
  models.setSource("alice", "custom");
  assert.equal(await models.platformRuntime(context.session, context.user), null);
  assert.equal(tokenRequests, 0);
});

test("a hosted process does not fall back when the account server is down", async (t) => {
  const previous = process.env.PE_DESKTOP_MODE;
  delete process.env.PE_DESKTOP_MODE;
  t.after(() => { if (previous !== undefined) process.env.PE_DESKTOP_MODE = previous; });
  await assert.rejects(localAccountContext({ store: { getSession: () => ({}) }, auth: {
    currentUser: async () => { throw new PeBackendError(503, "backend_unavailable", "offline"); },
  } }, "hosted-test"), { status: 503 });
});

test("authentication rejection and expired local sessions never become cached identities", async (t) => {
  const previous = process.env.PE_DESKTOP_MODE;
  process.env.PE_DESKTOP_MODE = "1";
  t.after(() => { if (previous === undefined) delete process.env.PE_DESKTOP_MODE; else process.env.PE_DESKTOP_MODE = previous; });
  for (const status of [401, 403]) {
    await assert.rejects(localAccountContext({ store: { getSession: () => ({}) }, auth: {
      currentUser: async () => { throw new PeBackendError(status, "rejected", "rejected"); },
    } }, `rejected-${status}`), { status });
  }
  assert.equal(await localAccountContext({ store: { getSession: () => null } }, "expired"), null);
});
