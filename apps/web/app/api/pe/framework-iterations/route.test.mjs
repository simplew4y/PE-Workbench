import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import("./route.ts");
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");

test("rejects invalid input and untrusted origins before platform access", async () => {
  for (const body of [null, [], "invalid"]) {
    const response = await POST(new NextRequest("http://localhost/api/pe/framework-iterations", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
  const response = await GET(new NextRequest("http://localhost/api/pe/framework-iterations?datasetId=dataset_test", { headers: { host: "localhost", origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});

test("history and local review settings remain available when platform models are unavailable", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "pe-iteration-route-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PE_MULTI_USER_MODE: process.env.PE_MULTI_USER_MODE };
  const priorGateway = globalThis.__peGatewayRuntime;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PE_MULTI_USER_MODE = "0";
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.__peGatewayRuntime = priorGateway;
    rmSync(root, { recursive: true, force: true });
  });
  let modelCalls = 0;
  globalThis.__peGatewayRuntime = {
    config: { cookie: { name: "test-session" } },
    store: { getSession: () => ({ userId: "test-user" }) },
    auth: { currentUser: async () => ({ id: "test-user" }), requireSession: async () => ({ userId: "test-user" }) },
    models: {
      sourceForUser: () => "platform",
      catalogRuntime: async () => { modelCalls++; throw new Error("Catalog offline"); },
      platformRuntime: async () => { throw new Error("Must not buy model access for local operations"); },
    },
  };
  const project = createPeProject({ name: "Iteration read availability" });
  const headers = { host: "localhost", cookie: "test-session=authenticated", "Content-Type": "application/json" };
  const response = await GET(new NextRequest(`http://localhost/api/pe/framework-iterations?datasetId=${project.datasetId}`, { headers }));
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.runs, []);
  assert.equal(snapshot.modelId, "");
  assert.match(snapshot.modelError, /仍可查看历史/);
  assert.equal(modelCalls, 1);
  const saved = await POST(new NextRequest("http://localhost/api/pe/framework-iterations", {
    method: "POST", headers, body: JSON.stringify({ datasetId: project.datasetId, action: "test-project", enabled: true }),
  }));
  assert.equal(saved.status, 200);
  assert.equal(modelCalls, 1, "local mutation must not depend on the model catalog");
  globalThis.__peGatewayRuntime.store.getSession = () => null;
  const unauthorized = await GET(new NextRequest(`http://localhost/api/pe/framework-iterations?datasetId=${project.datasetId}`, { headers }));
  assert.equal(unauthorized.status, 401);
});

test("source creation and source downloads enforce the same origin boundary", async () => {
  const headers = { host: "localhost", origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" };
  const created = await POST(new NextRequest("http://localhost/api/pe/framework-iterations", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create-sources", datasetId: "dataset_test", basisVersionId: "baseline", requestId: "source", sourceIds: ["wind-financials"] }),
  }));
  assert.equal(created.status, 403);
  const downloaded = await GET(new NextRequest("http://localhost/api/pe/framework-iterations?datasetId=dataset_test&runId=other&download=source-raw&sourceQueryId=../../secret", { headers }));
  assert.equal(downloaded.status, 403);
  assert.equal((await downloaded.json()).error, "Untrusted API request");
});
