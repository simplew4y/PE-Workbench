import { describe, expect, it } from "vitest";
import { quantity, resolveSourceQuantity } from "../src/workbook-units.ts";

describe("canonical workbook quantities", () => {
	it("normalizes RMB to CNY without changing storage scale", () => {
		expect(quantity("RMBm")).toEqual(quantity("CNYm"));
		expect(quantity("RMB/share")).toEqual(quantity("CNY/share"));
		expect(quantity("EUR_100m")).toEqual({ dimension: "EUR", scale: 1e8, label: "亿EUR" });
		expect(quantity("CNY_10k")).toEqual({ dimension: "CNY", scale: 1e4, label: "万CNY" });
	});
});

describe("units derived from original workbook context", () => {
	it.each([
		["EURm", "EURm"],
		["Units: USD billion", "USDbn"],
		["HKD bn", "HKDbn"],
		["GBP k", "GBPk"],
		["JPY million", "JPYm"],
		["CNY元", "CNY"],
		["人民币万元", "CNY_10k"],
		["人民币百万元", "CNYm"],
		["人民币（百万元）", "CNYm"],
		["人民币亿元", "CNY_100m"],
		["RMB million", "CNYm"],
		["million USD", "USDm"],
		["百万股", "shares_m"],
		["shares million", "shares_m"],
		["shares_m", "shares_m"],
		["股", "shares"],
		["CNY/share", "CNY/share"],
		["RMB per share", "CNY/share"],
		["%", "%"],
		["倍", "x"],
	])("parses explicit source %s", (text, expectedUnit) => {
		expect(resolveSourceQuantity({ text, expectedUnit })).toEqual(quantity(expectedUnit));
	});

	it.each(["EURm", "CNY", "CNYbn", "CNY/share"])(
		"rejects an asserted unit %s inconsistent with the source",
		(expectedUnit) => {
			expect(() => resolveSourceQuantity({ text: "CNY million", expectedUnit })).toThrow(/conflicts/u);
		},
	);

	it.each(["", "General", "百万元", "元/股", "millions", "currency units"])(
		"does not infer missing currency or scale from expectedUnit for %s",
		(text) => {
			expect(() => resolveSourceQuantity({ text, expectedUnit: "CNYm" })).toThrow();
		},
	);

	it.each(["CNY", "CNYm"])("rejects same-dimension conflicts regardless of expected unit %s", (expectedUnit) => {
		expect(() => resolveSourceQuantity({ text: "CNY million; CNY", expectedUnit, metricLabel: "Revenue" })).toThrow(
			/ambiguous/u,
		);
	});

	it.each(["CNY mn", "CNY 100 MILLION", "CNY trillion", "CNY; CHF"])(
		"does not reduce unsupported scale or currency evidence to a bare currency: %s",
		(text) => {
			expect(() => resolveSourceQuantity({ text, expectedUnit: "CNY" })).toThrow();
		},
	);

	it("resolves explicitly separated compound-header units by the verified metric label", () => {
		const text = "Synthetic model: CNY million; shares million; price CNY/share";
		for (const [metricLabel, expectedUnit] of [
			["Revenue", "CNYm"],
			["Net income", "CNYm"],
			["Weighted Average Shares (Fully Diluted)", "shares_m"],
			["EPS", "CNY/share"],
			["Target price", "CNY/share"],
		])
			expect(resolveSourceQuantity({ text, expectedUnit, metricLabel })).toEqual(quantity(expectedUnit));
		expect(() => resolveSourceQuantity({ text, expectedUnit: "CNYm", metricLabel: "EPS" })).toThrow(/conflicts/u);
		expect(() => resolveSourceQuantity({ text, expectedUnit: "CNYm" })).toThrow(/ambiguous/u);
	});

	it("does not apply an aggregate monetary unit to EPS or shares", () => {
		for (const metricLabel of ["EPS", "Diluted shares"])
			expect(() => resolveSourceQuantity({ text: "CNY million", expectedUnit: "CNYm", metricLabel })).toThrow();
	});

	it("does not use a per-share unit for aggregate revenue even when expectedUnit requests it", () => {
		expect(() =>
			resolveSourceQuantity({ text: "CNY/share", expectedUnit: "CNY/share", metricLabel: "Revenue" }),
		).toThrow();
	});

	it("does not turn a capital amount or market-share ratio into a share count based on a label substring", () => {
		for (const metricLabel of ["Share capital", "股本"])
			expect(resolveSourceQuantity({ text: "CNY million", expectedUnit: "CNYm", metricLabel })).toEqual(
				quantity("CNYm"),
			);
		expect(resolveSourceQuantity({ text: "%", expectedUnit: "%", metricLabel: "Market share" })).toEqual(
			quantity("%"),
		);
	});

	it("requires currency evidence in the supplied source rather than a currency asserted from another cell", () => {
		expect(() =>
			resolveSourceQuantity({ text: "金额单位：百万元", expectedUnit: "CNYm", metricLabel: "Revenue" }),
		).toThrow();
	});

	it("preserves explicit unknown units without inventing conversion factors", () => {
		for (const [text, known] of [
			["per_share", "CNY/share"],
			["share_count_unspecified_scale", "shares_m"],
		]) {
			expect(resolveSourceQuantity({ text, expectedUnit: text })).toEqual(quantity(text));
			expect(() => resolveSourceQuantity({ text, expectedUnit: known })).toThrow(/conflicts/u);
		}
		expect(() => resolveSourceQuantity({ text: "shares", expectedUnit: "share_count_unspecified_scale" })).toThrow();
		expect(() => resolveSourceQuantity({ text: "EPS", expectedUnit: "per_share" })).toThrow();
		expect(resolveSourceQuantity({ text: "per share (currency unspecified)", expectedUnit: "per_share" })).toEqual(
			quantity("per_share"),
		);
		expect(
			resolveSourceQuantity({ text: "shares (scale unknown)", expectedUnit: "share_count_unspecified_scale" }),
		).toEqual(quantity("share_count_unspecified_scale"));
	});
});

