import { expect, it } from "vitest";
import { frameworkUpdateBaseline } from "../src/research/framework-baseline.ts";
import type { LegacyFrameworkContent } from "../src/research/model.ts";

it("preserves all saved reasoning, IDs, citations and unknown dates when reading an older framework", () => {
	const saved: LegacyFrameworkContent = {
		title: "公司投资框架 v3",
		objective: "验证需求假设",
		horizon: "两年",
		coverageGaps: ["估值日期尚未确证，文件名不是估值日期"],
		items: [
			{
				id: "china_demand",
				kind: "hypothesis",
				subject: "中国需求",
				claim: "收入下滑原因待核实",
				rationale: "可能是销量、价格或汇率变化",
				verification: "分地区、销量与价格分别核对",
				invalidation: "恢复增长后重新判断",
				origin: "user",
				evidenceIds: ["source:saved"],
			},
		],
	};
	const before = structuredClone(saved);
	const result = frameworkUpdateBaseline(saved);
	for (const [key, value] of Object.entries(saved.items[0]))
		expect(
			result.sections.investmentJudgments.items[0][
				key as keyof (typeof result.sections.investmentJudgments.items)[0]
			],
		).toEqual(value);
	expect(result.sections.researchSetup.informationCutoff).toBeNull();
	expect(result.sections.valuation.scenarios).toEqual([]);
	expect(result.sections.investmentJudgments.items[0].confidence.level).toBe("undetermined");
	expect(result.sections.evidenceAndChanges.coverageGaps).toEqual(saved.coverageGaps);
	expect(result.sections.monitoring.rules[0].invalidationThreshold).toBe(saved.items[0].invalidation);
	expect(saved).toEqual(before);
});
