import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type AssumptionDirection = "positive" | "flat" | "negative" | "unknown";
export type AssumptionAction =
	| "retain"
	| "record_deviation"
	| "propose_local_revision"
	| "require_scenarios"
	| "retain_unresolved"
	| "invalid";
export type ModelVersionState = "current_research" | "candidate" | "reviewed" | "unavailable";

export interface AssumptionReviewItem {
	metricId: string;
	period: string;
	originalForecast: number;
	actual?: number;
	consensus?: number;
	direction?: {
		forecast: AssumptionDirection;
		actual?: AssumptionDirection;
		industry?: AssumptionDirection;
	};
	historicalRange?: { low: number; high: number };
	tolerance?: {
		maxAbsoluteVariance?: number;
		maxRelativeVariancePercent?: number;
		materialValuationImpactPercent?: number;
		persistentMissCount?: number;
	};
	valuationImpactPercent?: number;
	consecutiveMissCount?: number;
	evidenceIds: string[];
	companySpecificEvidence?: boolean;
	evidenceConflict?: boolean;
	revision?: {
		proposedValue: number;
		evidenceIds: string[];
		hasBaseBearBullScenarios?: boolean;
		humanReviewed?: boolean;
	};
}

export interface AssumptionAssessment {
	metric_id: string;
	period: string;
	action: AssumptionAction;
	review_required: boolean;
	original_forecast: number;
	actual?: number;
	consensus?: number;
	absolute_variance?: number;
	relative_variance_percent?: number;
	flags: string[];
	reasons: string[];
	missing_checks: string[];
}

export interface AssumptionReviewResult {
	schema_version: "1.0";
	version_state: ModelVersionState;
	can_advance_baseline: boolean;
	assessments: AssumptionAssessment[];
	blocking_reasons: string[];
	answer_contract: string;
}

function oppositeDirections(left: AssumptionDirection | undefined, right: AssumptionDirection | undefined): boolean {
	return Boolean((left === "positive" && right === "negative") || (left === "negative" && right === "positive"));
}

