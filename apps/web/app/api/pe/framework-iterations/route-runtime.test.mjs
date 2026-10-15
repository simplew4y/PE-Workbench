import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ marker = false, monitorRuns = [], available = true, modelId = "server-model" } = {}) {
  const run = { id: "run-1", status: "failed", modelId: "server-model", sourceMode: "documents", diagnostics: marker ? [{ tool: "pe_server_runtime" }] : [], leaseToken: "private-lease" };
  const project = { root: "/owned-project", datasetId: "project", name: "Research" };
  const callbacks = [];
  const resumed = [];
  let platformCalls = 0;
  class ResearchError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const exports = {};
  runInNewContext(code, {
    exports, Response, Error, SyntaxError,
    require(id) {
      if (id === "next/server") return { after: callback => callbacks.push(callback) };
      if (id === "@earendil-works/pe-boot") return {
        ResearchError,
        listFrameworkIterations: () => [run], getFrameworkIteration: () => run,
        getResearchFramework: () => ({ versions: [], drafts: [] }),
        iterationProjectSettings: () => ({ testProject: false }),
        getResearchMonitor: (cwd, datasetId) => {
          assert.equal(cwd, project.root); assert.equal(datasetId, project.datasetId);
          return { runs: monitorRuns };
        },
        getIterationChangeReview: () => null, listIterationChangeReviewHistory: () => [],
        getIterationModelUpdateResult: () => null, availableInformationSources: () => [],
      };
      if (id === "@/lib/pe-gateway/route-helpers") return { noStoreJson: (body, init) => Response.json(body, init) };
      if (id === "@/lib/framework-iteration-access") return { iterationRequestContext: async () => ({ project, sessionId: "session", userId: "owner" }) };
      if (id === "@/lib/framework-iteration-runtime") return {
        iterationPlatform: async () => { platformCalls++; throw new ResearchError(409, "平台模型不可用"); },
        resumeServerFrameworkIteration: async (selectedProject, selectedRun) => resumed.push([selectedProject.datasetId, selectedRun.id]),
        executeFrameworkIteration: assert.fail,
      };
      if (id === "@/services/pe-research/iteration-runtime.mjs") return { serverIterationRuntimeStatus: () => ({ available, modelId }) };
      if (id === "@/lib/bounded-form-data") return { RequestBodyTooLargeError: class extends Error {} };
      if (id.startsWith("@/")) return {};
      return require(id);
    },
  });
  return {
    callbacks, resumed, platformCalls: () => platformCalls,
    get: (query = "&runId=run-1") => exports.GET({ nextUrl: new URL(`http://localhost/api/pe/framework-iterations?datasetId=project${query}`) }),
    resume: () => exports.POST(new Request("http://localhost/api/pe/framework-iterations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: "project", runId: "run-1", action: "resume" }) })),
  };
}

for (const scenario of [
  { name: "runtime marker", marker: true, server: true },
  { name: "monitor linkage without any runtime marker", monitorRuns: [{ pipeline: "iteration", iterationId: "run-1" }], server: true },
  { name: "another monitor run", monitorRuns: [{ pipeline: "iteration", iterationId: "other" }], server: false },
  { name: "non-iteration monitor run", monitorRuns: [{ pipeline: "legacy", iterationId: "run-1" }], server: false },
  { name: "ordinary platform run", server: false },
]) {
  test(`GET, report and resume agree on ${scenario.name} while platform is unavailable`, async () => {
    const route = harness(scenario);
    const response = await route.get();
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.runRuntime, scenario.server ? "server" : "platform");
    assert.equal(snapshot.modelId, "");
    assert.equal(snapshot.modelError, "平台模型不可用");
    assert.equal(snapshot.run.leaseToken, undefined);
    const reportResponse = await route.get("&runId=run-1&download=report");
    assert.equal(reportResponse.status, 200);
    const report = JSON.parse((await reportResponse.text()).match(/```json\n([\s\S]+)\n```/)[1]);
    assert.equal(report.runRuntime, snapshot.runRuntime);
    assert.equal(report.costCurrency, scenario.server ? null : "CNY");
    assert.match(report.costNote, scenario.server ? /供应商账单/ : /平台结算/);
    const callsBeforeResume = route.platformCalls();
    const resumed = await route.resume();
    assert.equal(resumed.status, scenario.server ? 202 : 409);
    assert.equal(route.platformCalls(), callsBeforeResume + (scenario.server ? 0 : 1));
    assert.equal(route.callbacks.length, scenario.server ? 1 : 0);
    for (const callback of route.callbacks) await callback();
    assert.deepEqual(route.resumed, scenario.server ? [["project", "run-1"]] : []);
  });
}

for (const settings of [{ available: false }, { modelId: "different-server-model" }]) {
  test(`monitor-linked resume never falls back to platform with server ${JSON.stringify(settings)}`, async () => {
    const route = harness({ ...settings, monitorRuns: [{ pipeline: "iteration", iterationId: "run-1" }] });
    const response = await route.resume();
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /不能切换到聊天账户/);
    assert.equal(route.platformCalls(), 0);
    assert.equal(route.callbacks.length, 0);
  });
}

test("no selected run has no runtime and history-only remains independent of model access", async () => {
  const route = harness();
  assert.equal((await (await route.get("")).json()).runRuntime, null);
  const before = route.platformCalls();
  const response = await route.get("&historyOnly=1");
  assert.equal(response.status, 200);
  assert.equal(route.platformCalls(), before);
});
