import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { getPeExcelRange } from "./excel-range.ts";
import {
	type FormulaTraceNode,
	formulaTraceIsStructurallyComplete,
	type PeFormulaTraceResult,
	tracePeFormula,
} from "./formula-trace.ts";

const DEFAULT_TOP_K = 25;
const MAX_TOP_K = 100;

export const PE_DRIVER_DISCOVER_PROMPT_SNIPPET =
	"Discover structurally connected assumption candidates upstream of one selected valuation output; classify but never claim sensitivity or active-driver status without recalculation";

export type PeDriverRole =
	| "valuation_assumption"
	| "operating_assumption"
	| "scenario_selector"
	| "forecast_input"
	| "hardcoded_input"
	| "historical_actual"
	| "display_or_text";

export type PeDriverEpistemicStatus = "actual" | "estimate" | "unknown";

export interface PeDriverCandidate {
	driver_id: string;
	discovery_rank: number;
	role: PeDriverRole;
	epistemic_status: PeDriverEpistemicStatus;
	report_tier: "candidate" | "context" | "exclude";
	dependency_status: "structurally_connected";
	activation_status: "not_tested";
	sensitivity_status: "not_run";
	sheet_name: string;
	cell_ref: string;
	label: string;
	baseline_value?: number | string;
	period?: string;
	unit?: string;
	depth: number;
	dependency_path: string[];
	evidence_id: string;
	markdown_citation: string;
	classification_reasons: string[];
}

export interface PeDriverDiscoverOptions {
	docId: string;
	outputSheet: string;
	outputCellRef: string;
	datasetId?: string;
	topK?: number;
}

export interface PeDriverDiscoverResult {
	schema_version: "1.0";
	dataset_id: string;
	doc_id: string;
	output: {
		output_id: string;
		sheet_name: string;
		cell_ref: string;
	};
	status: "discovered" | "incomplete" | "no_candidates";
	trace_complete: boolean;
	trace_issue_codes: string[];
	upstream_node_count: number;
	formula_intermediate_count: number;
	candidate_count: number;
	returned_candidate_count: number;
	sensitivity_ranking_available: false;
	candidates: PeDriverCandidate[];
	warnings: string[];
	answer_contract: string;
}

function normalize(value: string | undefined): string {
	return (value ?? "").normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();
}

function includesAny(value: string, markers: readonly string[]): boolean {
	return markers.some((marker) => value.includes(marker));
}

function isHistoricalPeriod(period: string): boolean {
	return (
		/^(?:fy\s*)?\d{2,4}\s*a$/u.test(period) ||
		includesAny(period, ["actual", "historical", "reported", "历史", "实际", "已披露"])
	);
}

function isForecastPeriod(period: string): boolean {
	return (
		/^(?:fy\s*)?\d{2,4}\s*[ef]$/u.test(period) ||
		includesAny(period, ["estimate", "forecast", "budget", "预测", "预计", "预算"])
	);
}

function classifyDriver(
	node: FormulaTraceNode,
	resolvedLabel?: string,
): {
	role: PeDriverRole;
	epistemicStatus: PeDriverEpistemicStatus;
	reportTier: PeDriverCandidate["report_tier"];
	reasons: string[];
} {
	const period = normalize(node.period ?? node.col_label);
	const text = normalize(
		[resolvedLabel, node.row_label, node.col_label, node.display_value, node.unit, node.number_format]
			.filter(Boolean)
			.join(" "),
	);
	if (isHistoricalPeriod(period)) {
		return {
			role: "historical_actual",
			epistemicStatus: "actual",
			reportTier: "context",
			reasons: [`Period '${node.period ?? node.col_label ?? ""}' is historical/actual`],
		};
	}
	if (
		includesAny(text, [
			"scenario",
			"case selector",
			"base case",
			"bull case",
			"bear case",
			"情景",
			"场景",
			"基准情形",
		])
	) {
		return {
			role: "scenario_selector",
			epistemicStatus: "estimate",
			reportTier: "candidate",
			reasons: ["Label or value indicates a scenario selector"],
		};
	}
	if (
		includesAny(text, [
			"wacc",
			"discount rate",
			"terminal growth",
			"perpetual growth",
			"exit multiple",
			"target p/e",
			"target pe",
			"ev/ebitda",
			"valuation multiple",
			"折现率",
			"永续增长",
			"退出倍数",
			"目标市盈率",
			"估值倍数",
		])
	) {
		return {
			role: "valuation_assumption",
			epistemicStatus: "estimate",
			reportTier: "candidate",
			reasons: ["Label indicates a valuation parameter"],
		};
	}
	if (
		includesAny(text, [
			"growth",
			"margin",
			"volume",
			"units",
			"asp",
			"price",
			"market share",
			"utilization",
			"tax rate",
			"capex",
			"working capital",
			"fx",
			"currency",
			"增速",
			"增长率",
			"利润率",
			"毛利率",
			"销量",
			"单价",
			"市场份额",
			"利用率",
			"税率",
			"资本开支",
			"营运资金",
			"汇率",
		])
	) {
		return {
			role: "operating_assumption",
			epistemicStatus: isForecastPeriod(period) ? "estimate" : "unknown",
			reportTier: "candidate",
			reasons: ["Label indicates an operating or financial driver"],
		};
	}
	if (isForecastPeriod(period)) {
		return {
			role: "forecast_input",
			epistemicStatus: "estimate",
			reportTier: "candidate",
			reasons: [`Period '${node.period ?? node.col_label ?? ""}' is forecast/estimate`],
		};
	}
	if (node.numeric_value !== undefined) {
		return {
			role: "hardcoded_input",
			epistemicStatus: "unknown",
			reportTier: "candidate",
			reasons: ["Non-formula numeric cell is structurally connected to the output"],
		};
	}
	return {
		role: "display_or_text",
		epistemicStatus: "unknown",
		reportTier: "exclude",
		reasons: ["Text/display cell has no independently testable numeric input"],
	};
}