describe("number format unit evidence", () => {
	it.each(["General", "0.00", "#,##0.00", '0.00"元"', '0.00"百万元"'])(
		"keeps unsupported storage units unknown for %s",
		(text) => {
			expect(() => resolveSourceQuantity({ text, field: "number_format", expectedUnit: "CNYm" })).toThrow();
		},
	);

	it.each([
		['0.00"CNY million"', "CNYm"],
		['#,##0.00"USD"', "USD"],
		['0.00"CNY/share"', "CNY/share"],
		['"EUR"0.00"/share"', "EUR/share"],
		['[$EUR-407]0.00"/share"', "EUR/share"],
		["[$EUR-407] #,##0.00", "EUR"],
		["0.00%", "%"],
	])("accepts explicit format unit %s", (text, expectedUnit) => {
		expect(resolveSourceQuantity({ text, field: "number_format", expectedUnit })).toEqual(quantity(expectedUnit));
	});

	it.each([
		['0.00"EUR/share"', "EUR/share", "Diluted EPS"],
		["0.00%", "%", "Tax rate"],
		["0.00%", "%", "Gross margin"],
	])("uses explicit numeric-cell format %s with the verified metric label", (text, expectedUnit, metricLabel) => {
		expect(resolveSourceQuantity({ text, field: "number_format", expectedUnit, metricLabel })).toEqual(
			quantity(expectedUnit),
		);
	});

	it("rejects display scaling rather than using it to guess the raw storage multiplier", () => {
		for (const expectedUnit of ["CNY", "CNYm"])
			expect(() =>
				resolveSourceQuantity({ text: '#,##0,,"CNY million"', field: "number_format", expectedUnit }),
			).toThrow(/storage/u);
	});
});
