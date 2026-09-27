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
    path: "/",
    secure: false,
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
