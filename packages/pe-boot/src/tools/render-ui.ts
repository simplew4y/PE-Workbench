import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	type ExtendedComponent,
	extendedKinds,
	extendedSchemas,
	parseExtendedComponent,
} from "./extended-ui-contract.ts";

const shortText = (description: string) => Type.String({ description, minLength: 1, maxLength: 500 });
const labelValue = Type.Object({
	label: shortText("Concise metric label."),
	value: shortText("Display-ready value including its unit when relevant."),
	tone: Type.Optional(Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("neutral")])),
});

const companyOverview = Type.Object({
	kind: Type.Literal("company_overview"),
	name: shortText("Company name."),
	subtitle: Type.Optional(shortText("Ticker, reporting period, or short identity line.")),
	description: Type.Optional(shortText("One-sentence company description.")),
	metrics: Type.Array(labelValue, { minItems: 3, maxItems: 8 }),
});

const financialTrend = Type.Object({
	kind: Type.Literal("financial_trend"),
	title: shortText("Editorial title that states the important pattern, not a generic chart label."),
	chart: Type.Union([Type.Literal("line"), Type.Literal("bar"), Type.Literal("pie")]),
	categories: Type.Array(shortText("Period or category label."), { minItems: 2, maxItems: 20 }),
	series: Type.Array(
		Type.Object({
			name: shortText("Series name."),
			values: Type.Array(Type.Number(), { minItems: 2, maxItems: 20 }),
			unit: Type.Optional(shortText("Unit shared by this series.")),
		}),
		{ minItems: 1, maxItems: 4 },
	),
	insight: Type.Optional(shortText("One concise interpretation of the visible pattern.")),
});

const metricComparison = Type.Object({
	kind: Type.Literal("metric_comparison"),
	title: shortText("Editorial comparison title."),
	columns: Type.Array(shortText("Comparison column heading."), { minItems: 2, maxItems: 8 }),
	rows: Type.Array(
		Type.Object({
			label: shortText("Metric or comparison dimension."),
			values: Type.Array(Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Null()]), {
				minItems: 2,
				maxItems: 8,
			}),
			highlight: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })),
		}),
		{ minItems: 1, maxItems: 20 },
	),
	insight: Type.Optional(shortText("Most decision-relevant comparison conclusion.")),
});

const researchTimeline = Type.Object({
	kind: Type.Literal("research_timeline"),
	title: shortText("Editorial timeline title."),
	events: Type.Array(
		Type.Object({
			date: shortText("Date, period, or ordered stage."),
			title: shortText("Event title."),
			description: Type.Optional(shortText("Why the event matters.")),
		}),
		{ minItems: 3, maxItems: 20 },
	),
});

const insightCallout = Type.Object({
	kind: Type.Literal("insight_callout"),
	tone: Type.Union([Type.Literal("positive"), Type.Literal("risk"), Type.Literal("watch"), Type.Literal("neutral")]),
	title: shortText("A specific investment-research takeaway."),
	body: shortText("Short explanation of why this takeaway matters."),
	evidence: Type.Optional(
		Type.Array(shortText("Compact supporting fact already established in the answer."), { maxItems: 4 }),
	),
});

const sourceCollection = Type.Object({
	kind: Type.Literal("source_collection"),
	title: Type.Optional(shortText("Specific source collection title.")),
	sources: Type.Array(
		Type.Union([
			Type.Object({
				title: shortText("Human-readable source title."),
				url: Type.String({ pattern: "^https?://", maxLength: 2_000 }),
				description: Type.Optional(shortText("Why this source is useful.")),
			}),
			Type.Object({
				title: shortText("Human-readable source title."),
				filePath: Type.String({ minLength: 1, maxLength: 2_000 }),
				description: Type.Optional(shortText("Why this source is useful.")),
			}),
		]),
		{ minItems: 1, maxItems: 20 },
	),
});

const relationshipMap = Type.Object({
	kind: Type.Literal("relationship_map"),
	title: shortText("Editorial relationship title."),
	nodes: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
			label: shortText("Visible node label."),
			group: Type.Optional(shortText("Optional grouping label.")),
		}),
		{ minItems: 2, maxItems: 16 },
	),
	edges: Type.Array(
		Type.Object({
			from: Type.String({ minLength: 1, maxLength: 80 }),
			to: Type.String({ minLength: 1, maxLength: 80 }),
			label: Type.Optional(shortText("Visible relationship label.")),
		}),
		{ minItems: 1, maxItems: 24 },
	),
});

const kpiStrip = Type.Object({
	kind: Type.Literal("kpi_strip"),
	title: Type.Optional(shortText("Optional editorial title for the metric group.")),
	metrics: Type.Array(
		Type.Object({
			label: shortText("Concise metric label."),
			value: shortText("Display-ready value including its unit."),
			delta: Type.Optional(shortText("Compact change or benchmark, such as +12.4% YoY.")),
			tone: Type.Optional(Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("neutral")])),
		}),
		{ minItems: 2, maxItems: 6 },
	),
});

