import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { PeBackendError } = await jiti.import("./backend-client.ts");
const { gatewayError } = await jiti.import("./route-helpers.ts");

test("preserves backend failures from a cached service after module reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-backend-reload-"));
  try {
    const duplicate = join(root, "backend-client.ts");
    await copyFile(new URL("./backend-client.ts", import.meta.url), duplicate);
    const { PeBackendClient, PeBackendError: ReloadedError } = await jiti.import(duplicate);
    assert.notEqual(ReloadedError, PeBackendError);
    const client = new PeBackendClient("https://example.test", 1_000, async () => {
      throw new TypeError("fetch failed");
    });
    const error = await client.login("test@example.test", "test-only").catch((error) => error);
    assert.ok(error instanceof PeBackendError);
    const response = gatewayError(error);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      code: "backend_unavailable", message: "PE 用户服务暂时不可用",
    });
    const denied = gatewayError(new ReloadedError(401, "invalid_credentials", "邮箱或密码错误"));
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, "invalid_credentials");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not treat an unbranded error as a backend error", () => {
  assert.equal(Object.assign(new Error("internal"), { status: 401, code: "invalid_credentials" }) instanceof PeBackendError, false);
  assert.equal({ name: "PeBackendError", status: 503, code: "backend_unavailable" } instanceof PeBackendError, false);
});
