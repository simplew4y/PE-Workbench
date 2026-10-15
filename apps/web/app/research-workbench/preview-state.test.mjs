import assert from "node:assert/strict";
import test from "node:test";
import { changeSetCsv, changes, createPreviewState, currentVersions, evidenceChange, modelSnapshot, previewReducer, researchReport, roundOutcome, roundSummary, visibleChanges } from "./preview-state.ts";

function completeScenario(scenario) {
  let state = previewReducer(createPreviewState(), { type: "scenario", scenario });
  state = previewReducer(state, { type: "run" });
  for (let step = 0; step < 4; step++) state = previewReducer(state, { type: "advance" });
  return state;
}

test("candidate changes never advance the current baseline before approval", () => {
  const candidate = completeScenario("revision");
  assert.equal(candidate.phase, "review");
  assert.deepEqual(currentVersions(candidate), { framework: "F01", model: "M01" });
  assert.equal(previewReducer(candidate, { type: "decide", decision: "approve", note: "短意见" }), candidate);
  const approved = previewReducer(candidate, { type: "decide", decision: "approve", note: "已核对证据并同意本轮局部修订" });
  assert.deepEqual(currentVersions(approved), { framework: "F02", model: "M02" });
  assert.equal(previewReducer(approved, { type: "decide", decision: "reject", note: "重复操作不应改变既有审批结果" }), approved);
  assert.equal(previewReducer(approved, { type: "run" }), approved);
});

test("framework approval never promotes a failed model", () => {
  const candidate = completeScenario("recalculation");
  const approved = previewReducer(candidate, { type: "decide", decision: "approve", note: "仅采用框架变化，模型继续沿用旧版" });
  assert.deepEqual(currentVersions(approved), { framework: "F02", model: "M01" });
  assert.match(researchReport(approved), /候选模型不可用/);
});

test("conflicts, no-change and rejection retain both baselines", () => {
  for (const scenario of ["conflict", "unchanged"]) {
    const state = completeScenario(scenario);
    assert.deepEqual(currentVersions(state), { framework: "F01", model: "M01" });
    assert.equal(previewReducer(state, { type: "decide", decision: "approve", note: "不能绕过证据问题发布本轮版本" }), state);
  }
  const rejected = previewReducer(completeScenario("revision"), { type: "decide", decision: "reject", note: "缺少持续性证据，本次保持原有假设" });
  assert.deepEqual(currentVersions(rejected), { framework: "F01", model: "M01" });
  assert.equal(rejected.phase, "rejected");
});

test("actuals auto-publish and scenario changes discard previous decisions", () => {
  const published = completeScenario("actuals");
  assert.equal(published.phase, "published");
  assert.equal(visibleChanges("actuals").length, 1);
  assert.equal(visibleChanges("unchanged").length, 0);
  const next = previewReducer(published, { type: "scenario", scenario: "conflict" });
  assert.equal(next.phase, "ready");
  assert.deepEqual(currentVersions(next), { framework: "F01", model: "M01" });
  assert.equal(next.decisionNote, "");
});

test("exports identify mock data and do not present conflicting values as adopted", () => {
  assert.match(changeSetCsv(completeScenario("conflict")), /待核实，不采用/);
  assert.match(researchReport(createPreviewState()), /虚构示例/);
  assert.match(researchReport(createPreviewState()), /当前框架：F01；当前模型：M01/);
  assert.doesNotMatch(changeSetCsv(completeScenario("conflict")), /低 5 个百分点/);
  assert.match(changeSetCsv(completeScenario("conflict")), /不计算预测误差/);
});

test("evidence and outcome copy follow the chosen scenario and decision", () => {
  assert.equal(evidenceChange(changes[1], "actuals").proposed, "+12.0%");
  assert.equal(evidenceChange(changes[0], "recalculation").proposed, "+8.0%");
  const approved = previewReducer(createPreviewState(), { type: "decide", decision: "approve", note: "同意本轮局部修改并保留验证条件" });
  assert.doesNotMatch(roundOutcome(approved), /等待审阅/);
  const rejected = previewReducer(createPreviewState(), { type: "decide", decision: "reject", note: "证据不足，本轮不采用候选修订" });
  assert.match(researchReport(rejected), /候选修订未采用/);
});

test("historical M01 inputs remain frozen after publishing or viewing M02", () => {
  const approved = previewReducer(createPreviewState(), { type: "decide", decision: "approve", note: "同意本轮修订并保持原始版本可追溯" });
  assert.equal(modelSnapshot(approved, "baseline").growth, "+6.0%");
  assert.equal(modelSnapshot(approved, "candidate").revenue, "+3.0%");
  assert.equal(modelSnapshot(approved, "original").revenue, "+8.0%");
  assert.equal(modelSnapshot(approved, "original").growth, "+12.0%");
  assert.equal(modelSnapshot(completeScenario("recalculation"), "candidate").available, false);
});

test("rejection stays visible in model status, exported CSV and summaries", () => {
  const rejected = previewReducer(createPreviewState(), { type: "decide", decision: "reject", note: "缺少持续性证据，本次保持原有假设" });
  assert.equal(modelSnapshot(rejected, "candidate").status, "未采用");
  assert.equal(modelSnapshot(rejected, "baseline").growth, "+12.0%");
  assert.match(changeSetCsv(rejected), /候选修订未采用/);
  assert.match(changeSetCsv(rejected), /缺少持续性证据/);
  assert.match(changeSetCsv(rejected), /"F01","M01"/);
  assert.doesNotMatch(roundSummary(rejected), /需要你的判断/);
  assert.doesNotMatch(roundSummary(completeScenario("actuals")), /需要你的判断/);
  assert.match(changeSetCsv({ ...rejected, decisionNote: "=SUM(1,2)" }), /"'=SUM\(1,2\)"/);
});
