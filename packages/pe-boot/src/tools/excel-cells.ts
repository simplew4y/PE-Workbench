import type { DatabaseSync } from "node:sqlite";
import { type ExcelBounds, parseExcelCellRange } from "../source.ts";
import {
	booleanValue,
	numberValue,
	type SqlRow,
	sourceCitation,
	sourceEvidenceId,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";

export interface ExcelCellDetail {
	cell_id: string;
	evidence_id: string;
	citation: string;
	markdown_citation: string;
	sheet_name: string;
	cell_ref: string;
	row_index: number;
	col_index: number;
	display_value?: string;
	raw_value?: string;
	numeric_value?: number;
	formula?: string;
	cached_value?: string;
	number_format?: string;
	row_label?: string;
	col_label?: string;
	period?: string;
	unit?: string;
	formula_type?: string;
	formula_cache_status?: string;
	period_context?: ExcelSemanticContext;
	unit_context?: ExcelSemanticContext;
	is_formula: boolean;
}

export interface ExcelSemanticContext {
	status: "inferred" | "missing" | "ambiguous";
	method: string;
	sources: Array<{ cell_ref: string; text: string }>;
	reason?: string;
}

export type ExcelRangeBounds = ExcelBounds;
export { parseExcelCellRange };

export function excelCellDetail(row: SqlRow): ExcelCellDetail {
	const cellId = textValue(row, "cell_id") ?? "";
	const evidenceId = sourceEvidenceId(row);
	const cell: ExcelCellDetail = {
		cell_id: cellId,
		evidence_id: evidenceId,
		citation: sourceCitation(row),
		markdown_citation: sourceMarkdownCitation(row, evidenceId),
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
		["cached_value", "cached_value"],
		["number_format", "number_format"],
		["row_label", "row_label"],
		["col_label", "col_label"],
		["period", "period"],
		["unit", "unit"],
		["formula_type", "formula_type"],
		["formula_cache_status", "formula_cache_status"],
	] as const) {
		const value = textValue(row, source);
		if (value) cell[target] = value;
	}
	const numericValue = numberValue(row, "numeric_value");
	if (numericValue !== undefined) cell.numeric_value = numericValue;
	const metadataText = textValue(row, "metadata_json");
	if (metadataText) {
		try {
			const metadata = JSON.parse(metadataText) as Record<string, unknown>;
			for (const key of ["period_context", "unit_context"] as const) {
				const value = metadata[key];
				if (!value || typeof value !== "object") continue;
				const context = value as Record<string, unknown>;
				if (
					!["inferred", "missing", "ambiguous"].includes(String(context.status)) ||
					typeof context.method !== "string" ||
					!Array.isArray(context.sources)
				)
					continue;
				const sources = context.sources.filter(
					(source): source is { cell_ref: string; text: string } =>
						!!source &&
						typeof source === "object" &&
						typeof source.cell_ref === "string" &&
						typeof source.text === "string",
				);
				cell[key] = {
					status: context.status as ExcelSemanticContext["status"],
					method: context.method,
					sources,
					...(typeof context.reason === "string" ? { reason: context.reason } : {}),
				};
			}
		} catch {
			// A malformed legacy context must not turn a heuristic into verified evidence.
		}
	}
	return cell;
}

export function readExcelCellsByBounds(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheetName: string,
	bounds: ExcelRangeBounds,
	maxCells: number,
): ExcelCellDetail[] {
	const rows = database
		.prepare(
			`SELECT c.*, c.cell_ref AS cell_range,
			        d.original_filename, d.source_relpath, d.file_type, d.doc_type,
			        d.document_date, d.version_no
			 FROM excel_cells c
			 JOIN documents d ON d.doc_id = c.doc_id
			 WHERE c.dataset_id = ? AND c.doc_id = ? AND c.sheet_name = ?
			   AND c.row_index BETWEEN ? AND ? AND c.col_index BETWEEN ? AND ?
			   AND d.deleted_at IS NULL
			 ORDER BY c.row_index, c.col_index LIMIT ?`,
		)
		.all(
			datasetId,
			docId,
			sheetName,
			bounds.rowStart,
			bounds.rowEnd,
			bounds.columnStart,
			bounds.columnEnd,
			maxCells,
		) as SqlRow[];
	return rows.map(excelCellDetail);
}

export function readExcelCellsInRange(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheetName: string,
	cellRange: string,
	maxCells: number,
): ExcelCellDetail[] {
	const bounds = parseExcelCellRange(cellRange);
	return bounds ? readExcelCellsByBounds(database, datasetId, docId, sheetName, bounds, maxCells) : [];
}

export function countExcelCellsByBounds(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheetName: string,
	bounds: ExcelRangeBounds,
): number {
	const row = database
		.prepare(
			`SELECT COUNT(*) AS cell_count
			 FROM excel_cells
			 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?
			   AND row_index BETWEEN ? AND ? AND col_index BETWEEN ? AND ?`,
		)
		.get(datasetId, docId, sheetName, bounds.rowStart, bounds.rowEnd, bounds.columnStart, bounds.columnEnd) as SqlRow;
	return numberValue(row, "cell_count") ?? 0;
}
