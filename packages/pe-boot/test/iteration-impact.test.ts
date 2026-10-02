import { describe, expect, it } from "vitest";
import { equivalentComparisonPeriod, mergeImpactSubmission } from "../src/research/iteration-impact.ts";
import type { IterationImpacts } from "../src/research/iteration-model.ts";

const submission: IterationImpacts = {
	substantive: true,
	summary: "待核实",
	gaps: ["会计口径未确认"],
	impacts: ["one", "two"].map((id) => ({
		judgmentIds: [],
		sections: ["businessModel"],
		observationIds: [id],
		relation: "supplements" as const,
		comparable: false,
		comparisonBasis: null,
		reason: "新增披露",
		proposedChange: "补充事实",
		evidenceIds: ["source:test"],
	})),
};
describe("impact repairs", () => {
	it("retains unchanged entries and immutable previous checkpoints", () => {
		const first = mergeImpactSubmission(undefined, submission);
		const repaired = mergeImpactSubmission(first, {
			impactUpdates: [{ index: 1, impact: { ...first.impacts[1], reason: "确认口径后比较" } }],
		});
		expect(repaired.impacts[0]).toEqual(first.impacts[0]);
		expect(repaired.impacts[1].reason).toBe("确认口径后比较");
		expect(first).toEqual(submission);
		repaired.impacts[0].sections.push("monitoring");
		expect(first).toEqual(submission);
	});
	it("requires a complete first submission, rejects bad repair indices and conflicting modes", () => {
		expect(() => mergeImpactSubmission(undefined, { impacts: submission.impacts })).toThrow("首次");
		for (const indices of [[2], [0, 0]])
			expect(() =>
				mergeImpactSubmission(submission, {
					impactUpdates: indices.map((index) => ({ index, impact: submission.impacts[0] })),
				}),
			).toThrow("index");
		expect(() => mergeImpactSubmission(submission, { impacts: [], impactUpdates: [] })).toThrow("同时");
		expect(() => mergeImpactSubmission(submission, {})).toThrow("不能为空");
	});
	it("supports full replacements and metadata repairs without discarding unrelated results", () => {
		expect(mergeImpactSubmission(submission, { gaps: ["新缺口"] }).impacts).toEqual(submission.impacts);
		expect(mergeImpactSubmission(submission, { impacts: [], substantive: false }).impacts).toEqual([]);
	});
	it("normalizes complete calendar years without confusing quarter, half-year, or cutoff periods", () => {
		for (const alias of ["2025e", "2025年度", "截至2025年12月31日止年度"])
			expect(equivalentComparisonPeriod("2025", alias)).toBe(true);
		for (const other of ["2024", "2025Q1", "2025H1", "截至2025年6月30日止六个月", "截至2025年12月31日", "2025财年"])
			expect(equivalentComparisonPeriod("2025", other)).toBe(false);
	});
});
