import { describe, expect, it } from "vitest";
import { validateRenderUiParams } from "../src/tools/render-ui.ts";

describe("PE generative UI tool", () => {
	it("accepts an aligned financial trend", () => {
		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "financial_trend",
					title: "利润在 2025 年发生反转",
					chart: "line",
					categories: ["2024", "2025"],
					series: [{ name: "归母净利润", values: [402.54, 326.19], unit: "亿元" }],
				},
			}),
		).not.toThrow();
	});

	it("rejects semantically invalid chart and relationship data", () => {
		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "financial_trend",
					title: "Invalid",
					chart: "line",
					categories: ["2024", "2025"],
					series: [{ name: "Revenue", values: [1] }],
				},
			}),
		).toThrow(/align/);

		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "relationship_map",
					title: "Invalid",
					nodes: [
						{ id: "parent", label: "Parent" },
						{ id: "child", label: "Child" },
					],
					edges: [{ from: "parent", to: "missing" }],
				},
			}),
		).toThrow(/existing nodes/);
	});

	it("accepts a composed research brief and validates its blocks", () => {
		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "research_brief",
					title: "Growth quality is under pressure",
					thesis: "Revenue still grows while profit and cash generation weaken.",
					blocks: [
						{
							kind: "kpi_strip",
							metrics: [
								{ label: "Revenue", value: "803.9bn", delta: "+3.46%", tone: "positive" },
								{ label: "Profit", value: "32.6bn", delta: "-18.97%", tone: "negative" },
							],
						},
						{
							kind: "risk_matrix",
							title: "Risk priority",
							risks: [
								{ name: "Price competition", likelihood: 5, impact: 4 },
								{ name: "Overseas execution", likelihood: 3, impact: 3 },
							],
						},
					],
				},
			}),
		).not.toThrow();

		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: { kind: "waterfall_chart", title: "Invalid bridge", categories: ["A", "B"], values: [1] },
			}),
		).toThrow(/align/);
	});

	it("validates valuation ranges and peer identity", () => {
		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "valuation_range",
					title: "Invalid",
					unit: "RMB/share",
					scenarios: [
						{ label: "Bear", low: 90, high: 80 },
						{ label: "Base", low: 100, high: 120 },
					],
				},
			}),
		).toThrow(/low/);
		expect(() =>
			validateRenderUiParams({
				version: 1,
				component: {
					kind: "peer_quadrant",
					title: "Invalid",
					xAxis: { label: "Growth" },
					yAxis: { label: "ROE" },
					peers: [
						{ name: "A", x: 1, y: 2 },
						{ name: "A", x: 2, y: 3 },
						{ name: "B", x: 3, y: 4 },
					],
				},
			}),
		).toThrow(/unique/);
	});
});
