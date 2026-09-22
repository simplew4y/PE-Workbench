import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument, type WorkbookRequest, WorkbookRequestProperties } from "../workbook-reader.ts";
import { openPeDataset, type SqlRow, sourceFilename } from "./database.ts";

export const PE_WORKBOOK_INSPECT_PROMPT_SNIPPET =
	"List active Excel workbooks and their versions, sheets, formula-cache coverage, actual occupied regions, merged cells, hidden rows/columns, names and external sources";

export interface PeWorkbookInspectOptions {
	datasetId?: string;
	docId?: string;
	includeHiddenSheets?: boolean;
	sheet?: string;
	section?: WorkbookRequest["section"];
	offset?: number;
	limit?: number;
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

function inspectWorkbook(
	database: ReturnType<typeof openPeDataset>["database"],
	datasetId: string,
	row: SqlRow,
	options: PeWorkbookInspectOptions,
): Record<string, unknown> {
	const docId = String(row.doc_id);
	const navigation = readWorkbookDocument(database, datasetId, docId, {
		action: "inspect",
		sheet: options.sheet,
		section: options.section,
		offset: options.offset,
		limit: options.limit,
	});
	const sheets = navigation.sheets as Array<Record<string, unknown>> | undefined;
	return {
		...navigation,
		doc_id: docId,
		prepared: true,
		filename: sourceFilename(row),
		version_no: row.version_no,
		...(sheets
			? {
					sheets: sheets
						.filter((sheet) => options.includeHiddenSheets !== false || sheet.sheet_state === "visible")
						.map((sheet) => ({
							...sheet,
							name: sheet.sheet_name,
							index: sheet.sheet_index,
							state: sheet.sheet_state,
						})),
				}
			: {}),
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
			requestedDocId || rows.length === 1
				? inspectWorkbook(connection.database, connection.datasetId, row, options)
				: {
						doc_id: row.doc_id,
						filename: sourceFilename(row),
						version_no: row.version_no,
						sheet_count: row.sheet_count,
						status: row.status,
					},
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
				"Use one selected doc_id for all subsequent model reads. Do not combine workbooks when selection_required is true. Search with pe_workbook_search, then read matching ranges. Interpret labels, periods and units from original context. Cache presence does not prove recalculation freshness.",
		};
	} finally {
		connection.database.close();
	}
}

export const peWorkbookInspectTool = defineTool({
	name: "pe_workbook_inspect",
	label: "PE Workbook Inspect",
	description:
		"Inspect active Excel workbooks, versions, sheets, hidden states, formula counts, formula-cache coverage, actual content regions and external dependencies. Select one immutable doc_id before reading.",
	promptSnippet: PE_WORKBOOK_INSPECT_PROMPT_SNIPPET,
	parameters: Type.Object({
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
		doc_id: Type.Optional(Type.String({ description: "Inspect one exact active workbook document ID." })),
		sheet: WorkbookRequestProperties.sheet,
		section: WorkbookRequestProperties.section,
		offset: WorkbookRequestProperties.offset,
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		include_hidden_sheets: Type.Optional(
			Type.Boolean({ description: "Include hidden and very-hidden worksheets. Defaults to true." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const options = {
			datasetId: params.dataset_id,
			docId: params.doc_id,
			includeHiddenSheets: params.include_hidden_sheets,
			sheet: params.sheet,
			section: params.section,
			offset: params.offset,
			limit: params.limit,
		};
		// Choose from the catalog before preparation; inspecting first would scan an unprepared file twice.
		const connection = openPeDataset(ctx.cwd, params.dataset_id);
		let selectedDocId: string | undefined;
		try {
			signal?.throwIfAborted();
			const rows = workbookRows(connection.database, connection.datasetId, params.doc_id?.trim() || undefined);
			if (rows.length === 1) selectedDocId = String(rows[0].doc_id);
		} finally {
			connection.database.close();
		}
		if (selectedDocId) {
			await preparePeDocument(ctx.cwd, { docId: selectedDocId, datasetId: params.dataset_id }, signal);
		}
		const result = inspectPeWorkbooks(ctx.cwd, options, signal);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
