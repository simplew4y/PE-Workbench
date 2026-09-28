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

	it.each([
		"O107=ROUND(X6,0) 使目标倍数出现分段效应。",
		"该结论来自 TP!T6 传播路径与 run 输出。",
		"工具结果显示 cell_ref 为 B4。",
	])("keeps workbook coordinates, formulas and runtime terms out of reader-facing prose: %s", (analysis) => {
		const result = validateReportSectionProse({ title: "估值机制", analysis }, 0);
		expect(result.issues).toEqual([
			expect.objectContaining({ field: "analysis", code: "implementation_detail", excerpt: analysis }),
		]);
		expect(result.issues[0].repair).toContain("业务名称");
	});

	it.each(["Q1需求仍是关键变量。", "H1盈利取决于销量假设。"])(
		"does not mistake reporting periods for workbook implementation details: %s",
		(analysis) => {
			const result = validateReportSectionProse({ title: "经营假设", analysis }, 0);
			expect(result.issues.some((issue) => issue.code === "implementation_detail")).toBe(false);
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

	it.each([
		"收入单位未知，无法验证增长情景。",
		"上游情景未重算，当前只交付价格条件对照。",
		"股数尺度未明确，所需跨期传播结果尚未核实。",
		"缺失来源材料，不能据此判断经营变化。",
	])("preserves qualitative coverage gaps when requested: %s", (analysis) => {
		const result = validateReportSectionProse({ title: "范围与缺口", analysis }, 0, { preserveGaps: true });
		expect(result.issues).toEqual([]);
		expect(result.analysis).toBe(analysis);
	});

	it("preserves separate gaps alongside the supported qualitative explanation", () => {
		const result = validateReportSectionProse(
			{
				title: "条件与范围",
				analysis: "收入单位未知，无法验证增长情景；其余内容仅为价格条件对照。",
			},
			0,
			{ preserveGaps: true },
		);
		expect(result.issues).toEqual([]);
		expect(result.analysis).toBe("收入单位未知，无法验证增长情景； 其余内容仅为价格条件对照。");
	});

	it.each([
		["收入为110元，但单位未确认。", "numeric_claim"],
		["EPS 为 3.50，来源未核实。", "numeric_claim"],
		["收入五百亿欧元，币种未确认。", "numeric_claim"],
		["来源未核实 [来源](#pe-source?evidence_id=source%3Afake)。", "citation"],
		["未核实的来源为 https://example.com/price 。", "citation"],
		["收入增长，但单位未知。", "financial_trend"],
		["利润已经下降，缺失其他资料。", "financial_trend"],
	])("does not allow unsupported claims hidden in a preserved gap: %s", (analysis, code) => {
		const result = validateReportSectionProse({ title: "范围与缺口", analysis }, 3, { preserveGaps: true });
		expect(result.analysis).toBe(analysis);
		expect(result.issues).toEqual([
			expect.objectContaining({ section_index: 3, field: "analysis", code, excerpt: analysis }),
		]);
	});

	it("keeps the previous filtering when preserveGaps is explicitly disabled", () => {
		const section = { title: "估值方法框架", analysis: "参考价 43.30 的币种未确认。品牌定价能力影响模型假设。" };
		expect(validateReportSectionProse(section, 0, { preserveGaps: false })).toEqual(
			validateReportSectionProse(section, 0),
		);
	});
});
