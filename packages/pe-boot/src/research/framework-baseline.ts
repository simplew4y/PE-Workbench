import {
	type FrameworkContent,
	isFrameworkDocument,
	type StoredFrameworkContent,
	validateFrameworkContent,
} from "./model.ts";

/** Read an older saved framework as update input without rewriting its immutable version. */
export function frameworkUpdateBaseline(content: StoredFrameworkContent): FrameworkContent {
	if (isFrameworkDocument(content)) return content;
	return validateFrameworkContent({
		schemaVersion: 2,
		title: content.title,
		sections: {
			researchSetup: {
				objective: content.objective,
				horizon: content.horizon,
				preferences: null,
				informationCutoff: null,
			},
			currentAssessment: {
				summary: "沿用已保存框架中的判断和依据，逐项对照本轮新资料。",
				status: "待本轮核对",
				returnDrivers: [],
				keyUncertainties: content.coverageGaps,
				changesSinceLastVersion: "读取已保存的条目式框架；原判断、原文及证据保留，尚未根据新数据调整。",
				evidenceIds: [],
			},
			businessModel: {
				summary: "旧版未单独拆分经营说明，已有经营分析保留在各条判断的原文和依据中。",
				evidenceIds: [],
				drivers: [],
				kpis: [],
			},
			investmentJudgments: {
				items: content.items.map((item) => ({
					...item,
					counterEvidenceIds: [],
					confidence: { level: "undetermined", reason: "旧版未单独记录置信度；沿用原判断，不推定高低。" },
					alternativeExplanations: [],
				})),
			},
			valuation: {
				summary: "原估值分析及其限制保留在各条判断原文中；本轮重新核对模型输入和估值日期。",
				marketExpectations: "旧版未单独拆分市场预期，相关原文保留在各条判断中。",
				evidenceIds: [],
				forecastComparisons: [],
				scenarios: [],
				catalysts: [],
			},
			monitoring: {
				rules: content.items.map((item) => ({
					id: item.id,
					judgmentIds: [item.id],
					metric: item.subject,
					source: "沿用本条判断的原始证据，并在本轮读取项目资料与新增数据。",
					frequency: "旧版未单独记录频率。",
					warningThreshold: item.verification,
					invalidationThreshold: item.invalidation,
					action: "核对新证据后再判断是否调整。",
					thresholdBasis: "沿用原验证条件和失效条件，未新增数值阈值。",
					evidenceIds: item.evidenceIds,
				})),
			},
			evidenceAndChanges: { sources: [], openQuestions: [], coverageGaps: content.coverageGaps, changes: [] },
		},
	});
}
