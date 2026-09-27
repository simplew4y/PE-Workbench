import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");
const { createPeProject } = await jiti.import("../../../../lib/pe-project-store.ts");

test("consensus API is unavailable by default before reading projects", async (t) => {
  const old = process.env.PE_CONSENSUS_ENABLED;
  delete process.env.PE_CONSENSUS_ENABLED;
  t.after(() => {
    if (old === undefined) delete process.env.PE_CONSENSUS_ENABLED;
    else process.env.PE_CONSENSUS_ENABLED = old;
  });
  const response = await GET(new NextRequest("http://localhost/api/pe/consensus"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Consensus feature is disabled" });
});

test("consensus API resolves the registered project and rejects invalid or foreign identifiers", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pe-consensus-api-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  const oldEnabled = process.env.PE_CONSENSUS_ENABLED;
  process.env.PE_CONSENSUS_ENABLED = "1";
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (oldEnabled === undefined) delete process.env.PE_CONSENSUS_ENABLED;
    else process.env.PE_CONSENSUS_ENABLED = oldEnabled;
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  });
  const project = createPeProject({ name: "Consensus API" });
  const call = (query) => GET(new NextRequest(`http://localhost/api/pe/consensus?${query}`));
  for (const query of ["", `datasetId=${project.datasetId}&limit=NaN`,
    `datasetId=${project.datasetId}&card_type=invalid`, `datasetId=${project.datasetId}&limit=101`]) {
    assert.equal((await call(query)).status, 400);
  }
  assert.equal((await call("datasetId=unknown-project&cwd=/tmp")).status, 404);
  const response = await call(`datasetId=${project.datasetId}&include_sources=true`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dataset_id, project.datasetId);
  assert.equal(body.status, "not_analyzed");
  assert.deepEqual(body.cards, []);
  assert.ok(!JSON.stringify(body).includes(root));
});
