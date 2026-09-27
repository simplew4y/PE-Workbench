import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { formatWorkbookTraceText } from "../workbook-text.ts";
import { openPeDataset, type SqlRow, sourceFilename } from "./database.ts";
import { type ExcelCellDetail, excelCellDetail, parseExcelCellRange } from "./excel-cells.ts";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 120;
const MAX_NODES = 500;

export const PE_FORMULA_TRACE_PROMPT_SNIPPET =
	"Trace a selected Excel output cell upstream by reading original formulas on demand with explicit unresolved-link and cache warnings";

export interface PeFormulaTraceOptions {
	docId: string;
	sheetName: string;
	cellRef: string;
	datasetId?: string;
	maxDepth?: number;
	maxNodes?: number;
}

export interface FormulaTraceNode extends ExcelCellDetail {
	depth: number;
}

export interface FormulaTraceEdge {
	source_cell_id: string;
	source_sheet: string;
	source_cell_ref: string;
	reference_index: number;
	raw_reference: string;
	reference_kind: string;
	parse_status: string;
	target_sheet?: string;
	target_range?: string;
	defined_name?: string;
	external_workbook?: string;
	target_cell_ids: string[];
	target_is_blank?: boolean;
	truncated?: boolean;
}

export interface FormulaTraceIssue {
	code: string;
	message: string;
	source_sheet?: string;
	source_cell_ref?: string;
	raw_reference?: string;
}

export interface PeFormulaTraceResult {
	dataset_id: string;
	doc_id: string;
	document?: { doc_id: string; filename: string; version_no?: number };
	root: { sheet_name: string; cell_ref: string };
	direction: "upstream";
	complete: boolean;
	truncated: boolean;
	node_count: number;
	edge_count: number;
	issues: FormulaTraceIssue[];
	nodes: FormulaTraceNode[];
	edges: FormulaTraceEdge[];
	answer_contract: string;
}

export function formulaTraceIsStructurallyComplete(trace: PeFormulaTraceResult): boolean {
	return !trace.truncated && trace.issues.every((issue) => issue.code === "formula_cache_unavailable");
}

export function tracePeFormula(
	cwd: string,
	options: PeFormulaTraceOptions,
	signal?: AbortSignal,
): PeFormulaTraceResult {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const document = connection.database
			.prepare(
				"SELECT doc_id, original_filename, source_relpath, version_no FROM documents WHERE dataset_id=? AND doc_id=?",
			)
			.get(connection.datasetId, options.docId) as SqlRow | undefined;
		const result = readWorkbookDocument(connection.database, connection.datasetId, options.docId, {
			action: "trace",
			sheet: options.sheetName,
			range: options.cellRef,
			max_depth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
			max_nodes: options.maxNodes ?? DEFAULT_MAX_NODES,
		});
		const rows = result.nodes as SqlRow[];
		const nodes = rows.map((row) => ({ ...excelCellDetail(row), depth: Number(row.depth ?? 0) }));
		const edges = (result.edges as Array<Record<string, unknown>>).map((edge) => {
			const source = nodes.find(
				(node) => node.sheet_name === edge.source_sheet && node.cell_ref === edge.source_cell_ref,
			);
			const destinations = (
				Array.isArray(edge.destinations) ? edge.destinations : [[edge.target_sheet, edge.target_range]]
			) as Array<[string, string]>;
			const targets = destinations.flatMap(([sheet, range]) => {
				const bounds = typeof range === "string" ? parseExcelCellRange(range) : undefined;
				return bounds
					? nodes
							.filter(
								(node) =>
									node.sheet_name === sheet &&
									node.row_index >= bounds.rowStart &&
									node.row_index <= bounds.rowEnd &&
									node.col_index >= bounds.columnStart &&
									node.col_index <= bounds.columnEnd,
							)
							.map((node) => node.cell_id)
					: [];
			});
			return {
				...edge,
				source_cell_id: source?.cell_id ?? "",
				target_cell_ids: [...new Set(targets)],
			} as FormulaTraceEdge;
		});
		const issues = (result.issues as Array<Record<string, unknown>>).map((issue) => ({
			...issue,
			code: String(issue.reason),
			message: String(issue.reason).replaceAll("_", " "),
			...(typeof issue.sheet === "string" ? { source_sheet: issue.sheet } : {}),
			...(typeof issue.cell_ref === "string" ? { source_cell_ref: issue.cell_ref } : {}),
			...(typeof issue.reference === "string" ? { raw_reference: issue.reference } : {}),
		}));
		return {
			...result,
			dataset_id: connection.datasetId,
			doc_id: options.docId,
			...(document
				? {
						document: {
							doc_id: options.docId,
							filename: sourceFilename(document),
							version_no: Number(document.version_no),
						},
					}
				: {}),
			root: { sheet_name: options.sheetName, cell_ref: options.cellRef },
			direction: "upstream",
			complete: result.complete === true,
			truncated: result.truncated === true,
			node_count: nodes.length,
			edge_count: edges.length,
			nodes,
			edges,
			issues,
			answer_contract:
				"Only traversed sources are verified. Continue pending_ranges and pending_reads when limited. External and dynamic references remain unresolved; saved values do not prove fresh recalculation.",
		};
	} finally {
		connection.database.close();
	}
}

export const peFormulaTraceTool = defineTool({
	name: "pe_formula_trace",
	label: "PE Formula Trace",
	description:
		"Trace one selected Excel cell upstream by parsing the original formulas on demand. Returns compact node lines (cell, saved value, formula, notes with depth, evidence_id) grouped by sheet, then edges, cache warnings, unresolved links, cycles and pending work, under a text budget. Range references such as SUM(A1:A200) or lookup tables expand to every cell; start with a small max_depth and trace intermediate cells instead of raising max_nodes.",
	promptSnippet: PE_FORMULA_TRACE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		sheet_name: Type.String({ description: "Exact worksheet name containing the output cell.", minLength: 1 }),
		cell_ref: Type.String({ description: "One A1 output cell reference, such as H42.", minLength: 2 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		max_depth: Type.Optional(
			Type.Integer({
				description: `Maximum upstream depth. Defaults to ${DEFAULT_MAX_DEPTH}; maximum 20.`,
				minimum: 0,
				maximum: 20,
			}),
		),
		max_nodes: Type.Optional(
			Type.Integer({
				description: `Maximum traced cells. Defaults to ${DEFAULT_MAX_NODES}; maximum ${MAX_NODES}. The text budget may show fewer.`,
				minimum: 1,
				maximum: MAX_NODES,
			}),
		),
		include_evidence_ids: Type.Optional(
			Type.Boolean({ description: "Emit a source: evidence_id per traced cell. Defaults to true." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = tracePeFormula(
			ctx.cwd,
			{
				docId: params.doc_id,
				sheetName: params.sheet_name,
				cellRef: params.cell_ref,
				datasetId: params.dataset_id,
				maxDepth: params.max_depth,
				maxNodes: params.max_nodes,
			},
			signal,
		);
		const rendered = formatWorkbookTraceText(result as unknown as Record<string, unknown>, {
			includeEvidenceIds: params.include_evidence_ids !== false,
		});
		return {
			content: [{ type: "text", text: rendered.text }],
			details: { ...result, model_text: rendered.summary },
		};
	},
});