function finite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function reviewAssumptionUpdates(
	items: readonly AssumptionReviewItem[],
	hardValidationErrors: readonly string[] = [],
): AssumptionReviewResult {
	const assessments = items.map((item): AssumptionAssessment => {
		const flags: string[] = [];
		const reasons: string[] = [];
		const missingChecks: string[] = [];
		const absoluteVariance = finite(item.actual) ? item.actual - item.originalForecast : undefined;
		const relativeVariancePercent =
			finite(absoluteVariance) && item.originalForecast !== 0
				? (Math.abs(absoluteVariance) / Math.abs(item.originalForecast)) * 100
				: undefined;

		if (oppositeDirections(item.direction?.forecast, item.direction?.actual)) {
			flags.push("actual_direction_conflict");
			reasons.push("实际表现与原预测方向相反");
		}
		if (oppositeDirections(item.direction?.forecast, item.direction?.industry) && !item.companySpecificEvidence) {
			flags.push("industry_direction_conflict");
			reasons.push("原预测与行业方向相反，且没有公司特异性证据");
		}
		if (item.historicalRange) {
			if (item.historicalRange.low > item.historicalRange.high)
				throw new Error(`${item.metricId}: historical range low must not exceed high`);
			if (item.originalForecast < item.historicalRange.low || item.originalForecast > item.historicalRange.high) {
				flags.push("outside_historical_range");
				reasons.push("原预测超出所提供的历史区间");
			}
		}
		const tolerance = item.tolerance;
		const largeAbsoluteVariance =
			finite(absoluteVariance) &&
			finite(tolerance?.maxAbsoluteVariance) &&
			Math.abs(absoluteVariance) > tolerance.maxAbsoluteVariance;
		const largeRelativeVariance =
			finite(relativeVariancePercent) &&
			finite(tolerance?.maxRelativeVariancePercent) &&
			relativeVariancePercent > tolerance.maxRelativeVariancePercent;
		if (largeAbsoluteVariance || largeRelativeVariance) {
			flags.push("large_forecast_error");
			reasons.push("实际值与原预测的偏差超过该指标设定的容差");
		}
		if (
			finite(item.actual) &&
			!finite(tolerance?.maxAbsoluteVariance) &&
			!finite(tolerance?.maxRelativeVariancePercent)
		)
			missingChecks.push("未提供该指标的绝对或相对误差容差，不能仅凭百分比判断偏差是否过大");
		if (
			finite(item.valuationImpactPercent) &&
			finite(tolerance?.materialValuationImpactPercent) &&
			Math.abs(item.valuationImpactPercent) >= tolerance.materialValuationImpactPercent
		) {
			flags.push("material_valuation_impact");
			reasons.push("偏差对估值的影响达到该指标设定的重要性门槛");
		}
		if (
			(item.consecutiveMissCount ?? 0) >= (tolerance?.persistentMissCount ?? 2) &&
			(item.consecutiveMissCount ?? 0) > 0
		) {
			flags.push("persistent_miss");
			reasons.push("偏差已连续出现，不能再按单期噪声处理");
		}
		if (item.evidenceConflict) {
			flags.push("evidence_conflict");
			reasons.push("支持不同结论的证据相互冲突");
		}
		if (!item.evidenceIds.length) missingChecks.push("本轮观察没有可定位证据");

		const strongConflict = flags.some((flag) =>
			[
				"actual_direction_conflict",
				"industry_direction_conflict",
				"large_forecast_error",
				"outside_historical_range",
				"persistent_miss",
			].includes(flag),
		);
		const materialConflict = flags.includes("material_valuation_impact");
		let action: AssumptionAction;
		if (hardValidationErrors.length) action = "invalid";
		else if (item.evidenceConflict || (!item.evidenceIds.length && !item.revision?.evidenceIds.length))
			action = "retain_unresolved";
		else if (strongConflict && !item.revision)
			action = materialConflict ? "require_scenarios" : "propose_local_revision";
		else if (item.revision) {
			if (!item.revision.evidenceIds.length) {
				action = "retain_unresolved";
				missingChecks.push("建议新假设没有独立证据，不能覆盖原值");
			} else if (materialConflict && !item.revision.hasBaseBearBullScenarios) {
				action = "require_scenarios";
				missingChecks.push("重大估值影响需要基准、悲观和乐观情景");
			} else action = "propose_local_revision";
		} else if (finite(absoluteVariance) && absoluteVariance !== 0) action = "record_deviation";
		else action = "retain";

		return {
			metric_id: item.metricId,
			period: item.period,
			action,
			review_required:
				action === "propose_local_revision" || action === "require_scenarios" || action === "retain_unresolved",
			original_forecast: item.originalForecast,
			...(finite(item.actual) ? { actual: item.actual } : {}),
			...(finite(item.consensus) ? { consensus: item.consensus } : {}),
			...(finite(absoluteVariance) ? { absolute_variance: absoluteVariance } : {}),
			...(finite(relativeVariancePercent) ? { relative_variance_percent: relativeVariancePercent } : {}),
			flags,
			reasons,
			missing_checks: missingChecks,
		};
	});

	const blockingReasons = [...hardValidationErrors];
	for (const assessment of assessments) {
		if (assessment.action === "retain_unresolved" || assessment.action === "require_scenarios")
			blockingReasons.push(
				`${assessment.metric_id}：${assessment.reasons.join("；") || assessment.missing_checks.join("；")}`,
			);
	}
	items.forEach((item, index) => {
		if (
			item.revision &&
			item.revision.humanReviewed !== true &&
			assessments[index].action === "propose_local_revision"
		)
			blockingReasons.push(`${item.metricId}：建议假设尚未经过研究员复核`);
	});
	const hasRevision = items.some((item) => item.revision);
	const allRevisionsReviewed = items.every((item) => !item.revision || item.revision.humanReviewed === true);
	const hasUnresolvedAction = assessments.some(
		(assessment) => assessment.action === "retain_unresolved" || assessment.action === "require_scenarios",
	);
	const hasUnreviewedRevision = items.some((item) => item.revision && item.revision.humanReviewed !== true);
	const hasUnresolvedProposal = assessments.some(
		(assessment, index) => assessment.action === "propose_local_revision" && !items[index].revision,
	);
	const versionState: ModelVersionState = hardValidationErrors.length
		? "unavailable"
		: hasUnresolvedAction || hasUnreviewedRevision || hasUnresolvedProposal
			? "candidate"
			: hasRevision && allRevisionsReviewed
				? "reviewed"
				: "current_research";
	return {
		schema_version: "1.0",
		version_state: versionState,
		can_advance_baseline: versionState === "current_research" || versionState === "reviewed",
		assessments,
		blocking_reasons: blockingReasons,
		answer_contract:
			"Direction conflicts trigger review, not automatic replacement. Metric-specific tolerances determine whether magnitude is large. Conflicting or unsupported evidence retains the prior assumption. Hard model validation errors make the version unavailable.",
	};
}

