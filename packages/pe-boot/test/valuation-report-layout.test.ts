import { describe, expect, it } from "vitest";
import { compactReportCitations, valuationOverviewLayout } from "../src/tools/valuation-report-layout.ts";

describe("readable selected valuation overview", () => {
	it("renders selected methods and periods without exposing formulas or inferring weights", () => {
		const result = valuationOverviewLayout([
			{ sheet: "Valuation", label: "合理价值", method: "P/E", period: "2026E", value: "50.60 EUR/股" },
			{ sheet: "Valuation", label: "合理价值", method: "EV/EBIT", period: "2026E", value: "57.20 EUR/股" },
			{
				sheet: "Valuation",
				label: "综合目标价",
				period: "2026E",
				value: "53.90 EUR/股",
				formula: "=ROUND((K9+K21)/2,2)",
			},
		]);
		const text = result.lines.join("\n");
		expect(result.outputCount).toBe(3);
		expect(text).toContain("| P/E · 合理价值 | 2026E | 50.60 EUR/股 |");
		expect(text).toContain("| EV/EBIT · 合理价值 | 2026E | 57.20 EUR/股 |");
		expect(text).not.toContain("ROUND");
		expect(text).not.toContain("K9");
		expect(text).not.toContain("50%");
	});

	it("places only explicitly historical periods in the appendix", () => {
		const result = valuationOverviewLayout([
			{ sheet: "Model", label: "Old", period: "2018", periodKind: "historical", value: "51.30" },
			{ sheet: "Model", label: "Unclassified", period: "2019", value: "52.40" },
			{ sheet: "Model", label: "Forecast", period: "2027E", periodKind: "forecast", value: "57.60" },
		]);
		expect(result.lines.join("\n")).not.toContain("51.30");
		expect(result.lines.join("\n")).toContain("2019");
		expect(result.appendix.join("\n")).toContain("51.30");
		expect(result.appendix.join("\n")).not.toContain("52.40");
	});

	it("retains duplicate and unknown periods without borrowing currency or method labels", () => {
		const result = valuationOverviewLayout([
			{ sheet: "Model", label: "A", period: "2026E", value: "50.60" },
			{ sheet: "Model", label: "B", period: "2026E", value: "57.20" },
			{ sheet: "Other", label: "Unknown", value: "62.00" },
		]);
		const text = result.lines.join("\n");
		expect(text).toContain("| A | 2026E | 50.60 |");
		expect(text).toContain("| B | 2026E | 57.20 |");
		expect(text).toContain("| Unknown |  | 62.00 |");
		expect(text).not.toMatch(/EUR|P\/E|EV\/EBIT/u);
	});

	it("shortens only citation labels and preserves the exact version-bound source URL", () => {
		const citation = "[a\\[b\\] long file.xlsx Valuation!K23](#pe-source?evidence_id=source%3Ax%2520y&v=2)";
		expect(compactReportCitations(citation)).toBe("[来源](#pe-source?evidence_id=source%3Ax%2520y&v=2)");
		expect(compactReportCitations("[ordinary](https://example.com/a)")).toBe("[ordinary](https://example.com/a)");
	});
});
