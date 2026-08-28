import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	booleanValue,
	evidenceLocator,
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceFilename,
	textValue,
} from "./database.ts";
import { clipText, normalizeText } from "./search-utils.ts";

const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MAX_CELLS = 48;

export const PE_SOURCE_DETAIL_PROMPT_SNIPPET =
	"Inspect bounded PDF text or Excel context for an evidence ID returned by pe_dataset_search";

export type SourceDetailMode = "auto" | "meta" | "text" | "excel_window" | "full";

export interface PeSourceDetailOptions {
	evidenceId: string;
	datasetId?: string;
	contextRadius?: number;
	mode?: string;
	maxChars?: number;
	maxCells?: number;
}

export interface ExcelCellDetail {
	cell_id: string;
	sheet_name: string;
	cell_ref: string;
	row_index: number;
	col_index: number;
	display_value?: string;
	raw_value?: string;
	numeric_value?: number;
	formula?: string;
	row_label?: string;
	col_label?: string;
	period?: string;
	unit?: string;
	is_formula: boolean;
}

interface PdfPageDetail {
	page_number: number;
	text: string;
	truncated: boolean;
}

function activeDocumentPredicate(): string {
	return "d.deleted_at IS NULL AND COALESCE(d.is_current, 1) = 1 AND COALESCE(d.lifecycle_state, 'active') = 'active'";
}

function parseMode(mode: string | undefined): SourceDetailMode {
	const normalized = (mode ?? "auto").trim().toLowerCase();
	if (["auto", "meta", "text", "excel_window", "full"].includes(normalized)) {
		return normalized as SourceDetailMode;
	}
	throw new Error("mode must be auto, meta, text, excel_window, or full");
}

