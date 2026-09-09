import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { PeGatewayAuthService } = await jiti.import("./auth-service.ts");
const { PeBackendClient, PeBackendError } = await jiti.import("./backend-client.ts");
const { PeGatewaySessionStore } = await jiti.import("./session-store.ts");
const { GatewayTokenCipher } = await jiti.import("./token-cipher.ts");

const alice = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  nickName: "Alice",
  preferredLocale: "zh-CN",
  status: "active",
  isAdmin: false,
  dataNamespace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  balanceCny: "12.500000",
  lastLoginAt: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const bob = {
  ...alice,
  id: "22222222-2222-4222-8222-222222222222",
  email: "bob@example.com",
  nickName: "Bob",
  dataNamespace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function authBundle(user, suffix = "1") {
  return {
    accessToken: `access-${user.email}-${suffix}`,
    refreshToken: `refresh-${user.email}-${suffix}`,
    expiresIn: 300,
    user,
  };
}

async function withAuthService(backend, run) {
  const root = await mkdtemp(join(tmpdir(), "pe-gateway-auth-"));
  const store = new PeGatewaySessionStore(
    join(root, "gateway.sqlite3"),
    new GatewayTokenCipher(Buffer.alloc(32, 9)),
  );
  const auth = new PeGatewayAuthService(backend, store, 3_600);
  try {
    await run({ auth, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("backend client matches the deployed authentication contract", async () => {
  const requests = [];
  const fetchImplementation = async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 900,
      user: {
        id: alice.id,
        email: alice.email,
        nick_name: alice.nickName,
        preferred_locale: alice.preferredLocale,
        status: alice.status,
        is_admin: alice.isAdmin,
        data_namespace: alice.dataNamespace,
        balance_cny: alice.balanceCny,
        last_login_at: alice.lastLoginAt,
        created_at: alice.createdAt,
      },
    });
  };
  const client = new PeBackendClient("https://capoo.fun/pe_workbench/backend", 1_000, fetchImplementation);
  const bundle = await client.login("alice@example.com", "password123");
  assert.equal(bundle.user.dataNamespace, alice.dataNamespace);
  assert.equal(requests[0].url, "https://capoo.fun/pe_workbench/backend/api/v1/auth/login");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    email: "alice@example.com",
    password: "password123",
  });
});

test("backend errors preserve safe status, code and message", async () => {
  const client = new PeBackendClient("https://example.test", 1_000, async () => Response.json(
    { code: "invalid_credentials", message: "email or password is incorrect" },
    { status: 401 },
  ));
  await assert.rejects(
    () => client.login("alice@example.com", "wrong"),
    (error) => error instanceof PeBackendError
      && error.status === 401
      && error.code === "invalid_credentials",
  );
});

test("backend client matches profile and password management contracts", async () => {
  const requests = [];
  const fetchImplementation = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/me/password") || url.endsWith("/auth/forgot-password")) {
      return new Response(null, { status: 204 });
    }
    return Response.json({
      id: alice.id,
      email: alice.email,
      nick_name: "Alice Updated",
      preferred_locale: alice.preferredLocale,
      status: alice.status,
      is_admin: alice.isAdmin,
      data_namespace: alice.dataNamespace,
      balance_cny: alice.balanceCny,
      last_login_at: alice.lastLoginAt,
      created_at: alice.createdAt,
    });
  };
  const client = new PeBackendClient("https://capoo.fun/pe_workbench/backend", 1_000, fetchImplementation);
  const updated = await client.updateProfile("access-token", "Alice Updated");
  await client.changePassword("access-token", "123456", "new-password");
  await client.resetPassword("alice@example.com", "654321", "reset-password");

  assert.equal(updated.nickName, "Alice Updated");
  assert.equal(requests[0].url, "https://capoo.fun/pe_workbench/backend/api/v1/me/profile");
  assert.equal(requests[0].init.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), { nick_name: "Alice Updated" });
  assert.equal(requests[1].url, "https://capoo.fun/pe_workbench/backend/api/v1/me/password");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    code: "123456",
    new_password: "new-password",
  });
  assert.equal(requests[2].url, "https://capoo.fun/pe_workbench/backend/api/v1/auth/forgot-password");
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    email: "alice@example.com",
    code: "654321",
    new_password: "reset-password",
  });
});

test("backend client obtains a server-only platform model token", async () => {
  const requests = [];
  const client = new PeBackendClient("https://capoo.fun/pe_workbench/backend", 1_000, async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      access_token: "platform-access-token",
      token_type: "bearer",
      expires_in: 3600,
      gateway_base_url: "https://capoo.fun/pe_workbench/backend/gateway/v1/",
    });
  });

  const access = await client.modelAccessToken("account-access-token");

  assert.deepEqual(access, {
    accessToken: "platform-access-token",
    expiresIn: 3600,
    gatewayBaseUrl: "https://capoo.fun/pe_workbench/backend/gateway/v1",
  });
  assert.equal(requests[0].url, "https://capoo.fun/pe_workbench/backend/api/v1/model-access-token");
  assert.equal(requests[0].init.headers.Authorization, "Bearer account-access-token");
});

