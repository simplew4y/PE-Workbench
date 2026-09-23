import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument, WorkbookRequestProperties } from "../workbook-reader.ts";
import { formatWorkbookCellsText } from "../workbook-text.ts";
import { numberValue, openPeDataset, type SqlRow, sourceFilename, textValue } from "./database.ts";
import { excelCellDetail, parseExcelCellRange } from "./excel-cells.ts";

const DEFAULT_MAX_CELLS = 200;
const MAX_CELLS = 500;

export const PE_EXCEL_RANGE_PROMPT_SNIPPET =
	"Read original Excel cells, formulas, saved values and formats as compact text with continuation offsets; interpret units from source context";

export interface PeExcelRangeOptions {
	docId: string;
	sheetName?: string;
	cellRange?: string;
	ranges?: Array<{ sheet: string; range: string }>;
	datasetId?: string;
	maxCells?: number;
	offset?: number;
}

export function getPeExcelRange(
	cwd: string,
	options: PeExcelRangeOptions,
	signal?: AbortSignal,
): Record<string, unknown> {
	const docId = options.docId.trim();
	const sheetName = options.sheetName?.trim() ?? "";
	const cellRange = options.cellRange?.trim() ?? "";
	if (!docId) throw new Error("doc_id is required");
	if (!options.ranges?.length && !sheetName) throw new Error("sheet_name or ranges is required");
	const bounds = parseExcelCellRange(cellRange);
	if (!options.ranges?.length && !bounds)
		throw new Error("cell_range must be one A1 cell or A1:B2 range without a sheet prefix");
	const maxCells = Math.max(1, Math.min(MAX_CELLS, Math.trunc(options.maxCells ?? DEFAULT_MAX_CELLS)));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const document = connection.database
			.prepare(
				`SELECT d.doc_id, d.logical_doc_id, d.version_no, d.original_filename, d.source_relpath,
				        d.file_type, d.doc_type, d.document_date, d.parser_name, d.parser_version
				 FROM documents d
				 WHERE d.dataset_id = ? AND d.doc_id = ?
				   AND d.deleted_at IS NULL
				   AND COALESCE(d.is_current, 1) = 1
				   AND COALESCE(d.lifecycle_state, 'active') = 'active'`,
			)
			.get(connection.datasetId, docId) as SqlRow | undefined;
		if (!document) throw new Error(`active document not found in the current dataset: ${docId}`);
		const documentInfo = {
			doc_id: textValue(document, "doc_id"),
			logical_doc_id: textValue(document, "logical_doc_id"),
			filename: sourceFilename(document),
			file_type: textValue(document, "file_type"),
			doc_type: textValue(document, "doc_type"),
			document_date: textValue(document, "document_date"),
			version_no: numberValue(document, "version_no"),
			parser_name: textValue(document, "parser_name"),
			parser_version: textValue(document, "parser_version"),
		};
		if (options.ranges?.length) {
			const result = readWorkbookDocument(connection.database, connection.datasetId, docId, {
				action: "read",
				ranges: options.ranges,
				limit: maxCells,
				offset: options.offset ?? 0,
			});
			return {
				...result,
				dataset_id: connection.datasetId,
				document: documentInfo,
				cells: (result.cells as SqlRow[]).map(excelCellDetail),
				truncated: result.complete !== true,
				answer_contract:
					"Treat formulas and cached values as distinct fields. Cite decisive cells with their evidence_id. A present cache is not proof that Excel recalculated it recently.",
			};
		}
		if (!bounds) throw new Error("A valid cell_range is required");

		const sheet = connection.database
			.prepare(
				`SELECT sheet_index, sheet_name, sheet_role, sheet_state, used_range,
				        row_count, col_count, non_empty_cell_count, formula_count, formula_density
				 FROM excel_sheets
				 WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?`,
			)
			.get(connection.datasetId, docId, sheetName) as SqlRow | undefined;
		if (!sheet) throw new Error(`Excel sheet not found in active document ${docId}: ${sheetName}`);

		const result = readWorkbookDocument(connection.database, connection.datasetId, docId, {
			action: "read",
			sheet: sheetName,
			range: cellRange,
			limit: maxCells,
			offset: options.offset ?? 0,
		});
		const cells = (result.cells as SqlRow[]).map(excelCellDetail);
		const matchingCellCount = Number(result.matching_cell_count);
		const requestedCellCount = (bounds.rowEnd - bounds.rowStart + 1) * (bounds.columnEnd - bounds.columnStart + 1);
		return {
			...result,
			dataset_id: connection.datasetId,
			document: documentInfo,
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
			blank_cell_count: Math.max(0, requestedCellCount - Number(result.non_empty_cell_count)),
			returned_cell_count: cells.length,
			truncated: result.complete !== true,
			cells,
			answer_contract:
				"Treat formulas and cached values as distinct fields. Cite decisive cells with their evidence_id. A present cache is not proof that Excel recalculated it recently.",
		};
	} finally {
		connection.database.close();
	}
}

export const peExcelRangeTool = defineTool({
	name: "pe_excel_range",
	label: "PE Excel Range",
	description:
		"Read an exact A1 range from the original workbook as compact tab-separated lines: cell, saved value, formula, notes (format, cache status, hidden/merged, comment). Output is capped by a text budget (about 32 KB); read header rows and label columns first, then narrow numeric bands, instead of whole sheets. Continue with next_offset until complete; unread or budget-omitted cells are not blank. Re-read decisive cells with include_evidence_ids=true to collect citation ids; set include_style=true only when colors matter. Conditional formatting is not evaluated. Interpret units and periods from nearby source text.",
	promptSnippet: PE_EXCEL_RANGE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({
			description: "Exact active Excel document ID returned by pe_workbook_inspect.",
			minLength: 1,
		}),
		sheet_name: Type.Optional(
			Type.String({ description: "Exact worksheet name; use with cell_range or provide ranges.", minLength: 1 }),
		),
		cell_range: Type.Optional(
			Type.String({
				description: "A single A1 reference or rectangular A1 range, such as H42 or B5:H20.",
				minLength: 1,
				maxLength: 64,
			}),
		),
		ranges: WorkbookRequestProperties.ranges,
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		max_cells: Type.Optional(
			Type.Integer({
				description: `Maximum source cells returned, including styled/annotated blanks. Defaults to ${DEFAULT_MAX_CELLS}; maximum ${MAX_CELLS}. The text budget may return fewer; follow next_offset.`,
				minimum: 1,
				maximum: MAX_CELLS,
			}),
		),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "Continuation offset returned as next_offset." })),
		include_style: Type.Optional(
			Type.Boolean({ description: "Add static font/fill colors and bold/italic to notes. Defaults to false." }),
		),
		include_evidence_ids: Type.Optional(
			Type.Boolean({
				description:
					"Emit a source: evidence_id per cell. Defaults to false because ids cost more context than the cell itself; after locating the decisive cells, re-read just those (ranges accepts scattered cells) with true to collect citations.",
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
				ranges: params.ranges,
				datasetId: params.dataset_id,
				maxCells: params.max_cells,
				offset: params.offset,
			},
			signal,
		);
		const rendered = formatWorkbookCellsText(result, {
			includeStyle: params.include_style === true,
			includeEvidenceIds: params.include_evidence_ids === true,
		});
		return {
			content: [{ type: "text", text: rendered.text }],
			details: { ...result, model_text: rendered.summary },
		};
	},
});