function cellColumnToNumber(column: string): number {
	let value = 0;
	for (const character of column.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
	return value;
}

function parseCellRef(cellRef: string): [number, number] | undefined {
	const match = /^\$?([A-Za-z]+)\$?(\d+)$/u.exec(cellRef.trim());
	if (!match) return undefined;
	return [Number(match[2]), cellColumnToNumber(match[1])];
}

function parseCellRange(cellRange: string): [number, number, number, number] | undefined {
	const [startRef, endRef = startRef] = cellRange.split(":", 2);
	const start = parseCellRef(startRef);
	const end = parseCellRef(endRef);
	if (!start || !end) return undefined;
	return [
		Math.min(start[0], end[0]),
		Math.min(start[1], end[1]),
		Math.max(start[0], end[0]),
		Math.max(start[1], end[1]),
	];
}

function cellDetail(row: SqlRow): ExcelCellDetail {
	const cell: ExcelCellDetail = {
		cell_id: textValue(row, "cell_id") ?? "",
		sheet_name: textValue(row, "sheet_name") ?? "",
		cell_ref: textValue(row, "cell_ref") ?? "",
		row_index: numberValue(row, "row_index") ?? 0,
		col_index: numberValue(row, "col_index") ?? 0,
		is_formula: booleanValue(row, "is_formula"),
	};
	for (const [source, target] of [
		["display_value", "display_value"],
		["raw_value", "raw_value"],
		["formula", "formula"],
		["row_label", "row_label"],
		["col_label", "col_label"],
		["period", "period"],
		["unit", "unit"],
	] as const) {
		const value = textValue(row, source);
		if (value) cell[target] = value;
	}
	const numericValue = numberValue(row, "numeric_value");
	if (numericValue !== undefined) cell.numeric_value = numericValue;
	return cell;
}

function cellsByBounds(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	docId: string,
	sheetName: string,
	rowStart: number,
	columnStart: number,
	rowEnd: number,
	columnEnd: number,
	maxCells: number,
): ExcelCellDetail[] {
	const rows = database
		.prepare(
			`SELECT * FROM excel_cells
			 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?
			   AND row_index BETWEEN ? AND ? AND col_index BETWEEN ? AND ?
			 ORDER BY row_index, col_index LIMIT ?`,
		)
		.all(
			datasetId,
			docId,
			sheetName,
			Math.max(1, rowStart),
			Math.max(1, rowEnd),
			Math.max(1, columnStart),
			Math.max(1, columnEnd),
			maxCells,
		) as SqlRow[];
	return rows.map(cellDetail);
}

function cellsInRange(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	docId: string,
	sheetName: string,
	cellRange: string,
	maxCells: number,
): ExcelCellDetail[] {
	const bounds = parseCellRange(cellRange);
	return bounds ? cellsByBounds(database, datasetId, docId, sheetName, ...bounds, maxCells) : [];
}

function pdfPageContext(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	docId: string,
	pageStart: number,
	pageEnd: number,
	contextRadius: number,
	maxChars: number,
): PdfPageDetail[] {
	const rows = database
		.prepare(
			`SELECT page_number, text FROM pdf_pages
			 WHERE dataset_id = ? AND doc_id = ? AND page_number BETWEEN ? AND ?
			 ORDER BY page_number`,
		)
		.all(datasetId, docId, Math.max(1, pageStart - contextRadius), pageEnd + contextRadius) as SqlRow[];
	const perPageBudget = Math.min(3_500, Math.max(800, Math.floor(maxChars / Math.max(1, rows.length))));
	return rows.map((row) => {
		const text = normalizeText(textValue(row, "text"));
		return {
			page_number: numberValue(row, "page_number") ?? 0,
			text: clipText(text, perPageBudget),
			truncated: text.length > perPageBudget,
		};
	});
}

function baseDetail(datasetId: string, evidenceId: string, row: SqlRow, mode: SourceDetailMode) {
	return {
		dataset_id: datasetId,
		evidence_id: evidenceId,
		citation: sourceCitation(row),
		filename: sourceFilename(row),
		locator: evidenceLocator(row),
		mode,
		document: {
			doc_id: textValue(row, "doc_id"),
			file_type: textValue(row, "file_type"),
			doc_type: textValue(row, "doc_type"),
			document_date: textValue(row, "document_date"),
			version_no: numberValue(row, "version_no"),
		},
	};
}

function chunkDetail(
	connection: ReturnType<typeof openPeDataset>,
	evidenceId: string,
	chunkId: string,
	mode: SourceDetailMode,
	contextRadius: number,
	maxChars: number,
	maxCells: number,
): Record<string, unknown> {
	const row = connection.database
		.prepare(
			`SELECT c.*, d.original_filename, d.source_relpath, d.file_type, d.doc_type,
			        d.document_date, d.version_no,
			        l.page_start, l.page_end, l.sheet_name, l.cell_range, l.heading_path
			 FROM chunks c
			 JOIN documents d ON d.doc_id = c.doc_id
			 LEFT JOIN chunk_locations l
			   ON l.chunk_id = c.chunk_id
			  AND l.location_index = (
			      SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
			  )
			 WHERE c.chunk_id = ? AND c.dataset_id = ? AND ${activeDocumentPredicate()}`,
		)
		.get(chunkId, connection.datasetId) as SqlRow | undefined;
	if (!row) throw new Error(`chunk not found in the current dataset: ${chunkId}`);

	const sheetName = textValue(row, "sheet_name");
	const cellRange = textValue(row, "cell_range");
	const resolvedMode = mode === "auto" ? (sheetName && cellRange ? "excel_window" : "text") : mode;
	const detail: Record<string, unknown> = {
		...baseDetail(connection.datasetId, evidenceId, row, resolvedMode),
		content_type: textValue(row, "content_type"),
		title_path: textValue(row, "title_path"),
	};
	const content = normalizeText(textValue(row, "content"));
	if (resolvedMode === "meta") {
		detail.preview = clipText(content, Math.min(400, maxChars));
		detail.content_total_chars = content.length;
		return detail;
	}
	if (resolvedMode === "text" || resolvedMode === "full") {
		detail.content = clipText(content, maxChars);
		detail.content_total_chars = content.length;
		detail.content_truncated = content.length > maxChars;
		const pageStart = numberValue(row, "page_start");
		if (pageStart !== undefined) {
			detail.pdf_pages = pdfPageContext(
				connection.database,
				connection.datasetId,
				textValue(row, "doc_id") ?? "",
				pageStart,
				numberValue(row, "page_end") ?? pageStart,
				contextRadius,
				maxChars,
			);
		}
	}
	if (sheetName && cellRange && ["text", "excel_window", "full"].includes(resolvedMode)) {
		detail.excel_cells = cellsInRange(
			connection.database,
			connection.datasetId,
			textValue(row, "doc_id") ?? "",
			sheetName,
			cellRange,
			maxCells,
		);
	}
	return detail;
}

function factDetail(
	connection: ReturnType<typeof openPeDataset>,
	evidenceId: string,
	factId: string,
	mode: SourceDetailMode,
	contextRadius: number,
	maxCells: number,
): Record<string, unknown> {
	const row = connection.database
		.prepare(
			`SELECT f.*, f.cell_ref AS cell_range, d.original_filename, d.source_relpath,
			        d.file_type, d.doc_type, d.document_date, d.version_no
			 FROM metric_facts f
			 JOIN documents d ON d.doc_id = f.doc_id
			 WHERE f.fact_id = ? AND f.dataset_id = ? AND ${activeDocumentPredicate()}`,
		)
		.get(factId, connection.datasetId) as SqlRow | undefined;
	if (!row) throw new Error(`metric fact not found in the current dataset: ${factId}`);
	const resolvedMode = mode === "auto" ? "excel_window" : mode;
	const detail: Record<string, unknown> = {
		...baseDetail(connection.datasetId, evidenceId, row, resolvedMode),
		metric: {
			name: textValue(row, "metric_name"),
			period: textValue(row, "period"),
			value_text: textValue(row, "value_text"),
			value_numeric: numberValue(row, "value_numeric"),
			unit: textValue(row, "unit"),
			formula: textValue(row, "formula"),
			confidence: numberValue(row, "confidence"),
		},
	};
	if (resolvedMode === "meta") return detail;

	const cell = connection.database
		.prepare(
			"SELECT row_index, col_index FROM excel_cells WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ? AND cell_ref = ?",
		)
		.get(
			connection.datasetId,
			textValue(row, "doc_id") ?? "",
			textValue(row, "sheet_name") ?? "",
			textValue(row, "cell_ref") ?? "",
		) as SqlRow | undefined;
	if (cell) {
		const rowIndex = numberValue(cell, "row_index") ?? 1;
		const columnIndex = numberValue(cell, "col_index") ?? 1;
		detail.excel_cells = cellsByBounds(
			connection.database,
			connection.datasetId,
			textValue(row, "doc_id") ?? "",
			textValue(row, "sheet_name") ?? "",
			rowIndex - contextRadius,
			columnIndex - 5,
			rowIndex + contextRadius,
			columnIndex + 5,
			maxCells,
		);
	}
	return detail;
}

function rawCellDetail(
	connection: ReturnType<typeof openPeDataset>,
	evidenceId: string,
	cellId: string,
	mode: SourceDetailMode,
	contextRadius: number,
	maxCells: number,
): Record<string, unknown> {
	const row = connection.database
		.prepare(
			`SELECT c.*, c.cell_ref AS cell_range, d.original_filename, d.source_relpath,
			        d.file_type, d.doc_type, d.document_date, d.version_no
			 FROM excel_cells c
			 JOIN documents d ON d.doc_id = c.doc_id
			 WHERE c.cell_id = ? AND c.dataset_id = ? AND ${activeDocumentPredicate()}`,
		)
		.get(cellId, connection.datasetId) as SqlRow | undefined;
	if (!row) throw new Error(`Excel cell not found in the current dataset: ${cellId}`);
	const resolvedMode = mode === "auto" ? "excel_window" : mode;
	const detail: Record<string, unknown> = {
		...baseDetail(connection.datasetId, evidenceId, row, resolvedMode),
		cell: cellDetail(row),
	};
	if (resolvedMode !== "meta") {
		const rowIndex = numberValue(row, "row_index") ?? 1;
		const columnIndex = numberValue(row, "col_index") ?? 1;
		detail.excel_cells = cellsByBounds(
			connection.database,
			connection.datasetId,
			textValue(row, "doc_id") ?? "",
			textValue(row, "sheet_name") ?? "",
			rowIndex - contextRadius,
			columnIndex - 5,
			rowIndex + contextRadius,
			columnIndex + 5,
			maxCells,
		);
	}
	return detail;
}

export function getPeSourceDetail(
	cwd: string,
	options: PeSourceDetailOptions,
	signal?: AbortSignal,
): Record<string, unknown> {
	const evidenceId = options.evidenceId.trim();
	const separator = evidenceId.indexOf(":");
	if (separator <= 0 || separator === evidenceId.length - 1) {
		throw new Error("evidence_id must look like chunk:<id>, fact:<id>, or cell:<id>");
	}
	const kind = evidenceId.slice(0, separator);
	const rawId = evidenceId.slice(separator + 1);
	const contextRadius = Math.max(0, Math.min(3, Math.trunc(options.contextRadius ?? 1)));
	const maxChars = Math.max(500, Math.min(20_000, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS)));
	const maxCells = Math.max(1, Math.min(80, Math.trunc(options.maxCells ?? DEFAULT_MAX_CELLS)));
	const mode = parseMode(options.mode);
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		if (kind === "chunk") {
			return chunkDetail(connection, evidenceId, rawId, mode, contextRadius, maxChars, maxCells);
		}
		if (kind === "fact") return factDetail(connection, evidenceId, rawId, mode, contextRadius, maxCells);
		if (kind === "cell") return rawCellDetail(connection, evidenceId, rawId, mode, contextRadius, maxCells);
		throw new Error(`unsupported evidence type: ${kind}`);
	} finally {
		connection.database.close();
	}
}

