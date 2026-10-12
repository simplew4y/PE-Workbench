import { describe, expect, it } from "vitest";
import { peAssumptionReviewTool, reviewAssumptionUpdates } from "../src/tools/assumption-review.ts";

describe("assumption review", () => {
	it("keeps a small same-direction miss in the current research version", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "china-growth",
				period: "2026Q3",
				originalForecast: 8,
				actual: 7,
				direction: { forecast: "positive", actual: "positive", industry: "positive" },
				tolerance: { maxRelativeVariancePercent: 20 },
				evidenceIds: ["source-1"],
			},
		]);
		expect(result).toMatchObject({ version_state: "current_research", can_advance_baseline: true });
		expect(result.assessments[0]).toMatchObject({ action: "record_deviation", flags: [] });
	});

	it("requires scenarios for a persistent material direction conflict", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "china-growth",
				period: "2026Q3",
				originalForecast: 12,
				actual: -4,
				direction: { forecast: "positive", actual: "negative", industry: "negative" },
				tolerance: {
					maxRelativeVariancePercent: 30,
					materialValuationImpactPercent: 5,
					persistentMissCount: 2,
				},
				valuationImpactPercent: -8,
				consecutiveMissCount: 2,
				evidenceIds: ["filing", "industry"],
			},
		]);
		expect(result).toMatchObject({ version_state: "candidate", can_advance_baseline: false });
		expect(result.assessments[0]).toMatchObject({
			action: "require_scenarios",
			flags: expect.arrayContaining([
				"actual_direction_conflict",
				"industry_direction_conflict",
				"large_forecast_error",
				"material_valuation_impact",
				"persistent_miss",
			]),
		});
	});

	it("retains the prior assumption when evidence conflicts", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "volume-growth",
				period: "2026",
				originalForecast: 5,
				actual: -1,
				direction: { forecast: "positive", actual: "negative" },
				evidenceIds: ["filing", "channel-check"],
				evidenceConflict: true,
			},
		]);
		expect(result.assessments[0].action).toBe("retain_unresolved");
		expect(result.can_advance_baseline).toBe(false);
	});

	it("does not treat industry divergence as a failure when company-specific evidence exists", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "vehicle-growth",
				period: "2026Q3",
				originalForecast: 4,
				actual: 3,
				direction: { forecast: "positive", actual: "positive", industry: "negative" },
				tolerance: { maxAbsoluteVariance: 2 },
				evidenceIds: ["results", "new-model-launch"],
				companySpecificEvidence: true,
			},
		]);
		expect(result.version_state).toBe("current_research");
		expect(result.assessments[0].flags).not.toContain("industry_direction_conflict");
	});

	it("does not advance an unsupported observation", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "margin",
				period: "2026Q3",
				originalForecast: 20,
				actual: 15,
				tolerance: { maxAbsoluteVariance: 2 },
				evidenceIds: [],
			},
		]);
		expect(result).toMatchObject({ version_state: "candidate", can_advance_baseline: false });
		expect(result.assessments[0].action).toBe("retain_unresolved");
	});

	it("allows a human-reviewed local revision to advance", () => {
		const result = reviewAssumptionUpdates([
			{
				metricId: "margin",
				period: "2027",
				originalForecast: 20,
				actual: 15,
				tolerance: { maxAbsoluteVariance: 2 },
				evidenceIds: ["results"],
				revision: { proposedValue: 17, evidenceIds: ["results", "guidance"], humanReviewed: true },
			},
		]);
		expect(result).toMatchObject({ version_state: "reviewed", can_advance_baseline: true });
		expect(result.assessments[0].action).toBe("propose_local_revision");
	});

	it("makes hard validation failures unavailable", () => {
		const result = reviewAssumptionUpdates(
			[
				{
					metricId: "revenue",
					period: "2026",
					originalForecast: 100,
					actual: 100,
					evidenceIds: ["filing"],
				},
			],
			["balance sheet does not balance"],
		);
		expect(result).toMatchObject({ version_state: "unavailable", can_advance_baseline: false });
		expect(result.assessments[0].action).toBe("invalid");
	});

	it("registers a callable tool", () => {
		expect(peAssumptionReviewTool.name).toBe("pe_assumption_review");
	});
});
