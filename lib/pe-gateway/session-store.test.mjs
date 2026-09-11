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

test("keeps model source and selected platform model isolated by account", async () => {
  await withStore(async ({ store }) => {
    const bobId = "22222222-2222-4222-8222-222222222222";
    store.setModelSource(alice.userId, "platform", 1_000);
    store.setModelSource(bobId, "custom", 1_000);
    assert.equal(store.getModelSource(alice.userId), "platform");
    assert.equal(store.getModelSource(bobId), "custom");
    store.setPlatformModel(alice.userId, "platform-model-a", 1_001);
    store.setPlatformModel(bobId, "platform-model-b", 1_001);
    assert.equal(store.getPlatformModel(alice.userId), "platform-model-a");
    assert.equal(store.getPlatformModel(bobId), "platform-model-b");
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

test("removes legacy worker metadata when migrating a version 3 database", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-gateway-store-v3-"));
  const databasePath = join(root, "gateway.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE gateway_worker_capabilities (
      capability_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data_namespace TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE gateway_worker_instances (
      data_namespace TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      container_name TEXT NOT NULL UNIQUE,
      last_access_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    PRAGMA user_version=3;
  `);
  database.close();

  const store = new PeGatewaySessionStore(databasePath, new GatewayTokenCipher(Buffer.alloc(32, 8)));
  store.close();
  const migrated = new DatabaseSync(databasePath);
  try {
    const tables = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gateway_worker_%'",
    ).all();
    assert.deepEqual(tables, []);
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 4);
  } finally {
    migrated.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("removes legacy capabilities when migrating a version 1 database", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-gateway-store-v1-worker-"));
  const databasePath = join(root, "gateway.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE gateway_model_preferences (
      user_id TEXT PRIMARY KEY,
      model_source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gateway_worker_capabilities (
      capability_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data_namespace TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    PRAGMA user_version=1;
  `);
  database.close();

  const store = new PeGatewaySessionStore(databasePath, new GatewayTokenCipher(Buffer.alloc(32, 8)));
  store.close();
  const migrated = new DatabaseSync(databasePath);
  try {
    const capability = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_worker_capabilities'",
    ).get();
    assert.equal(capability, undefined);
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 4);
  } finally {
    migrated.close();
    await rm(root, { recursive: true, force: true });
  }
});
