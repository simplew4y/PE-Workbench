import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { loadPeGatewayConfig } = await createJiti(import.meta.url).import("./config.ts");

const validEnv = {
  PE_BACKEND_URL: "https://capoo.fun/pe_workbench/backend/",
  PE_GATEWAY_DATABASE_PATH: "/tmp/pe-gateway-test.sqlite3",
  PE_SESSION_SECRET: "00".repeat(32),
};

test("loads and normalizes gateway configuration", () => {
  const config = loadPeGatewayConfig(validEnv);
  assert.equal(config.backendUrl, "https://capoo.fun/pe_workbench/backend");
  assert.equal(config.databasePath, "/tmp/pe-gateway-test.sqlite3");
  assert.equal(config.sessionSecret.length, 32);
  assert.equal(config.sessionTtlSeconds, 168 * 3600);
  assert.deepEqual(config.cookie, {
    name: "pe_workbench_session",
    path: "/pe_workbench",
    secure: true,
  });
  assert.deepEqual(config.worker, {
    storage: "bind",
    image: "pe-workbench-worker:local",
    dataRoot: "/srv/pe-workbench/users",
    idleSeconds: 30 * 60,
    capabilityTtlSeconds: 168 * 3600,
    startTimeoutMs: 120_000,
    cpuLimit: 2,
    memoryMb: 4096,
    pidsLimit: 256,
    uid: 1000,
    gid: 1000,
  });
});

test("rejects missing and weak secrets", () => {
  assert.throws(() => loadPeGatewayConfig({ ...validEnv, PE_SESSION_SECRET: undefined }), /required/u);
  assert.throws(() => loadPeGatewayConfig({ ...validEnv, PE_SESSION_SECRET: "abcd" }), /at least 32 bytes/u);
});

test("rejects backend URLs with embedded credentials", () => {
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_BACKEND_URL: "https://user:pass@example.test" }),
    /without embedded credentials/u,
  );
});

test("requires an absolute SQLite database path", () => {
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_GATEWAY_DATABASE_PATH: "data/gateway.sqlite3" }),
    /must be absolute/u,
  );
});

test("validates worker paths and resource limits", () => {
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_WORKER_DATA_ROOT: "users" }),
    /PE_WORKER_DATA_ROOT must be absolute/u,
  );
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_WORKER_MEMORY_MB: "0" }),
    /positive number/u,
  );
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_WORKER_PIDS_LIMIT: "1.5" }),
    /positive integer/u,
  );
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_WORKER_IMAGE: "--privileged" }),
    /PE_WORKER_IMAGE is invalid/u,
  );
  assert.throws(
    () => loadPeGatewayConfig({ ...validEnv, PE_WORKER_STORAGE: "host" }),
    /PE_WORKER_STORAGE must be bind or volume/u,
  );
  assert.equal(
    loadPeGatewayConfig({ ...validEnv, PE_WORKER_STORAGE: "volume" }).worker.storage,
    "volume",
  );
});
