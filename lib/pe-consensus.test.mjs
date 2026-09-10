import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fetchPeConsensusCards } = await jiti.import("./pe-consensus.ts");

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

test("requests the selected project, sources and 50 cards without a client cwd", async (t) => {
  const controller = new AbortController();
  stubFetch(t, async (url, options) => {
    const query = new URL(url, "http://localhost").searchParams;
    assert.equal(query.get("datasetId"), "project & one");
    assert.equal(query.get("include_sources"), "true");
    assert.equal(query.get("limit"), "50");
    assert.equal(query.has("cwd"), false);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, "no-store");
    return Response.json({ dataset_id: "project & one", status: "completed", cards: [] });
  });
  assert.equal((await fetchPeConsensusCards("project & one", controller.signal)).status, "completed");
});

test("hides only the disabled-feature response, not missing projects or server errors", async (t) => {
  let error = "Consensus feature is disabled";
  let status = 404;
  stubFetch(t, async () => Response.json({ error }, { status }));
  assert.equal(await fetchPeConsensusCards("one"), null);
  error = "Project not found";
  await assert.rejects(fetchPeConsensusCards("one"), /Project not found/);
  status = 500;
  error = "Unable to read project consensus";
  await assert.rejects(fetchPeConsensusCards("one"), /Unable to read/);
});

test("rejects a mismatched dataset or invalid envelope", async (t) => {
  let payload = { dataset_id: "other", status: "completed", cards: [] };
  stubFetch(t, async () => Response.json(payload));
  await assert.rejects(fetchPeConsensusCards("one"), /Invalid project/);
  payload = { dataset_id: "one", status: "completed", cards: null };
  await assert.rejects(fetchPeConsensusCards("one"), /Invalid project/);
});

test("propagates cancellation without converting it to an empty successful result", async (t) => {
  const controller = new AbortController();
  controller.abort();
  stubFetch(t, async (_url, { signal }) => { signal.throwIfAborted(); });
  await assert.rejects(fetchPeConsensusCards("one", controller.signal), { name: "AbortError" });
});
