import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getPeRuntimeRole,
  isPeWorkerRequestAuthorized,
  isPeWorkerRuntime,
} = await createJiti(import.meta.url).import("./pe-runtime-role.ts");

test("defaults to the gateway role", () => {
  assert.equal(getPeRuntimeRole({}), "gateway");
  assert.equal(getPeRuntimeRole({ PE_RUNTIME_ROLE: "invalid" }), "gateway");
  assert.equal(isPeWorkerRuntime({ PE_RUNTIME_ROLE: "worker" }), true);
});

test("accepts only the exact worker capability", () => {
  const capability = `pew_${"a".repeat(43)}`;
  const env = { PE_RUNTIME_ROLE: "worker", PE_WORKER_CAPABILITY: capability };
  const request = (value) => new Request("http://worker.internal/api/sessions", {
    headers: value ? { "x-pe-worker-capability": value } : {},
  });

  assert.equal(isPeWorkerRequestAuthorized(request(capability), env), true);
  assert.equal(isPeWorkerRequestAuthorized(request(`${capability.slice(0, -1)}b`), env), false);
  assert.equal(isPeWorkerRequestAuthorized(request("short"), env), false);
  assert.equal(isPeWorkerRequestAuthorized(request(null), env), false);
  assert.equal(isPeWorkerRequestAuthorized(request(capability), { ...env, PE_RUNTIME_ROLE: "gateway" }), false);
});
