import { describe, expect, it } from "vitest";
import { mergeExtractionSubmission } from "../src/research/iteration-extraction.ts";
import type { IterationObservations } from "../src/research/iteration-model.ts";

const submission: IterationObservations = {
	observations: ["loss", "revenue"].map((id) => ({
		id,
		docId: "new",
		subject: "公司",
		metric: id,
		value: 9,
		period: "2025年度",
		unit: "千元",
		role: "fact" as const,
		quote: "9",
		evidenceIds: ["source:test"],
		gaps: [],
		context: {
			periodKind: "single" as const,
			asOf: null,
			scope: "集团",
			basisQuote: "9",
			eventKind: "none" as const,
			reviewReasons: [],
		},
	})),
	coverage: [{ docId: "new", readLocations: ["page 1"], gaps: [] }],
};

describe("extraction repairs", () => {
	it("repairs one observation while retaining unchanged results and immutable inputs", () => {
		const original = structuredClone(submission);
		const first = mergeExtractionSubmission(undefined, original);
		const repaired = mergeExtractionSubmission(first, {
			observations: [{ ...first.observations[0], value: -9, quote: "(9)" }],
		});
		expect(repaired.observations[0].value).toBe(-9);
		expect(repaired.observations[1]).toEqual(submission.observations[1]);
		expect(first).toEqual(submission);
		expect(original).toEqual(submission);
	});
	it("requires a complete first submission and rejects duplicate repairs", () => {
		expect(() => mergeExtractionSubmission(undefined, { observations: submission.observations })).toThrow(
			"包括恢复后的首次提交",
		);
		expect(() => mergeExtractionSubmission(undefined, { coverage: submission.coverage })).toThrow(
			"完整observations和coverage",
		);
		expect(() =>
			mergeExtractionSubmission(submission, {
				observations: [submission.observations[0], submission.observations[0]],
			}),
		).toThrow("Duplicate");
	});
	it("requires explicit gaps before removing an unsupported observation", () => {
		expect(() => mergeExtractionSubmission(submission, { removeObservationIds: ["loss"] })).toThrow("gaps");
		const repaired = mergeExtractionSubmission(submission, {
			removeObservationIds: ["loss"],
			coverage: [{ ...submission.coverage[0], gaps: ["亏损行标签缺失，无法核实"] }],
		});
		expect(repaired.observations.map((o) => o.id)).toEqual(["revenue"]);
		expect(repaired.coverage[0].gaps).toHaveLength(1);
	});
	it("rejects empty, conflicting and unknown removals", () => {
		expect(() => mergeExtractionSubmission(submission, {})).toThrow("不能为空");
		const coverage = [{ ...submission.coverage[0], gaps: ["缺口"] }];
		expect(() => mergeExtractionSubmission(submission, { coverage, removeObservationIds: ["unknown"] })).toThrow(
			"不存在",
		);
		expect(() =>
			mergeExtractionSubmission(submission, {
				coverage,
				removeObservationIds: ["loss"],
				observations: [submission.observations[0]],
			}),
		).toThrow("同时");
	});
});
