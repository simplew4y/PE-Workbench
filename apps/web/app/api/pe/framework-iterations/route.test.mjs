import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import("./route.ts");

test("rejects invalid input and untrusted origins before platform access", async () => {
  for (const body of [null, [], "invalid"]) {
    const response = await POST(new NextRequest("http://localhost/api/pe/framework-iterations", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
  const response = await GET(new NextRequest("http://localhost/api/pe/framework-iterations?datasetId=dataset_test", { headers: { host: "localhost", origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});
