import { expect, it } from "vitest";
import { mergeIterationRevision } from "../src/research/iteration-revision.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

it("patches one judgment field while preserving the entire remaining framework and original baseline", () => {
	const basis = frameworkFixture();
	const original = structuredClone(basis);
	const result = mergeIterationRevision(basis, {
		judgmentUpdates: [{ id: "demand", patch: { rationale: "新数据需要继续核对。" } }],
		sections: {
			currentAssessment: { ...basis.sections.currentAssessment, changesSinceLastVersion: "补充核对事项。" },
		},
	});
	const expected = structuredClone(basis);
	expected.sections.investmentJudgments.items[0].rationale = "新数据需要继续核对。";
	expected.sections.currentAssessment.changesSinceLastVersion = "补充核对事项。";
	expect(result).toEqual(expected);
	expect(basis).toEqual(original);
});

it.each([
	{},
	{ judgmentUpdates: [{ id: "missing", patch: { rationale: "不存在的判断。" } }] },
	{ judgmentUpdates: [{ id: "demand", patch: {} }] },
	{ judgmentUpdates: [{ id: "demand", patch: { id: "other" } }] },
	{
		judgmentUpdates: [
			{ id: "demand", patch: { rationale: "a" } },
			{ id: "demand", patch: { rationale: "b" } },
		],
	},
	{ sections: { arbitrary: {} } },
])("rejects incomplete or ambiguous revision patches %#", (patch) => {
	expect(() => mergeIterationRevision(frameworkFixture(), patch)).toThrow();
});

it("rejects two competing versions of the investment judgments", () => {
	const basis = frameworkFixture();
	expect(() =>
		mergeIterationRevision(basis, {
			sections: { investmentJudgments: basis.sections.investmentJudgments },
			judgmentUpdates: [{ id: "demand", patch: { rationale: "改动。" } }],
		}),
	).toThrow("不能同时提交");
});
