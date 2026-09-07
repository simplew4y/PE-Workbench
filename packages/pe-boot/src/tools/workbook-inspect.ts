import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { numberValue, openPeDataset, type SqlRow, sourceFilename, textValue } from "./database.ts";

export const PE_WORKBOOK_INSPECT_PROMPT_SNIPPET =
	"List active Excel workbooks and their versions, sheets, formula-cache coverage, date-candidate counts, and selection warnings before locating valuation outputs";

export interface PeWorkbookInspectOptions {
	datasetId?: string;
	docId?: string;
	includeHiddenSheets?: boolean;
}

function tableExists(database: ReturnType<typeof openPeDataset>["database"], table: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function workbookRows(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	docId: string | undefined,
): SqlRow[] {
	if (!tableExists(database, "documents")) return [];
	const cached = tableExists(database, "excel_workbooks");
	const select = `SELECT d.doc_id, d.logical_doc_id, d.version_no, d.original_filename, d.source_relpath,
	                       d.file_type, d.doc_type, d.document_date, d.parser_name, d.parser_version, d.status
	                       ${
										cached
											? `, w.workbook_type, w.sheet_count, w.visible_sheet_count, w.formula_count,
	                       w.non_empty_cell_count, w.formula_density,
	                       w.metadata_json AS workbook_metadata_json`
											: ""
									}
	                FROM documents d
	                ${cached ? "LEFT JOIN excel_workbooks w ON w.doc_id = d.doc_id AND w.dataset_id = d.dataset_id" : ""}
	                WHERE d.dataset_id = ?
	                  AND d.file_type IN ('xlsx', 'xlsm')
	                  AND d.deleted_at IS NULL
	                  AND COALESCE(d.is_current, 1) = 1
	                  AND COALESCE(d.lifecycle_state, 'active') = 'active'`;
	if (docId) {
		return database
			.prepare(`${select} AND d.doc_id = ? ORDER BY d.document_date DESC, d.version_no DESC`)
			.all(datasetId, docId) as SqlRow[];
	}
	return database
		.prepare(`${select} ORDER BY d.document_date DESC, d.version_no DESC, d.original_filename`)
		.all(datasetId) as SqlRow[];
}

function jsonObjectValue(row: SqlRow, key: string): Record<string, unknown> | undefined {
	const value = textValue(row, key);
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function inspectWorkbook(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	row: SqlRow,
	includeHiddenSheets: boolean,
): Record<string, unknown> {
	const docId = textValue(row, "doc_id") ?? "";
	if (numberValue(row, "sheet_count") === undefined)
		return {
			doc_id: docId,
			filename: sourceFilename(row),
			version_no: numberValue(row, "version_no"),
			status: textValue(row, "status"),
			prepared: false,
			sheets: [],
			warnings: ["Select this doc_id to read the workbook on demand"],
		};
	const sheetRows = database
		.prepare(
			`SELECT sheet_index, sheet_name, sheet_role, sheet_state, used_range,
			        row_count, col_count, non_empty_cell_count, formula_count, formula_density
			 FROM excel_sheets
			 WHERE dataset_id = ? AND doc_id = ?
			 ORDER BY sheet_index`,
		)
		.all(datasetId, docId) as SqlRow[];
	const cacheRows = database
		.prepare(
			`SELECT formula_cache_status, COUNT(*) AS status_count
			 FROM excel_cells
			 WHERE dataset_id = ? AND doc_id = ? AND is_formula = 1
			 GROUP BY formula_cache_status
			 ORDER BY formula_cache_status`,
		)
		.all(datasetId, docId) as SqlRow[];
	const formulaCacheStatusCounts: Record<string, number> = {};
	for (const cacheRow of cacheRows) {
		formulaCacheStatusCounts[textValue(cacheRow, "formula_cache_status") ?? "unknown"] =
			numberValue(cacheRow, "status_count") ?? 0;
	}
	const dateCandidateRoleCounts: Record<string, number> = {};
	let explicitValuationDateCount = 0;
	const dateCandidateIndexAvailable = tableExists(database, "valuation_date_candidates");
	if (dateCandidateIndexAvailable) {
		const dateRows = database
			.prepare(
				`SELECT role, COUNT(*) AS candidate_count,
				        COUNT(DISTINCT normalized_date) AS distinct_date_count
				 FROM valuation_date_candidates
				 WHERE dataset_id = ? AND doc_id = ?
				 GROUP BY role`,
			)
			.all(datasetId, docId) as SqlRow[];
		for (const dateRow of dateRows) {
			const role = textValue(dateRow, "role") ?? "unknown";
			dateCandidateRoleCounts[role] = numberValue(dateRow, "candidate_count") ?? 0;
			if (role === "valuation_date") {
				explicitValuationDateCount = numberValue(dateRow, "distinct_date_count") ?? 0;
			}
		}
	}
	const warnings: string[] = [];
	const sheets = sheetRows
		.filter((sheet) => includeHiddenSheets || (textValue(sheet, "sheet_state") ?? "visible") === "visible")
		.map((sheet) => ({
			index: numberValue(sheet, "sheet_index"),
			name: textValue(sheet, "sheet_name"),
			role: textValue(sheet, "sheet_role"),
			state: textValue(sheet, "sheet_state") ?? "visible",
			used_range: textValue(sheet, "used_range"),
			row_count: numberValue(sheet, "row_count"),
			col_count: numberValue(sheet, "col_count"),
			non_empty_cell_count: numberValue(sheet, "non_empty_cell_count"),
			formula_count: numberValue(sheet, "formula_count"),
			formula_density: numberValue(sheet, "formula_density"),
		}));
	const hiddenSheetCount = sheetRows.filter(
		(sheet) => (textValue(sheet, "sheet_state") ?? "visible") !== "visible",
	).length;
	const metadata = jsonObjectValue(row, "workbook_metadata_json");
	if (hiddenSheetCount > 0) warnings.push(`${hiddenSheetCount} hidden or very-hidden sheet(s)`);
	if (typeof metadata?.external_link_count === "number" && metadata.external_link_count > 0) {
		warnings.push(`${metadata.external_link_count} external workbook link(s)`);
	}
	if (!dateCandidateIndexAvailable) {
		warnings.push("Valuation-date candidate cache is unavailable; open the workbook with pe_document_open");
	} else if (explicitValuationDateCount === 0) warnings.push("No normalized valuation-date candidate was found");
	else if (explicitValuationDateCount > 1) {
		warnings.push(
			`${explicitValuationDateCount} distinct valuation-date candidates require output-context resolution`,
		);
	}
	for (const status of ["missing", "unavailable", "error"]) {
		const count = formulaCacheStatusCounts[status] ?? 0;
		if (count > 0) warnings.push(`${count} formula cache(s) are ${status}`);
	}
	return {
		doc_id: docId,
		prepared: true,
		logical_doc_id: textValue(row, "logical_doc_id"),
		version_no: numberValue(row, "version_no"),
		status: textValue(row, "status"),
		filename: sourceFilename(row),
		file_type: textValue(row, "file_type"),
		doc_type: textValue(row, "doc_type"),
		document_date: textValue(row, "document_date"),
		parser_name: textValue(row, "parser_name"),
		parser_version: textValue(row, "parser_version"),
		workbook_type: textValue(row, "workbook_type"),
		sheet_count: numberValue(row, "sheet_count"),
		visible_sheet_count: numberValue(row, "visible_sheet_count"),
		non_empty_cell_count: numberValue(row, "non_empty_cell_count"),
		formula_count: numberValue(row, "formula_count"),
		formula_density: numberValue(row, "formula_density"),
		...(metadata ? { metadata } : {}),
		formula_cache_status_counts: formulaCacheStatusCounts,
		valuation_date_candidate_index_available: dateCandidateIndexAvailable,
		valuation_date_candidate_role_counts: dateCandidateRoleCounts,
		distinct_valuation_date_candidate_count: explicitValuationDateCount,
		hidden_sheet_count: hiddenSheetCount,
		warnings,
		sheets,
	};
}

export function inspectPeWorkbooks(
	cwd: string,
	options: PeWorkbookInspectOptions = {},
	signal?: AbortSignal,
): Record<string, unknown> {
	const requestedDocId = options.docId?.trim() || undefined;
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const rows = workbookRows(connection.database, connection.datasetId, requestedDocId);
		if (requestedDocId && rows.length === 0) {
			throw new Error(`active Excel workbook not found in the current dataset: ${requestedDocId}`);
		}
		const workbooks = rows.map((row) =>
			inspectWorkbook(connection.database, connection.datasetId, row, options.includeHiddenSheets ?? true),
		);
		const selectionRequired = !requestedDocId && workbooks.length > 1;
		const selectedDocId = requestedDocId ?? (workbooks.length === 1 ? String(workbooks[0].doc_id) : undefined);
		const warnings: string[] = [];
		if (workbooks.length === 0) warnings.push("No active uploaded Excel workbook was found");
		if (selectionRequired)
			warnings.push("Multiple active Excel workbooks exist; select one doc_id before reading cells");
		return {
			dataset_id: connection.datasetId,
			active_workbook_count: workbooks.length,
			selection_required: selectionRequired,
			...(selectedDocId ? { selected_doc_id: selectedDocId } : {}),
			warnings,
			workbooks,
			answer_contract:
				"Use one selected doc_id for all subsequent model reads. Do not combine workbooks when selection_required is true. Next call pe_valuation_output_locate; resolve dates only after it selects an output or while preserving each ambiguous output context. Cache presence does not prove recalculation freshness.",
		};
	} finally {
		connection.database.close();
	}
}

export const peWorkbookInspectTool = defineTool({
	name: "pe_workbook_inspect",
	label: "PE Workbook Inspect",
	description:
		"Inspect active Excel workbooks, versions, sheets, hidden states, formula counts, formula-cache coverage, and date-candidate counts. Call before valuation-output location and select exactly one doc_id.",
	promptSnippet: PE_WORKBOOK_INSPECT_PROMPT_SNIPPET,
	parameters: Type.Object({
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		doc_id: Type.Optional(Type.String({ description: "Inspect one exact active workbook document ID." })),
		include_hidden_sheets: Type.Optional(
			Type.Boolean({ description: "Include hidden and very-hidden worksheets. Defaults to true." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const options = {
			datasetId: params.dataset_id,
			docId: params.doc_id,
			includeHiddenSheets: params.include_hidden_sheets,
		};
		let result = inspectPeWorkbooks(ctx.cwd, options, signal);
		if (typeof result.selected_doc_id === "string") {
			await preparePeDocument(ctx.cwd, { docId: result.selected_doc_id, datasetId: params.dataset_id }, signal);
			result = inspectPeWorkbooks(ctx.cwd, options, signal);
		}
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
