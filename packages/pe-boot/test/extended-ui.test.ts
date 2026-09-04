import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { type ExtendedComponent, extendedSchemas, parseExtendedComponent } from "../src/tools/extended-ui-contract.ts";
import { peRenderUiParameters, validateRenderUiParams } from "../src/tools/render-ui.ts";

const samples: ExtendedComponent[] = [
	{
		kind: "image_gallery",
		title: "资料图片",
		layout: "carousel",
		images: [
			{ title: "原图A", src: "/tmp/chart.png", caption: "原始图表" },
			{ title: "原图B", src: "/tmp/chart2.png" },
		],
	},
	{
		kind: "entity_cards",
		title: "业务实体",
		layout: "carousel",
		entities: [
			{ name: "A", category: "产品", description: "合成测试数据", facts: [{ label: "定位", value: "高端" }] },
			{ name: "B", category: "产品", description: "合成测试数据", facts: [] },
		],
	},
	{
		kind: "place_map",
		title: "地点分布",
		places: [
			{ name: "上海", latitude: 31.23, longitude: 121.47, description: "合成测试地点" },
			{ name: "北京", latitude: 39.9, longitude: 116.4, description: "合成测试地点" },
		],
	},
	{
		kind: "scenario_calculator",
		title: "估值测算",
		description: "仅为合成假设，EPS乘以PE",
		operation: "product",
		resultLabel: "理论价格",
		resultUnit: "元",
		inputs: [
			{ id: "eps", label: "每股收益", min: 1, max: 10, step: 0.1, value: 6, unit: "元" },
			{ id: "pe", label: "市盈率", min: 5, max: 30, step: 1, value: 12, unit: "倍" },
		],
	},
	{
		kind: "sankey_chart",
		title: "资金流向",
		unit: "亿元",
		nodes: ["收入", "成本", "利润"],
		links: [
			{ source: "收入", target: "成本", value: 70 },
			{ source: "收入", target: "利润", value: 30 },
		],
	},
	{
		kind: "radar_chart",
		title: "多维对比",
		indicators: [
			{ name: "维度A", max: 100 },
			{ name: "维度B", max: 100 },
			{ name: "维度C", max: 100 },
		],
		series: [
			{ name: "方案A", values: [70, 50, 80] },
			{ name: "方案B", values: [50, 80, 60] },
		],
	},
	{
		kind: "candlestick_chart",
		title: "行情示例",
		unit: "元",
		candles: [
			{ date: "2026-01-01", open: 10, close: 12, low: 9, high: 13 },
			{ date: "2026-01-02", open: 12, close: 11, low: 10, high: 14 },
		],
	},
];
describe("extended UI tool integration", () => {
	for (const component of samples)
		it(`${component.kind} is advertised and validated`, () => {
			expect(Value.Check(peRenderUiParameters, { version: 1, component })).toBe(true);
			expect(() => validateRenderUiParams({ version: 1, component })).not.toThrow();
			expect(() =>
				validateRenderUiParams({
					version: 1,
					component: {
						kind: "research_brief",
						title: "Brief",
						thesis: "Evidence",
						blocks: [component, samples[3]],
					},
				}),
			).not.toThrow();
		});
	it("rejects scripts, extra options and invalid graph semantics", () => {
		expect(Value.Check(Type.Unsafe({ anyOf: extendedSchemas }), { ...samples[0], script: "alert(1)" })).toBe(false);
		expect(() =>
			parseExtendedComponent({
				kind: "sankey_chart",
				title: "bad",
				unit: "x",
				nodes: ["a", "b"],
				links: [
					{ source: "a", target: "b", value: 1 },
					{ source: "b", target: "a", value: 2 },
				],
			}),
		).toThrow();
	});
});