test("creates isolated Alice and Bob sessions", async () => {
  const backend = {
    async login(email) {
      return authBundle(email === alice.email ? alice : bob);
    },
    async me(token) {
      return token.includes(alice.email) ? alice : bob;
    },
  };
  await withAuthService(backend, async ({ auth }) => {
    const aliceSession = await auth.login(alice.email, "password", 1_000);
    const bobSession = await auth.login(bob.email, "password", 1_000);
    assert.notEqual(aliceSession.sessionId, bobSession.sessionId);
    assert.equal(aliceSession.session.dataNamespace, alice.dataNamespace);
    assert.equal(bobSession.session.dataNamespace, bob.dataNamespace);
    assert.equal((await auth.currentUser(aliceSession.sessionId, 1_001)).email, alice.email);
    assert.equal((await auth.currentUser(bobSession.sessionId, 1_001)).email, bob.email);
  });
});

test("serializes concurrent refreshes for one-time refresh tokens", async () => {
  let refreshCalls = 0;
  const backend = {
    async login() {
      return { ...authBundle(alice), expiresIn: 31 };
    },
    async refresh() {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return authBundle(alice, "refreshed");
    },
  };
  await withAuthService(backend, async ({ auth }) => {
    const loggedIn = await auth.login(alice.email, "password", 1_000);
    const [first, second] = await Promise.all([
      auth.requireSession(loggedIn.sessionId, { now: 1_002 }),
      auth.requireSession(loggedIn.sessionId, { now: 1_002 }),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.accessToken, "access-alice@example.com-refreshed");
    assert.equal(second.accessToken, "access-alice@example.com-refreshed");
  });
});

test("invalidates a session when refreshed identity changes", async () => {
  const backend = {
    async login() {
      return { ...authBundle(alice), expiresIn: 1 };
    },
    async refresh() {
      return authBundle(bob);
    },
  };
  await withAuthService(backend, async ({ auth, store }) => {
    const loggedIn = await auth.login(alice.email, "password", 1_000);
    await assert.rejects(
      () => auth.requireSession(loggedIn.sessionId, { now: 1_001 }),
      (error) => error instanceof PeBackendError && error.code === "session_identity_changed",
    );
    assert.equal(store.getSession(loggedIn.sessionId, 1_001), null);
  });
});

test("local logout succeeds when the backend is unavailable", async () => {
  const backend = {
    async login() {
      return authBundle(alice);
    },
    async logout() {
      throw new Error("offline");
    },
  };
  await withAuthService(backend, async ({ auth, store }) => {
    const loggedIn = await auth.login(alice.email, "password", 1_000);
    await auth.logout(loggedIn.sessionId);
    assert.equal(store.getSession(loggedIn.sessionId, 1_001), null);
  });
});

test("revokes the session and worker capabilities when an account is disabled", async () => {
  const backend = {
    async login() {
      return authBundle(alice);
    },
    async me() {
      return { ...alice, status: "disabled" };
    },
  };
  await withAuthService(backend, async ({ auth, store }) => {
    const loggedIn = await auth.login(alice.email, "password", 1_000);
    const capability = store.createWorkerCapability(
      alice.id,
      alice.dataNamespace,
      2_000,
      1_000,
    );
    await assert.rejects(
      () => auth.currentUser(loggedIn.sessionId, 1_001),
      (error) => error instanceof PeBackendError
        && error.status === 403
        && error.code === "account_disabled",
    );
    assert.equal(store.getSession(loggedIn.sessionId, 1_001), null);
    assert.equal(store.resolveWorkerCapability(capability, 1_001), null);
  });
});

test("updates profile and invalidates the local session after a password change", async () => {
  let verificationRequest = null;
  let passwordRequest = null;
  const backend = {
    async login() {
      return authBundle(alice);
    },
    async me() {
      return alice;
    },
    async updateProfile(_token, nickName) {
      return { ...alice, nickName };
    },
    async sendVerificationCode(email, purpose) {
      verificationRequest = { email, purpose };
    },
    async changePassword(_token, code, newPassword) {
      passwordRequest = { code, newPassword };
    },
  };
  await withAuthService(backend, async ({ auth, store }) => {
    const loggedIn = await auth.login(alice.email, "password");
    const updated = await auth.updateProfile(loggedIn.sessionId, "Alice Updated");
    assert.equal(updated.nickName, "Alice Updated");

    assert.equal(await auth.sendChangePasswordCode(loggedIn.sessionId), true);
    assert.deepEqual(verificationRequest, {
      email: alice.email,
      purpose: "change_password",
    });

    assert.equal(await auth.changePassword(loggedIn.sessionId, "123456", "new-password"), true);
    assert.deepEqual(passwordRequest, { code: "123456", newPassword: "new-password" });
    assert.equal(store.getSession(loggedIn.sessionId), null);
  });
});
