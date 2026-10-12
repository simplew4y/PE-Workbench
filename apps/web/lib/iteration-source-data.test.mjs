import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sourceDataObservations, windReviewTasks } = await jiti.import("./iteration-source-data.ts");
const { sourceId } = await jiti.import("@earendil-works/pe-boot/source");
const row = { docId: "view", line: 4, metric: "2025年营业收入", value: 9, period: "2025年", unit: "亿元", scope: "产品", quote: "产品收入9亿元" };
const observation = { id: "obs", docId: "view", sourceField: row.metric, value: 9, period: row.period, unit: row.unit, quote: row.quote, context: { scope: "产品" }, evidenceIds: [sourceId({ docId: "view", location: { kind: "text", lineStart: 1, lineEnd: 20 } })] };

test("matches extracted fields rather than treating a read range as usage", () => {
  const observations = { observations: [observation] };
  assert.equal(sourceDataObservations(row, observations).length, 1);
  assert.deepEqual(sourceDataObservations(row), []);
  for (const patch of [{ metric: "净利润" }, { period: "2024年" }, { scope: "授权" }, { docId: "other" }, { quote: "另一行收入9亿元" }, { value: null }, { unit: "百万元" }, { line: 21 }]) {
    assert.deepEqual(sourceDataObservations({ ...row, ...patch }, observations), []);
  }
});

test("does not mark equal-valued business rows or uncited facts as used", () => {
  assert.deepEqual(sourceDataObservations({ ...row, scope: "授权", quote: "授权收入9亿元" }, { observations: [observation] }), []);
  assert.deepEqual(sourceDataObservations(row, { observations: [{ ...observation, evidenceIds: [] }] }), []);
  assert.deepEqual(sourceDataObservations(row, { observations: [{ ...observation, evidenceIds: [sourceId({ docId: "other", location: { kind: "text", lineStart: 4, lineEnd: 4 } })] }] }), []);
});

test("groups repeated warnings without discarding distinct unresolved evidence", () => {
  const reasons = ["收入币种未明确", "净利润币种未明确", "收入币种未明确", "全年/单季报告期未知", "EBIT定义未确认", "实际或预测角色未知", "没有分部数据", "其他证据缺口"];
  const tasks = windReviewTasks(reasons);
  assert.equal(tasks.length, 5);
  assert.equal(tasks.find(task => task.title === "币种与单位").reasons.length, 2);
  assert.deepEqual(new Set(tasks.flatMap(task => task.reasons)), new Set(reasons));
  assert.deepEqual(windReviewTasks([]), []);
});
