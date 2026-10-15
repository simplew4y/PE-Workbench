import assert from "node:assert/strict";
import test from "node:test";
import { mappingFromObservation, parseModelLiteral } from "./research-workflow-form.ts";

test("model literals preserve types and reject formulas and infinite values", () => {
  assert.equal(parseModelLiteral("0"), 0);
  assert.equal(parseModelLiteral("-1.5e2"), -150);
  assert.equal(parseModelLiteral("false"), false);
  assert.equal(parseModelLiteral(""), null);
  assert.equal(parseModelLiteral('"001"'), "001");
  assert.equal(parseModelLiteral("001"), 1);
  assert.throws(() => parseModelLiteral("=SUM(A1:A3)"));
  assert.throws(() => parseModelLiteral('"=HYPERLINK()"'));
  assert.throws(() => parseModelLiteral("1e999"));
});

test("observation prefill does not invent a cell or use the new value as the old value", () => {
  const observation = { id: "revenue", subject: "Company", metric: "Revenue", value: 120, role: "fact", period: "2026H1", unit: "万元", sourceField: "revenue", context: { periodKind: "cumulative", asOf: null, scope: "合并" } };
  const mapping = mappingFromObservation(observation);
  assert.equal(mapping.cell, "");
  assert.equal(mapping.sheet, "");
  assert.equal(mapping.expectedValue, null);
  assert.equal(mapping.currency, null);
  assert.equal(mapping.role, "actual");
  assert.equal(mapping.periodKind, "cumulative");
  assert.equal(mapping.sourceField, "revenue");
  assert.equal(mappingFromObservation({ ...observation, role: "forecast" }).role, "assumption");
  assert.throws(() => mappingFromObservation({ ...observation, context: { ...observation.context, periodKind: "unknown" } }), /口径尚不明确/);
});
