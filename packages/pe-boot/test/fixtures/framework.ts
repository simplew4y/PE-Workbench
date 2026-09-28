import type { FrameworkContent, FrameworkItem, LegacyFrameworkContent } from "../../src/research/model.ts";

/** Complete test data; production code never fills absent document sections. */
export function frameworkFixture(input: Partial<LegacyFrameworkContent> = {}): FrameworkContent {
	const items = input.items ?? [
		{
			id: "demand",
			kind: "hypothesis",
			claim: "需求可能恢复",
			rationale: "用户提出的待验证假设",
			subject: "测试公司",
			verification: "核对季度订单",
			invalidation: "连续两季订单下降",
			origin: "user",
			evidenceIds: [],
		},
	];
	return {
		schemaVersion: 2,
		title: input.title ?? "投资框架",
		sections: {
			researchSetup: {
				objective: input.objective ?? "验证需求",
				horizon: input.horizon ?? "一年",
				preferences: null,
				informationCutoff: "2026-09-28",
			},
			currentAssessment: {
				summary: "需求假设仍待验证",
				status: "研究中",
				returnDrivers: ["盈利恢复"],
				keyUncertainties: ["订单持续性"],
				changesSinceLastVersion: "首次建立框架",
				evidenceIds: [],
			},
			businessModel: {
				summary: "测试公司通过销售产品获取收入",
				evidenceIds: [],
				drivers: [{ from: "订单", to: "收入", mechanism: "订单交付产生收入", evidenceIds: [] }],
				kpis: [{ name: "订单增长", period: "下一季度", value: null, impact: "影响收入增长", evidenceIds: [] }],
			},
			investmentJudgments: {
				items: items.map((item) => ({
					...item,
					counterEvidenceIds: [],
					confidence: { level: "undetermined", reason: "需要进一步证据" },
					alternativeExplanations: ["订单改善可能来自短期补库存"],
				})),
			},
			valuation: {
				summary: "估值资料待补充",
				marketExpectations: "尚无一致预期资料",
				evidenceIds: [],
				forecastComparisons: [
					{
						metric: "收入增长",
						period: "下一年",
						marketExpectation: null,
						ownForecast: null,
						difference: null,
						evidenceIds: [],
					},
				],
				scenarios: ["悲观", "基准", "乐观"].map((name, index) => ({
					id: `scenario-${index}`,
					name,
					assumptions: "需要验证经营假设",
					value: null,
					unit: "EUR/股",
					asOf: null,
					expectedReturn: null,
					calculation: "缺少估值输入",
					judgmentIds: [],
					evidenceIds: [],
				})),
				catalysts: [
					{ event: "季度业绩", expectedAt: "待公告", impact: "验证订单与利润", judgmentIds: [], evidenceIds: [] },
				],
			},
			monitoring: {
				rules: [
					{
						id: "orders",
						judgmentIds: [],
						metric: "订单增长",
						source: "公司季报",
						frequency: "每季度",
						warningThreshold: "增长停滞",
						invalidationThreshold: "连续两季下降",
						action: "重新评估需求判断",
						thresholdBasis: "用户设定的观察条件",
						evidenceIds: [],
					},
				],
			},
			evidenceAndChanges: {
				sources: [],
				openQuestions: [
					{
						id: "data-gap",
						question: "需求改善能否持续？",
						judgmentIds: [],
						status: "open",
						evidenceNeeded: "未来两个季度订单资料",
					},
				],
				coverageGaps: input.coverageGaps ?? ["待补充财报"],
				changes: [],
			},
		},
	};
}

export function withFrameworkItems(content: FrameworkContent, items: FrameworkItem[]): FrameworkContent {
	return structuredClone({ ...content, sections: { ...content.sections, investmentJudgments: { items } } });
}