function driverId(docId: string, sheetName: string, cellRef: string): string {
	return `driver:${createHash("sha256").update(`${docId}\0${sheetName}\0${cellRef}`).digest("hex").slice(0, 24)}`;
}

function outputId(docId: string, sheetName: string, cellRef: string): string {
	return `output:${createHash("sha256").update(`${docId}\0${sheetName}\0${cellRef}`).digest("hex").slice(0, 24)}`;
}

function columnName(index: number): string {
	let value = index;
	let result = "";
	while (value > 0) {
		value -= 1;
		result = String.fromCharCode(65 + (value % 26)) + result;
		value = Math.floor(value / 26);
	}
	return result;
}

export function resolvePeDriverLabel(
	cwd: string,
	docId: string,
	datasetId: string | undefined,
	node: FormulaTraceNode,
	cache: Map<string, string | undefined>,
): string | undefined {
	for (const value of [node.row_label, node.col_label]) if (value?.trim()) return value.trim();
	const key = `${node.sheet_name}\0${node.row_index}\0${node.col_index}`;
	if (cache.has(key)) return cache.get(key);
	if (node.col_index <= 1) {
		cache.set(key, undefined);
		return undefined;
	}
	const range = getPeExcelRange(cwd, {
		docId,
		datasetId,
		sheetName: node.sheet_name,
		cellRange: `A${node.row_index}:${columnName(node.col_index - 1)}${node.row_index}`,
		maxCells: Math.min(500, node.col_index - 1),
	});
	const label = (range.cells as FormulaTraceNode[])
		.filter((cell) => cell.col_index < node.col_index && !cell.is_formula)
		.sort((left, right) => right.col_index - left.col_index)
		.map((cell) => cell.display_value ?? cell.raw_value)
		.find((value) => value?.trim() && !Number.isFinite(Number(value.replaceAll(",", ""))))
		?.trim();
	cache.set(key, label);
	return label;
}

function buildPaths(trace: PeFormulaTraceResult): Map<string, string[]> {
	const nodeById = new Map(trace.nodes.map((node) => [node.cell_id, node]));
	const root = trace.nodes.find(
		(node) => node.sheet_name === trace.root.sheet_name && node.cell_ref === trace.root.cell_ref,
	);
	if (!root) return new Map();
	const adjacency = new Map<string, string[]>();
	for (const edge of trace.edges) {
		const targets = adjacency.get(edge.source_cell_id) ?? [];
		targets.push(...edge.target_cell_ids);
		adjacency.set(edge.source_cell_id, targets);
	}
	const paths = new Map<string, string[]>([[root.cell_id, [`${root.sheet_name}!${root.cell_ref}`]]]);
	const queue = [root.cell_id];
	for (let index = 0; index < queue.length; index += 1) {
		const sourceId = queue[index];
		const sourcePath = paths.get(sourceId);
		if (!sourcePath) continue;
		for (const targetId of adjacency.get(sourceId) ?? []) {
			if (paths.has(targetId)) continue;
			const target = nodeById.get(targetId);
			if (!target) continue;
			paths.set(targetId, [...sourcePath, `${target.sheet_name}!${target.cell_ref}`]);
			queue.push(targetId);
		}
	}
	return paths;
}

const ROLE_ORDER: Record<PeDriverRole, number> = {
	valuation_assumption: 0,
	operating_assumption: 1,
	scenario_selector: 2,
	forecast_input: 3,
	hardcoded_input: 4,
	historical_actual: 5,
	display_or_text: 6,
};