const waterfallChart = Type.Object({
	kind: Type.Literal("waterfall_chart"),
	title: shortText("Editorial title describing the value bridge."),
	categories: Type.Array(shortText("Bridge item label."), { minItems: 2, maxItems: 12 }),
	values: Type.Array(Type.Number(), { minItems: 2, maxItems: 12 }),
	unit: Type.Optional(shortText("Unit shared by all values.")),
	insight: Type.Optional(shortText("Concise interpretation of the largest drivers.")),
});

const riskMatrix = Type.Object({
	kind: Type.Literal("risk_matrix"),
	title: shortText("Editorial risk assessment title."),
	risks: Type.Array(
		Type.Object({
			name: shortText("Risk name."),
			likelihood: Type.Integer({ minimum: 1, maximum: 5 }),
			impact: Type.Integer({ minimum: 1, maximum: 5 }),
			description: Type.Optional(shortText("Why the risk matters or what triggers it.")),
		}),
		{ minItems: 2, maxItems: 12 },
	),
	insight: Type.Optional(shortText("Concise risk prioritization conclusion.")),
});

const segmentBreakdown = Type.Object({
	kind: Type.Literal("segment_breakdown"),
	title: shortText("Editorial title describing the business mix."),
	segments: Type.Array(
		Type.Object({
			name: shortText("Segment name."),
			value: Type.Number({ minimum: 0 }),
			unit: Type.Optional(shortText("Value unit.")),
			change: Type.Optional(shortText("Compact change versus the comparison period.")),
		}),
		{ minItems: 2, maxItems: 12 },
	),
	insight: Type.Optional(shortText("Concise interpretation of concentration or mix shift.")),
});

const valuationRange = Type.Object({
	kind: Type.Literal("valuation_range"),
	title: shortText("Editorial valuation conclusion."),
	unit: shortText("Currency and scale, such as HKD/share or RMB bn."),
	current: Type.Optional(Type.Number({ description: "Current price or reference value on the same basis." })),
	scenarios: Type.Array(
		Type.Object({
			label: shortText("Scenario label such as Bear, Base, or Bull."),
			low: Type.Number({ description: "Low end of this scenario range." }),
			high: Type.Number({ description: "High end of this scenario range." }),
			tone: Type.Optional(Type.Union([Type.Literal("downside"), Type.Literal("neutral"), Type.Literal("upside")])),
			rationale: Type.Optional(shortText("Verified assumption or compact scenario rationale.")),
		}),
		{ minItems: 2, maxItems: 5 },
	),
	insight: Type.Optional(shortText("Concise interpretation of valuation asymmetry.")),
});

const peerQuadrant = Type.Object({
	kind: Type.Literal("peer_quadrant"),
	title: shortText("Editorial peer-positioning title."),
	xAxis: Type.Object({
		label: shortText("Horizontal comparison dimension."),
		unit: Type.Optional(shortText("Axis unit.")),
	}),
	yAxis: Type.Object({
		label: shortText("Vertical comparison dimension."),
		unit: Type.Optional(shortText("Axis unit.")),
	}),
	peers: Type.Array(
		Type.Object({
			name: shortText("Company or peer name."),
			x: Type.Number(),
			y: Type.Number(),
			highlight: Type.Optional(Type.Boolean()),
			description: Type.Optional(shortText("Why this peer position matters.")),
		}),
		{ minItems: 3, maxItems: 12 },
	),
	insight: Type.Optional(shortText("Concise peer-positioning conclusion.")),
});

const catalystCalendar = Type.Object({
	kind: Type.Literal("catalyst_calendar"),
	title: shortText("Editorial catalyst or watch-calendar title."),
	events: Type.Array(
		Type.Object({
			date: shortText("Expected date, month, quarter, or monitoring window."),
			title: shortText("Catalyst or event title."),
			impact: Type.Union([
				Type.Literal("positive"),
				Type.Literal("negative"),
				Type.Literal("mixed"),
				Type.Literal("neutral"),
			]),
			confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
			description: Type.Optional(shortText("Expected transmission path or what to monitor.")),
		}),
		{ minItems: 2, maxItems: 12 },
	),
});

const leafComponent = Type.Union([
	Type.Unsafe<ExtendedComponent>({ anyOf: extendedSchemas }),
	companyOverview,
	financialTrend,
	metricComparison,
	researchTimeline,
	insightCallout,
	sourceCollection,
	relationshipMap,
	kpiStrip,
	waterfallChart,
	riskMatrix,
	segmentBreakdown,
	valuationRange,
	peerQuadrant,
	catalystCalendar,
]);

const researchBrief = Type.Object({
	kind: Type.Literal("research_brief"),
	title: shortText("Decision-oriented title for the whole brief."),
	thesis: shortText("One concise thesis that connects the evidence blocks."),
	blocks: Type.Array(leafComponent, { minItems: 2, maxItems: 4 }),
});

