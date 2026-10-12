import { expect, it } from "vitest";
import {
	assertInformationSourceConfig,
	informationSourceConfig,
	renderWindFinancials,
} from "../src/information-source-model.ts";

it("uses explicit same-field metadata and preserves its raw paths", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "日期" },
							{ name: "营业利润" },
							{ name: "营业利润.单位" },
							{ name: "营业利润.币种" },
							{ name: "营业利润.期间类型" },
							{ name: "营业利润.业务口径" },
							{ name: "营业利润.数据角色" },
							{ name: "营业利润.指标定义" },
							{ name: "归母净利润", unit: "亿元" },
						],
						rows: [
							[
								"9660.HK",
								"Q4 FY2025",
								-3,
								"亿元",
								"CNY",
								"全年累计",
								"合并报表",
								"实际",
								"会计营业利润，不等同于调整后EBIT",
								-4,
							],
						],
					}),
				},
			],
		},
		"9660.HK",
	);
	expect(view.facts[0]).toMatchObject({
		unit: "亿元",
		currency: "CNY",
		period: "Q4 FY2025",
		periodKind: "cumulative",
		scope: "合并报表",
		role: "fact",
		definition: "会计营业利润，不等同于调整后EBIT",
	});
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][8]");
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][4]");
	expect(view.text).toContain("指标定义：会计营业利润，不等同于调整后EBIT");
	expect(view.facts[1]).toMatchObject({ currency: null, role: null, scope: null, periodKind: "unknown" });
	expect(view.gaps.some((gap) => gap.startsWith("营业利润 "))).toBe(false);
});

it("does not borrow another metric's definitions or trust query-like declarations", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "实际营业收入", unit: "亿元" },
							{ name: "营业利润.币种" },
							{ name: "营业利润.业务口径" },
						],
						rows: [["9660.HK", 9, "CNY", "合并报表"]],
					}),
				},
			],
		},
		"9660.HK",
	);
	expect(view.facts[0]).toMatchObject({ currency: null, scope: null, period: null });
	expect(view.gaps.join()).toContain("未明确记账币种");
});

it("fixes the new query policy while keeping existing pending review configurations readable", () => {
	const config = informationSourceConfig("地平线", "9660.HK", ["wind-financials"]);
	expect(config.queryPolicy).toBe("judgment-definitions-v1");
	expect(() => assertInformationSourceConfig(config)).not.toThrow();
	expect(() =>
		assertInformationSourceConfig({ ...config, version: "7", viewVersion: "6", queryPolicy: undefined }),
	).not.toThrow();
	expect(() => assertInformationSourceConfig({ ...config, viewVersion: "6" })).toThrow("版本已变化");
});