export function discoverPeDrivers(
	cwd: string,
	options: PeDriverDiscoverOptions,
	signal?: AbortSignal,
): PeDriverDiscoverResult {
	const docId = options.docId.trim();
	const outputSheet = options.outputSheet.trim();
	const outputCellRef = options.outputCellRef.trim().replaceAll("$", "").toUpperCase();
	if (!docId) throw new Error("doc_id is required");
	if (!outputSheet) throw new Error("output_sheet is required");
	if (!outputCellRef) throw new Error("output_cell_ref is required");
	const selectedOutputId = outputId(docId, outputSheet, outputCellRef);
	const topK = Math.max(1, Math.min(MAX_TOP_K, Math.trunc(options.topK ?? DEFAULT_TOP_K)));
	const trace = tracePeFormula(
		cwd,
		{
			docId,
			sheetName: outputSheet,
			cellRef: outputCellRef,
			datasetId: options.datasetId,
			maxDepth: 20,
			maxNodes: 500,
		},
		signal,
	);
	const paths = buildPaths(trace);
	const labelCache = new Map<string, string | undefined>();
	const classified = trace.nodes
		.filter((node) => node.depth > 0 && !node.is_formula)
		.map((node) => {
			const resolvedLabel = resolvePeDriverLabel(cwd, options.docId, options.datasetId, node, labelCache);
			const classification = classifyDriver(node, resolvedLabel);
			const label = resolvedLabel ?? node.display_value ?? `${node.sheet_name}!${node.cell_ref}`;
			const baselineValue = node.numeric_value ?? node.display_value ?? node.raw_value;
			return {
				node,
				classification,
				candidate: {
					driver_id: driverId(docId, node.sheet_name, node.cell_ref),
					discovery_rank: 0,
					role: classification.role,
					epistemic_status: classification.epistemicStatus,
					report_tier: classification.reportTier,
					dependency_status: "structurally_connected" as const,
					activation_status: "not_tested" as const,
					sensitivity_status: "not_run" as const,
					sheet_name: node.sheet_name,
					cell_ref: node.cell_ref,
					label,
					...(baselineValue !== undefined ? { baseline_value: baselineValue } : {}),
					...(node.period ? { period: node.period } : {}),
					...(node.unit ? { unit: node.unit } : {}),
					depth: node.depth,
					dependency_path: paths.get(node.cell_id) ?? [`${node.sheet_name}!${node.cell_ref}`],
					evidence_id: node.evidence_id,
					markdown_citation: node.markdown_citation,
					classification_reasons: classification.reasons,
				},
			};
		})
		.sort(
			(left, right) =>
				ROLE_ORDER[left.classification.role] - ROLE_ORDER[right.classification.role] ||
				left.node.depth - right.node.depth ||
				left.node.sheet_name.localeCompare(right.node.sheet_name) ||
				left.node.row_index - right.node.row_index ||
				left.node.col_index - right.node.col_index,
		)
		.map(({ candidate }, index) => ({ ...candidate, discovery_rank: index + 1 }));
	const returned = classified.slice(0, topK);
	const traceComplete = formulaTraceIsStructurallyComplete(trace);
	const warnings = [
		...(!traceComplete ? ["Formula lineage is incomplete; driver discovery covers only traversed nodes"] : []),
		...(classified.length > returned.length
			? [`Driver candidates were limited to the strongest ${topK} structural matches`]
			: []),
		"No workbook recalculation was run; discovery rank is not sensitivity rank and active-driver status remains untested",
	];
	return {
		schema_version: "1.0",
		dataset_id: trace.dataset_id,
		doc_id: docId,
		output: { output_id: selectedOutputId, sheet_name: trace.root.sheet_name, cell_ref: trace.root.cell_ref },
		status: classified.length === 0 ? "no_candidates" : traceComplete ? "discovered" : "incomplete",
		trace_complete: traceComplete,
		trace_issue_codes: [...new Set(trace.issues.map((issue) => issue.code))],
		upstream_node_count: Math.max(0, trace.node_count - 1),
		formula_intermediate_count: trace.nodes.filter((node) => node.depth > 0 && node.is_formula).length,
		candidate_count: classified.length,
		returned_candidate_count: returned.length,
		sensitivity_ranking_available: false,
		candidates: returned,
		warnings,
		answer_contract:
			"Candidates are structurally connected upstream inputs, not proven active drivers. Do not call discovery_rank a sensitivity or materiality ranking. Only a recalculation-based sensitivity run may set active_driver or quantify valuation impact. Keep historical actuals as context and exclude display-only cells from the main report.",
	};
}

export const peDriverDiscoverTool = defineTool({
	name: "pe_driver_discover",
	label: "PE Driver Discover",
	description:
		"Classify non-formula inputs upstream of one selected valuation output. Returns dependency paths, assumption roles, actual/estimate hints, and report tiers without claiming recalculated sensitivity.",
	promptSnippet: PE_DRIVER_DISCOVER_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		output_sheet: Type.String({ description: "Worksheet containing the selected valuation output.", minLength: 1 }),
		output_cell_ref: Type.String({ description: "A1 reference of the selected valuation output.", minLength: 2 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		top_k: Type.Optional(
			Type.Integer({
				description: "Maximum structurally ranked candidates returned. Defaults to 25; maximum 100.",
				minimum: 1,
				maximum: MAX_TOP_K,
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = discoverPeDrivers(
			ctx.cwd,
			{
				docId: params.doc_id,
				outputSheet: params.output_sheet,
				outputCellRef: params.output_cell_ref,
				datasetId: params.dataset_id,
				topK: params.top_k,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
