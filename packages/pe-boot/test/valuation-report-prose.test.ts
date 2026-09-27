import { describe, expect, it } from "vitest";
import { validateReportSectionProse } from "../src/tools/valuation-report-prose.ts";

describe("valuation report prose validation", () => {
	it.each([
		"若盈利下降，估值可能承压。",
		"如果收入下降，利润可能下滑。",
		"利润下降可能影响目标价。",
		"需关注收入增长无法兑现的风险。",
		"毛利率下降的风险影响模型假设。",
		"成本压力可能导致利润下降。",
		"If revenue falls, profit could decline.",
		"Margin may contract under competitive pressure.",
	])("retains explicit qualitative scenarios and risks: %s", (analysis) => {
		const result = validateReportSectionProse({ title: "核心驱动因素", analysis }, 0);
		expect(result.issues).toEqual([]);
		expect(result.analysis).toBe(analysis);
	});

	it.each([
		["盈利预测与估值敏感性", "品牌定价能力的提升是模型依赖的假设。"],
		["模型核心风险点", "需核对盈利假设。品牌定价能力提升是模型依赖的假设。"],
		["核心驱动因素", "需核对盈利假设，品牌定价能力提升是模型依赖的假设。"],
	])("does not join headings, sentences or clauses into a financial claim: %s", (title, analysis) => {
		expect(validateReportSectionProse({ title, analysis }, 0).issues).toEqual([]);
	});

	it.each([
		"收入增长。",
		"税率相对稳定。",
		"毛利率扩张。",
		"Revenue has increased.",
		"利润已经下降，未来可能改善。",
		"当前收入增长。",
		"若收入下降，税率实际保持稳定。",
		"收入增长。若盈利下降，估值可能承压。",
		"如果利润下降，收入已经增长。",
	])("still requires evidence for observed trends, including those beside a hypothesis: %s", (analysis) => {
		const result = validateReportSectionProse({ title: "模型核心风险点", analysis }, 0);
		expect(result.issues.some((issue) => issue.code === "financial_trend" && issue.field === "analysis")).toBe(true);
	});

	it.each(["若盈利下降20%，估值可能承压。", "收入增长２０%。", "二〇二四年收入五百亿欧元。", "EPS 为 3.50。"])(
		"does not exempt numeric claims inside conditional prose: %s",
		(analysis) => {
			const result = validateReportSectionProse({ title: "预测假设", analysis }, 2);
			expect(result.issues).toEqual([
				expect.objectContaining({ section_index: 2, field: "analysis", code: "numeric_claim", excerpt: analysis }),
			]);
		},
	);

	it.each(["2026E 估值", "毛利率扩张", "若利润下降", "参考 [来源](#pe-source?evidence_id=source%3Afake)"])(
		"validates nonneutral headings separately: %s",
		(title) => {
			const result = validateReportSectionProse({ title, analysis: "品牌定价能力影响模型假设。" }, 1);
			expect(result.issues).toEqual([expect.objectContaining({ field: "title", excerpt: title })]);
		},
	);

	it("points manual citations to fact_ids without labelling a neutral title invalid", () => {
		const analysis = "估值依据 [来源](#pe-source?evidence_id=source%3Afake)。";
		const result = validateReportSectionProse({ title: "估值方法框架", analysis }, 0);
		expect(result.issues).toEqual([
			expect.objectContaining({ field: "analysis", code: "citation", excerpt: analysis }),
		]);
		expect(result.issues[0].repair).toContain("fact_ids");
	});

	it("omits metadata commentary before validation without leaking fragments of decimal values", () => {
		const result = validateReportSectionProse(
			{
				title: "估值方法框架",
				analysis: "参考价 43.30 的币种未确认。2025 年估值日期未确认。品牌定价能力影响模型假设。",
			},
			0,
		);
		expect(result.issues).toEqual([]);
		expect(result.analysis).toBe("品牌定价能力影响模型假设。");
	});
});