const direction = Type.Union([
	Type.Literal("positive"),
	Type.Literal("flat"),
	Type.Literal("negative"),
	Type.Literal("unknown"),
]);

export const peAssumptionReviewTool = defineTool({
	name: "pe_assumption_review",
	label: "PE Assumption Review",
	description:
		"Classify forecast errors, direction conflicts, evidence gaps and model version eligibility before changing assumptions. Thresholds are metric-specific; the tool does not invent new forecasts.",
	parameters: Type.Object({
		items: Type.Array(
			Type.Object({
				metric_id: Type.String({ minLength: 1 }),
				period: Type.String({ minLength: 1 }),
				original_forecast: Type.Number(),
				actual: Type.Optional(Type.Number()),
				consensus: Type.Optional(Type.Number()),
				direction: Type.Optional(
					Type.Object({
						forecast: direction,
						actual: Type.Optional(direction),
						industry: Type.Optional(direction),
					}),
				),
				historical_range: Type.Optional(Type.Object({ low: Type.Number(), high: Type.Number() })),
				tolerance: Type.Optional(
					Type.Object({
						max_absolute_variance: Type.Optional(Type.Number({ minimum: 0 })),
						max_relative_variance_percent: Type.Optional(Type.Number({ minimum: 0 })),
						material_valuation_impact_percent: Type.Optional(Type.Number({ minimum: 0 })),
						persistent_miss_count: Type.Optional(Type.Integer({ minimum: 1 })),
					}),
				),
				valuation_impact_percent: Type.Optional(Type.Number()),
				consecutive_miss_count: Type.Optional(Type.Integer({ minimum: 0 })),
				evidence_ids: Type.Array(Type.String({ minLength: 1 })),
				company_specific_evidence: Type.Optional(Type.Boolean()),
				evidence_conflict: Type.Optional(Type.Boolean()),
				revision: Type.Optional(
					Type.Object({
						proposed_value: Type.Number(),
						evidence_ids: Type.Array(Type.String({ minLength: 1 })),
						has_base_bear_bull_scenarios: Type.Optional(Type.Boolean()),
						human_reviewed: Type.Optional(Type.Boolean()),
					}),
				),
			}),
			{ minItems: 1, maxItems: 100 },
		),
		hard_validation_errors: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	}),
	async execute(_id, params) {
		const result = reviewAssumptionUpdates(
			params.items.map((item) => ({
				metricId: item.metric_id,
				period: item.period,
				originalForecast: item.original_forecast,
				actual: item.actual,
				consensus: item.consensus,
				direction: item.direction,
				historicalRange: item.historical_range,
				tolerance: item.tolerance
					? {
							maxAbsoluteVariance: item.tolerance.max_absolute_variance,
							maxRelativeVariancePercent: item.tolerance.max_relative_variance_percent,
							materialValuationImpactPercent: item.tolerance.material_valuation_impact_percent,
							persistentMissCount: item.tolerance.persistent_miss_count,
						}
					: undefined,
				valuationImpactPercent: item.valuation_impact_percent,
				consecutiveMissCount: item.consecutive_miss_count,
				evidenceIds: item.evidence_ids,
				companySpecificEvidence: item.company_specific_evidence,
				evidenceConflict: item.evidence_conflict,
				revision: item.revision
					? {
							proposedValue: item.revision.proposed_value,
							evidenceIds: item.revision.evidence_ids,
							hasBaseBearBullScenarios: item.revision.has_base_bear_bull_scenarios,
							humanReviewed: item.revision.human_reviewed,
						}
					: undefined,
			})),
			params.hard_validation_errors ?? [],
		);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