export const peSourceDetailTool = defineTool({
	name: "pe_source_detail",
	label: "PE Source Detail",
	description:
		"Verify an evidence ID returned by pe_dataset_search. Returns bounded PDF page text or an Excel cell window with values and formulas. Use auto mode unless a smaller meta/text/excel_window response is required.",
	promptSnippet: PE_SOURCE_DETAIL_PROMPT_SNIPPET,
	parameters: Type.Object({
		evidence_id: Type.String({
			description: "Evidence ID returned by pe_dataset_search: chunk:<id>, fact:<id>, or cell:<id>.",
			minLength: 3,
		}),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		context_radius: Type.Optional(
			Type.Integer({
				description: "PDF pages or Excel rows around the source. Defaults to 1; maximum 3.",
				minimum: 0,
				maximum: 3,
			}),
		),
		mode: Type.Optional(
			Type.String({ description: "Response shape: auto, meta, text, excel_window, or full. Defaults to auto." }),
		),
		max_chars: Type.Optional(
			Type.Integer({
				description: "Maximum characters for content windows. Defaults to 6000; maximum 20000.",
				minimum: 500,
				maximum: 20_000,
			}),
		),
		max_cells: Type.Optional(
			Type.Integer({
				description: "Maximum Excel cells in the returned window. Defaults to 48; maximum 80.",
				minimum: 1,
				maximum: 80,
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = getPeSourceDetail(
			ctx.cwd,
			{
				evidenceId: params.evidence_id,
				datasetId: params.dataset_id,
				contextRadius: params.context_radius,
				mode: params.mode,
				maxChars: params.max_chars,
				maxCells: params.max_cells,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
