import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { openPeDataset, type SqlRow, textValue } from "./database.ts";
import {
	countExcelCellsByBounds,
	type ExcelCellDetail,
	parseExcelCellRange,
	readExcelCellsByBounds,
} from "./excel-cells.ts";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_RANGE_CELLS = 100;

export const PE_FORMULA_TRACE_PROMPT_SNIPPET =
	"Trace a selected Excel output cell upstream through stored formula references with explicit unresolved-link and cache warnings";

export interface PeFormulaTraceOptions {
	docId: string;
	sheetName: string;
	cellRef: string;
	datasetId?: string;
	maxDepth?: number;
	maxNodes?: number;
	maxRangeCells?: number;
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

function tableExists(database: DatabaseSync, table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function canonicalCellRef(value: string): string | undefined {
	const normalized = value.trim().replaceAll("$", "").toUpperCase();
	const bounds = parseExcelCellRange(normalized);
	if (!bounds || bounds.rowStart !== bounds.rowEnd || bounds.columnStart !== bounds.columnEnd) return undefined;
	return /^[A-Z]{1,3}[1-9]\d*$/u.test(normalized) ? normalized : undefined;
}

function issueKey(issue: FormulaTraceIssue): string {
	return [issue.code, issue.source_sheet, issue.source_cell_ref, issue.raw_reference].join("\0");
}

export function tracePeFormula(
	cwd: string,
	options: PeFormulaTraceOptions,
	signal?: AbortSignal,
): PeFormulaTraceResult {
	const docId = options.docId.trim();
	const requestedSheetName = options.sheetName.trim();
	const rootCellRef = canonicalCellRef(options.cellRef);
	if (!docId) throw new Error("doc_id is required");
	if (!requestedSheetName) throw new Error("sheet_name is required");
	if (!rootCellRef) throw new Error("cell_ref must be one valid A1 cell reference");
	const maxDepth = Math.max(0, Math.min(20, Math.trunc(options.maxDepth ?? DEFAULT_MAX_DEPTH)));
	const maxNodes = Math.max(1, Math.min(1_000, Math.trunc(options.maxNodes ?? DEFAULT_MAX_NODES)));
	const maxRangeCells = Math.max(1, Math.min(500, Math.trunc(options.maxRangeCells ?? DEFAULT_MAX_RANGE_CELLS)));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		if (!tableExists(connection.database, "excel_formula_references")) {
			throw new Error(
				"dataset has no formula-reference cache; open the workbook with pe_document_open before tracing formulas",
			);
		}
		const document = connection.database
			.prepare(
				`SELECT doc_id FROM documents
				 WHERE dataset_id = ? AND doc_id = ? AND deleted_at IS NULL
				   AND COALESCE(is_current, 1) = 1
				   AND COALESCE(lifecycle_state, 'active') = 'active'`,
			)
			.get(connection.datasetId, docId);
		if (!document) throw new Error(`active document not found in the current dataset: ${docId}`);

		const sheetRows = connection.database
			.prepare("SELECT sheet_name FROM excel_sheets WHERE dataset_id = ? AND doc_id = ? ORDER BY sheet_index")
			.all(connection.datasetId, docId) as SqlRow[];
		const sheetNames = new Map<string, string>();
		for (const sheetRow of sheetRows) {
			const sheetName = textValue(sheetRow, "sheet_name");
			if (sheetName) sheetNames.set(sheetName.toLocaleLowerCase(), sheetName);
		}
		const rootSheetName = sheetNames.get(requestedSheetName.toLocaleLowerCase());
		if (!rootSheetName) throw new Error(`Excel sheet not found in active document ${docId}: ${requestedSheetName}`);

		const nodes: FormulaTraceNode[] = [];
		const edges: FormulaTraceEdge[] = [];
		const issues: FormulaTraceIssue[] = [];
		const issueKeys = new Set<string>();
		const visited = new Set<string>();
		const visiting = new Set<string>();
		let truncated = false;

		const addIssue = (issue: FormulaTraceIssue): void => {
			const key = issueKey(issue);
			if (issueKeys.has(key)) return;
			issueKeys.add(key);
			issues.push(issue);
		};

		const visit = (sheetName: string, cellRef: string, depth: number): void => {
			signal?.throwIfAborted();
			const nodeKey = `${sheetName}\0${cellRef}`;
			if (visiting.has(nodeKey)) {
				addIssue({
					code: "circular_reference",
					message: `Circular reference reaches ${sheetName}!${cellRef}`,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
				});
				return;
			}
			if (visited.has(nodeKey)) return;
			if (nodes.length >= maxNodes) {
				truncated = true;
				addIssue({
					code: "node_limit_reached",
					message: `Formula trace reached the ${maxNodes}-node limit`,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
				});
				return;
			}

			const bounds = parseExcelCellRange(cellRef);
			if (!bounds) return;
			const [cell] = readExcelCellsByBounds(connection.database, connection.datasetId, docId, sheetName, bounds, 1);
			if (!cell) {
				addIssue({
					code: "source_cell_missing",
					message: `Indexed source cell is missing: ${sheetName}!${cellRef}`,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
				});
				return;
			}

			visited.add(nodeKey);
			visiting.add(nodeKey);
			nodes.push({ ...cell, depth });
			if (cell.is_formula && cell.formula_cache_status && cell.formula_cache_status !== "present") {
				addIssue({
					code: "formula_cache_unavailable",
					message: `${sheetName}!${cellRef} formula cache is ${cell.formula_cache_status}`,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
				});
			}

			const referenceRows = connection.database
				.prepare(
					`SELECT * FROM excel_formula_references
					 WHERE dataset_id = ? AND doc_id = ? AND source_sheet = ? AND source_cell_ref = ?
					 ORDER BY reference_index`,
				)
				.all(connection.datasetId, docId, sheetName, cellRef) as SqlRow[];
			if (depth >= maxDepth && referenceRows.length > 0) {
				truncated = true;
				addIssue({
					code: "depth_limit_reached",
					message: `Formula trace reached the depth limit at ${sheetName}!${cellRef}`,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
				});
				visiting.delete(nodeKey);
				return;
			}

			for (const referenceRow of referenceRows) {
				const rawReference = textValue(referenceRow, "raw_reference") ?? "";
				const parseStatus = textValue(referenceRow, "parse_status") ?? "unresolved";
				const targetSheetValue = textValue(referenceRow, "target_sheet");
				const targetRange = textValue(referenceRow, "target_range");
				const targetSheet = targetSheetValue ? sheetNames.get(targetSheetValue.toLocaleLowerCase()) : undefined;
				const edge: FormulaTraceEdge = {
					source_cell_id: cell.cell_id,
					source_sheet: sheetName,
					source_cell_ref: cellRef,
					reference_index: Number(referenceRow.reference_index ?? 0),
					raw_reference: rawReference,
					reference_kind: textValue(referenceRow, "reference_kind") ?? "unknown",
					parse_status: parseStatus,
					target_cell_ids: [],
					...(targetSheetValue ? { target_sheet: targetSheetValue } : {}),
					...(targetRange ? { target_range: targetRange } : {}),
					...(textValue(referenceRow, "defined_name")
						? { defined_name: textValue(referenceRow, "defined_name") }
						: {}),
					...(textValue(referenceRow, "external_workbook")
						? { external_workbook: textValue(referenceRow, "external_workbook") }
						: {}),
				};

				if (parseStatus !== "resolved") {
					addIssue({
						code: `formula_reference_${parseStatus}`,
						message: `Cannot traverse ${sheetName}!${cellRef} reference ${rawReference}: ${parseStatus}`,
						source_sheet: sheetName,
						source_cell_ref: cellRef,
						raw_reference: rawReference,
					});
					edges.push(edge);
					continue;
				}
				if (!targetSheet || !targetRange) {
					addIssue({
						code: "formula_reference_target_missing",
						message: `Resolved reference has no indexed target: ${rawReference}`,
						source_sheet: sheetName,
						source_cell_ref: cellRef,
						raw_reference: rawReference,
					});
					edges.push(edge);
					continue;
				}
				const targetBounds = parseExcelCellRange(targetRange);
				if (!targetBounds) {
					addIssue({
						code: "formula_reference_range_unsupported",
						message: `Reference range is not a bounded A1 range: ${rawReference}`,
						source_sheet: sheetName,
						source_cell_ref: cellRef,
						raw_reference: rawReference,
					});
					edges.push(edge);
					continue;
				}

				const matchingCellCount = countExcelCellsByBounds(
					connection.database,
					connection.datasetId,
					docId,
					targetSheet,
					targetBounds,
				);
				const remainingNodeCapacity = Math.max(0, maxNodes - nodes.length);
				const targetCells =
					remainingNodeCapacity > 0
						? readExcelCellsByBounds(
								connection.database,
								connection.datasetId,
								docId,
								targetSheet,
								targetBounds,
								Math.min(maxRangeCells, remainingNodeCapacity),
							)
						: [];
				edge.target_cell_ids = targetCells.map((targetCell) => targetCell.cell_id);
				if (matchingCellCount === 0) edge.target_is_blank = true;
				if (matchingCellCount > targetCells.length) {
					edge.truncated = true;
					truncated = true;
					addIssue({
						code: "range_expansion_truncated",
						message: `Reference ${rawReference} contains ${matchingCellCount} indexed cells; traversal was capped`,
						source_sheet: sheetName,
						source_cell_ref: cellRef,
						raw_reference: rawReference,
					});
				}
				edges.push(edge);
				for (const targetCell of targetCells) visit(targetSheet, targetCell.cell_ref, depth + 1);
			}
			visiting.delete(nodeKey);
		};

		visit(rootSheetName, rootCellRef, 0);
		return {
			dataset_id: connection.datasetId,
			doc_id: docId,
			root: { sheet_name: rootSheetName, cell_ref: rootCellRef },
			direction: "upstream",
			complete: issues.length === 0 && !truncated,
			truncated,
			node_count: nodes.length,
			edge_count: edges.length,
			issues,
			nodes,
			edges,
			answer_contract:
				"Explain only traversed nodes. Treat external, deferred, unresolved, error, depth-limited, and node-limited references as an incomplete chain. A present cached value is not proof of fresh recalculation.",
		};
	} finally {
		connection.database.close();
	}
}

export const peFormulaTraceTool = defineTool({
	name: "pe_formula_trace",
	label: "PE Formula Trace",
	description:
		"Trace one selected Excel cell upstream through the deterministic formula-reference cache. Returns cited nodes, edges, cache warnings, unresolved links, cycles, and truncation status.",
	promptSnippet: PE_FORMULA_TRACE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ description: "Exact active workbook document ID.", minLength: 1 }),
		sheet_name: Type.String({ description: "Exact worksheet name containing the output cell.", minLength: 1 }),
		cell_ref: Type.String({ description: "One A1 output cell reference, such as H42.", minLength: 2 }),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		max_depth: Type.Optional(
			Type.Integer({ description: "Maximum upstream depth. Defaults to 8; maximum 20.", minimum: 0, maximum: 20 }),
		),
		max_nodes: Type.Optional(
			Type.Integer({
				description: "Maximum returned cells. Defaults to 200; maximum 1000.",
				minimum: 1,
				maximum: 1_000,
			}),
		),
		max_range_cells: Type.Optional(
			Type.Integer({
				description: "Maximum indexed cells expanded from one range reference. Defaults to 100; maximum 500.",
				minimum: 1,
				maximum: 500,
			}),
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
				maxRangeCells: params.max_range_cells,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
