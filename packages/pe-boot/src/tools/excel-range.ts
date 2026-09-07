import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { numberValue, openPeDataset, type SqlRow, sourceFilename, textValue } from "./database.ts";
import { countExcelCellsByBounds, parseExcelCellRange, readExcelCellsByBounds } from "./excel-cells.ts";

const DEFAULT_MAX_CELLS = 200;
const MAX_CELLS = 1_000;

export const PE_EXCEL_RANGE_PROMPT_SNIPPET =
	"Read an exact Excel range from one selected workbook, including formulas, cached values, formats, units, and cell citations";

export interface PeExcelRangeOptions {
	docId: string;
	sheetName: string;
	cellRange: string;
	datasetId?: string;
	maxCells?: number;
}

export function getPeExcelRange(
	cwd: string,
	options: PeExcelRangeOptions,
	signal?: AbortSignal,
): Record<string, unknown> {
	const docId = options.docId.trim();
	const sheetName = options.sheetName.trim();
	const cellRange = options.cellRange.trim();
	if (!docId) throw new Error("doc_id is required");
	if (!sheetName) throw new Error("sheet_name is required");
	const bounds = parseExcelCellRange(cellRange);
	if (!bounds) throw new Error("cell_range must be one A1 cell or A1:B2 range without a sheet prefix");
	const maxCells = Math.max(1, Math.min(MAX_CELLS, Math.trunc(options.maxCells ?? DEFAULT_MAX_CELLS)));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const document = connection.database
			.prepare(
				`SELECT d.doc_id, d.original_filename, d.source_relpath,
				        d.file_type, d.document_date, d.parser_name, d.parser_version
				 FROM documents d
				 WHERE d.dataset_id = ? AND d.doc_id = ? AND d.file_type IN ('xlsx','xlsm')`,
			)
			.get(connection.datasetId, docId) as SqlRow | undefined;
		if (!document) throw new Error(`Excel document not found in the current dataset: ${docId}`);

		const sheet = connection.database
			.prepare(
				`SELECT sheet_index, sheet_name, sheet_role, sheet_state, used_range,
				        row_count, col_count, non_empty_cell_count, formula_count, formula_density
				 FROM excel_sheets
				 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?`,
			)
			.get(connection.datasetId, docId, sheetName) as SqlRow | undefined;
		if (!sheet) throw new Error(`Excel sheet not found in document ${docId}: ${sheetName}`);

		const cells = readExcelCellsByBounds(
			connection.database,
			connection.datasetId,
			docId,
			sheetName,
			bounds,
			maxCells,
		);
		const matchingCellCount = countExcelCellsByBounds(
			connection.database,
			connection.datasetId,
			docId,
			sheetName,
			bounds,
		);
		const requestedCellCount = (bounds.rowEnd - bounds.rowStart + 1) * (bounds.columnEnd - bounds.columnStart + 1);
		return {
			dataset_id: connection.datasetId,
			document: {
				doc_id: textValue(document, "doc_id"),
				filename: sourceFilename(document),
				file_type: textValue(document, "file_type"),
				document_date: textValue(document, "document_date"),
				parser_name: textValue(document, "parser_name"),
				parser_version: textValue(document, "parser_version"),
			},
			sheet: {
				name: textValue(sheet, "sheet_name"),
				index: numberValue(sheet, "sheet_index"),
				role: textValue(sheet, "sheet_role"),
				state: textValue(sheet, "sheet_state"),
				used_range: textValue(sheet, "used_range"),
				row_count: numberValue(sheet, "row_count"),
				col_count: numberValue(sheet, "col_count"),
				non_empty_cell_count: numberValue(sheet, "non_empty_cell_count"),
				formula_count: numberValue(sheet, "formula_count"),
				formula_density: numberValue(sheet, "formula_density"),
			},
			cell_range: cellRange,
			citation: `${sourceFilename(document)} ${sheetName}!${cellRange}`,
			requested_cell_count: requestedCellCount,
			matching_cell_count: matchingCellCount,
			blank_cell_count: Math.max(0, requestedCellCount - matchingCellCount),
			returned_cell_count: cells.length,
			truncated: matchingCellCount > cells.length,
			cells,
			answer_contract:
				"Treat formulas and cached values as distinct fields. Cite decisive cells with their markdown_citation. A present cache is not proof that Excel recalculated it recently.",
		};
	} finally {
		connection.database.close();
	}
}

export const peExcelRangeTool = defineTool({
	name: "pe_excel_range",
	label: "PE Excel Range",
	description:
		"Read an exact A1 range from a selected Excel document, including formulas, cached values, number formats, units, and citations.",
	promptSnippet: PE_EXCEL_RANGE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({
			description: "Exact Excel document ID returned by pe_workbook_inspect.",
			minLength: 1,
		}),
		sheet_name: Type.String({ description: "Exact worksheet name.", minLength: 1 }),
		cell_range: Type.String({
			description: "A single A1 reference or rectangular A1 range, such as H42 or B5:H20.",
			minLength: 1,
			maxLength: 64,
		}),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		max_cells: Type.Optional(
			Type.Integer({
				description: "Maximum non-empty cells returned. Defaults to 200; maximum 1000.",
				minimum: 1,
				maximum: MAX_CELLS,
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = getPeExcelRange(
			ctx.cwd,
			{
				docId: params.doc_id,
				sheetName: params.sheet_name,
				cellRange: params.cell_range,
				datasetId: params.dataset_id,
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
