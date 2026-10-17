import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAssessment, renderAssessment } from "./review_with_llm.mjs";

function fixture() {
	return {
		payload: { assumption_mapping: [{ assumption_id: "A6", model_inputs: [{ editable_cell: "假设!B32" }] }],
			wind_evidence: { evidence: [{ id: "W2.T1.R1.C3", value: 27.55, flags: ["single_vs_cumulative_unknown"], excluded_from_assessment: false },
				{ id: "W5.future", value: 123, flags: [], excluded_from_assessment: true }] } },
		result: { summary: "证据不足", overall_status: "insufficient_evidence", assessments: [{ assumption_id: "A6", status: "insufficient_evidence",
			evidence_ids: ["W2.T1.R1.C3"], comparison: "H1不能与H2预测比较", new_information: "旧基线重现", alternative_explanations: [],
			comparability: { period_match: false, currency_unit_match: null, metric_scope_match: null, baseline_restatement: true, notes: "H1旧值" },
			model_action: { action: "request_data", input_cells: ["假设!B32"], new_value: null, reason: "缺H2数据" }, missing_data: ["H2研发费用"] }],
			thesis_assessments: [], priority_followups: [], limitations: [], valuation_attribution: { can_explain_new_valuation_change: false, reason: "没有新估值" } },
	};
}

test("accepts a complete evidence-bounded assessment and renders plain text", () => {
	const { result, payload } = fixture();
	assert.equal(validateAssessment(result, payload), result);
	assert.match(renderAssessment(result), /H1不能与H2预测比较/);
});

test("rejects invented citations, future evidence and unverified cells", () => {
	for (const invalid of ["invented", "W5.future"]) {
		const { result, payload } = fixture();
		result.assessments[0].evidence_ids = [invalid];
		assert.throws(() => validateAssessment(result, payload), /证据/);
	}
	const { result, payload } = fixture();
	result.assessments[0].model_action.input_cells = ["假设!B31"];
	assert.throws(() => validateAssessment(result, payload), /输入/);
});

test("rejects numerical forecast changes based on noncomparable data", () => {
	const { result, payload } = fixture();
	result.assessments[0].model_action.new_value = 4000;
	assert.throws(() => validateAssessment(result, payload), /数值证据/);
});

test("rejects missing assumptions and an unsupported valuation attribution", () => {
	const { result, payload } = fixture();
	result.assessments = [];
	assert.throws(() => validateAssessment(result, payload), /全部关键假设/);
	const second = fixture();
	second.result.valuation_attribution.can_explain_new_valuation_change = true;
	assert.throws(() => validateAssessment(second.result, second.payload), /估值变化归因/);
});

test("does not treat retaining a forecast based on old H1 values as supporting H2", () => {
	const { result, payload } = fixture();
	result.assessments[0].status = "supported";
	result.assessments[0].model_action.action = "retain";
	assert.throws(() => validateAssessment(result, payload), /不可比或旧基线/);
});

test("missing publication date alone does not block otherwise comparable observations", () => {
	const { result, payload } = fixture();
	payload.wind_evidence.evidence[0].flags = ["publication_date_missing"];
	result.assessments[0].status = "supported";
	result.assessments[0].comparability = { period_match: true, currency_unit_match: true,
		metric_scope_match: true, baseline_restatement: false, notes: "已确认可比的证据" };
	assert.equal(validateAssessment(result, payload), result);
	result.assessments[0].comparability.baseline_restatement = true;
	assert.throws(() => validateAssessment(result, payload), /不可比或旧基线/);
});

test("preserves a provider's invalid comparison label as a warning, never as true", () => {
	const { result, payload } = fixture();
	result.assessments[0].comparability.currency_unit_match = "CNY";
	validateAssessment(result, payload);
	assert.equal(result.assessments[0].comparability.currency_unit_match, null);
	assert.equal(result.validation_warnings[0].original_value, "CNY");
	result.assessments[0].status = "supported";
	assert.throws(() => validateAssessment(result, payload), /不可比或旧基线/);
});
