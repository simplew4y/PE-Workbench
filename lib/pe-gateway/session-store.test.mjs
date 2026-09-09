import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GatewayTokenCipher } = await jiti.import("./token-cipher.ts");
const { PeGatewaySessionStore } = await jiti.import("./session-store.ts");

const alice = {
  userId: "11111111-1111-4111-8111-111111111111",
  dataNamespace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "Alice@Example.com",
  accessToken: "access-alice-secret",
  refreshToken: "refresh-alice-secret",
  accessExpiresAt: 2_000,
  sessionExpiresAt: 3_000,
};

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "pe-gateway-store-"));
  const databasePath = join(root, "gateway.sqlite3");
  const cipher = new GatewayTokenCipher(Buffer.alloc(32, 7));
  const store = new PeGatewaySessionStore(databasePath, cipher);
  try {
    await run({ root, databasePath, cipher, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("AES-GCM ciphertext is purpose-bound and rejects tampering", () => {
  const cipher = new GatewayTokenCipher(Buffer.alloc(32, 1));
  const encrypted = cipher.encrypt("secret-value", "access");
  assert.notEqual(encrypted, "secret-value");
  assert.equal(cipher.decrypt(encrypted, "access"), "secret-value");
  assert.throws(() => cipher.decrypt(encrypted, "refresh"), /could not be decrypted/u);
  const payload = Buffer.from(encrypted.split(".")[1], "base64url");
  payload[payload.length - 1] ^= 1;
  assert.throws(
    () => cipher.decrypt(`v1.${payload.toString("base64url")}`, "access"),
    /could not be decrypted/u,
  );
});

test("stores only hashed session IDs and encrypted credentials", async () => {
  await withStore(async ({ databasePath, store }) => {
    const sessionId = store.createSession(alice, 1_000);
    const rawDatabase = await readFile(databasePath);
    assert.equal(rawDatabase.includes(Buffer.from(sessionId)), false);
    assert.equal(rawDatabase.includes(Buffer.from(alice.accessToken)), false);
    assert.equal(rawDatabase.includes(Buffer.from(alice.refreshToken)), false);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);

    assert.deepEqual(store.getSession(sessionId, 1_001), {
      ...alice,
      email: "alice@example.com",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    assert.equal(store.getSession("pes_unknown", 1_001), null);
  });
});

test("refreshes tokens, expires sessions and deletes sessions", async () => {
  await withStore(async ({ store }) => {
    const sessionId = store.createSession(alice, 1_000);
    assert.equal(store.updateTokens(sessionId, "new-access", "new-refresh", 2_500, 1_100), true);
    assert.equal(store.getSession(sessionId, 1_101).accessToken, "new-access");
    assert.equal(store.getSession(sessionId, 3_000), null);

    const second = store.createSession({ ...alice, sessionExpiresAt: 4_000 }, 1_000);
    assert.equal(store.deleteSession(second), true);
    assert.equal(store.getSession(second, 1_001), null);
  });
});

test("keeps model source and worker capabilities isolated by user", async () => {
  await withStore(async ({ store }) => {
    const bobId = "22222222-2222-4222-8222-222222222222";
    const bobNamespace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.setModelSource(alice.userId, "platform", 1_000);
    store.setModelSource(bobId, "custom", 1_000);
    assert.equal(store.getModelSource(alice.userId), "platform");
    assert.equal(store.getModelSource(bobId), "custom");
    store.setPlatformModel(alice.userId, "platform-model-a", 1_001);
    store.setPlatformModel(bobId, "platform-model-b", 1_001);
    assert.equal(store.getPlatformModel(alice.userId), "platform-model-a");
    assert.equal(store.getPlatformModel(bobId), "platform-model-b");

    const capability = store.createWorkerCapability(alice.userId, alice.dataNamespace, 2_000, 1_000);
    assert.deepEqual(store.resolveWorkerCapability(capability, 1_001), {
      userId: alice.userId,
      dataNamespace: alice.dataNamespace,
    });
    assert.equal(store.resolveWorkerCapability(capability, 2_000), null);

    const aliceCapability = store.createWorkerCapability(alice.userId, alice.dataNamespace, 3_000, 1_000);
    const bobCapability = store.createWorkerCapability(bobId, bobNamespace, 3_000, 1_000);
    assert.equal(store.revokeWorkerCapabilities(alice.userId), 1);
    assert.equal(store.resolveWorkerCapability(aliceCapability, 1_001), null);
    assert.deepEqual(store.resolveWorkerCapability(bobCapability, 1_001), {
      userId: bobId,
      dataNamespace: bobNamespace,
    });
  });
});

test("persists deterministic worker access for idle cleanup", async () => {
  await withStore(async ({ store }) => {
    const containerName = `pe-worker-${alice.dataNamespace.replaceAll("-", "")}`;
    assert.deepEqual(
      store.touchWorkerInstance(alice.userId, alice.dataNamespace, containerName, 1_000),
      {
        userId: alice.userId,
        dataNamespace: alice.dataNamespace,
        containerName,
        lastAccessAt: 1_000,
        updatedAt: 1_000,
      },
    );
    assert.deepEqual(store.listIdleWorkerInstances(999), []);
    assert.equal(store.listIdleWorkerInstances(1_000).length, 1);
    store.touchWorkerInstance(alice.userId, alice.dataNamespace, containerName, 1_100);
    assert.equal(store.getWorkerInstance(alice.dataNamespace).lastAccessAt, 1_100);
    assert.throws(
      () => store.touchWorkerInstance(
        "22222222-2222-4222-8222-222222222222",
        alice.dataNamespace,
        containerName,
        1_200,
      ),
      /already owned/u,
    );
    assert.equal(store.deleteWorkerInstance(alice.dataNamespace), true);
    assert.equal(store.getWorkerInstance(alice.dataNamespace), null);
  });
});

test("migrates version 1 model preferences to selected platform models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-gateway-store-v1-"));
  const databasePath = join(root, "gateway.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE gateway_model_preferences (
      user_id TEXT PRIMARY KEY,
      model_source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version=1;
  `);
  database.close();

  const store = new PeGatewaySessionStore(databasePath, new GatewayTokenCipher(Buffer.alloc(32, 8)));
  try {
    store.setPlatformModel(alice.userId, "platform-model", 1_000);
    assert.equal(store.getPlatformModel(alice.userId), "platform-model");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