export const PE_RENDER_UI_PROMPT_SNIPPET =
	"Render verified data only when a visual materially improves comprehension over prose or a small Markdown table. No UI quota: complex questions can remain prose. Default inline/minimal/static; interaction is optional and task-driven. Use research_brief only for an explicitly requested visual brief or dashboard, with 2-4 complementary blocks. Never duplicate the surface in prose or invent data to fill a component.";

export const peRenderUiParameters = Type.Object({
	version: Type.Literal(1),
	presentation: Type.Optional(
		Type.Object({
			placement: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("standalone")])),
			treatment: Type.Optional(
				Type.Union([
					Type.Literal("minimal"),
					Type.Literal("divider"),
					Type.Literal("soft"),
					Type.Literal("card"),
					Type.Literal("paper"),
					Type.Literal("glass"),
					Type.Literal("outline"),
					Type.Literal("spotlight"),
				]),
			),
			density: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("comfortable")])),
			theme: Type.Optional(
				Type.Union([
					Type.Literal("neutral"),
					Type.Literal("cool"),
					Type.Literal("warm"),
					Type.Literal("ink"),
					Type.Literal("lagoon"),
					Type.Literal("orchid"),
					Type.Literal("forest"),
					Type.Literal("ember"),
					Type.Literal("berry"),
					Type.Literal("cobalt"),
					Type.Literal("gold"),
					Type.Literal("slate"),
				]),
			),
			palette: Type.Optional(
				Type.Object({
					accent: Type.String({
						pattern: "^#[0-9a-fA-F]{6}$",
						description:
							"AI-selected six-digit hex accent. Select a coherent color for the subject, not always neutral.",
					}),
					series: Type.Array(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }), {
						minItems: 2,
						maxItems: 5,
						description:
							"AI-composed distinct categorical colors. Frontend adjusts contrast; semantic risk and citation colors remain fixed.",
					}),
				}),
			),
			interaction: Type.Optional(Type.Union([Type.Literal("static"), Type.Literal("explore")])),
		}),
	),
	surface_id: Type.Optional(
		Type.String({ description: "Stable ID for this UI surface within the answer.", minLength: 1, maxLength: 80 }),
	),
	component: Type.Union([leafComponent, researchBrief]),
});

type RenderUiParams = Static<typeof peRenderUiParameters>;

export function validateRenderUiParams(params: RenderUiParams): void {
	const component = params.component;
	if (component.kind === "research_brief") {
		for (const block of component.blocks) validateComponent(block);
		return;
	}
	validateComponent(component);
}

function validateComponent(component: Static<typeof leafComponent>): void {
	if (extendedKinds.includes(component.kind)) parseExtendedComponent(component);
	if (component.kind === "financial_trend") {
		if (component.series.some((series) => series.values.length !== component.categories.length)) {
			throw new Error("Every financial_trend series must align with categories");
		}
		if (
			component.chart === "pie" &&
			(component.series.length !== 1 || component.series[0].values.some((value) => value < 0))
		) {
			throw new Error("A pie financial_trend requires one non-negative series");
		}
	}
	if (component.kind === "metric_comparison") {
		if (component.rows.some((row) => row.values.length !== component.columns.length)) {
			throw new Error("Every metric_comparison row must align with columns");
		}
		if (component.rows.some((row) => row.highlight !== undefined && row.highlight >= component.columns.length)) {
			throw new Error("metric_comparison highlight must identify an existing column");
		}
	}
	if (component.kind === "relationship_map") {
		const nodeIds = new Set(component.nodes.map((node) => node.id));
		if (nodeIds.size !== component.nodes.length) throw new Error("relationship_map node IDs must be unique");
		if (component.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) {
			throw new Error("Every relationship_map edge must reference existing nodes");
		}
	}
	if (component.kind === "waterfall_chart" && component.values.length !== component.categories.length) {
		throw new Error("waterfall_chart values must align with categories");
	}
	if (component.kind === "valuation_range" && component.scenarios.some((scenario) => scenario.low > scenario.high)) {
		throw new Error("valuation_range scenario low must not exceed high");
	}
	if (component.kind === "peer_quadrant") {
		const names = new Set(component.peers.map((peer) => peer.name));
		if (names.size !== component.peers.length) throw new Error("peer_quadrant peer names must be unique");
	}
}

export const peRenderUiTool = defineTool({
	name: "pe_render_ui",
	label: "PE Generative UI",
	description: PE_RENDER_UI_PROMPT_SNIPPET,
	promptSnippet: PE_RENDER_UI_PROMPT_SNIPPET,
	parameters: peRenderUiParameters,
	async execute(_toolCallId, params, signal) {
		signal?.throwIfAborted();
		validateRenderUiParams(params);
		const result = {
			rendered: true,
			version: params.version,
			presentation: params.presentation,
			surface_id: params.surface_id,
			component: params.component,
		};
		return {
			content: [{ type: "text", text: JSON.stringify({ rendered: true, kind: params.component.kind }) }],
			details: result,
		};
	},
});
