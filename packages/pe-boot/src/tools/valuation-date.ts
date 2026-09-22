import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import {
	readWorkbookContextSource,
	type WorkbookContextSource,
	workbookContextSourceSchema,
} from "../workbook-context.ts";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { openPeDataset, type SqlRow, sourceFilename } from "./database.ts";
import { type ExcelCellDetail, excelCellDetail } from "./excel-cells.ts";

export const PE_VALUATION_DATE_PROMPT_SNIPPET =
	"Find original date text and verify agent-selected date and label cells; business date roles and normalized dates are agent interpretation, never file-timestamp inference";

export interface PeValuationDateOptions {
	docId: string;
	datasetId?: string;
	outputSheet?: string;
	query?: string;
	offset?: number;
	dateSource?: WorkbookContextSource;
	labelSource?: WorkbookContextSource;
	valuationDate?: string;
}

export type PeValuationDateStatus = "inferred" | "search_results";

export interface PeValuationDateResult {
	schema_version: "1.0";
	dataset_id: string;
	document: { doc_id: string; filename: string };
	query: string;
	source_cells: ExcelCellDetail[];
	next_offset?: number;
	status: PeValuationDateStatus;
	valuation_date?: string;
	resolution_method: "source_text_search" | "agent_interpretation_with_checked_source_text";
	evidence_ids: string[];
	answer_contract: string;
}

export function resolvePeValuationDate(
	cwd: string,
	options: PeValuationDateOptions,
	signal?: AbortSignal,
): PeValuationDateResult {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const document = connection.database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
			.get(connection.datasetId, options.docId) as SqlRow | undefined;
		if (!document) throw new Error("Workbook document not found");
		const query = options.query?.trim() ?? "";
		const selected =
			options.dateSource !== undefined || options.labelSource !== undefined || options.valuationDate !== undefined;
		let sourceCells: ExcelCellDetail[];
		let nextOffset: number | undefined;
		if (selected) {
			if (
				!options.dateSource ||
				!options.labelSource ||
				!options.valuationDate ||
				!/^\d{4}-\d{2}-\d{2}$/u.test(options.valuationDate) ||
				!Number.isFinite(Date.parse(options.valuationDate)) ||
				new Date(options.valuationDate).toISOString().slice(0, 10) !== options.valuationDate
			)
				throw new Error("Selection requires date_source, label_source and a valid YYYY-MM-DD valuation_date");
			sourceCells = [options.dateSource, options.labelSource].map((source) =>
				readWorkbookContextSource(connection.database, connection.datasetId, options.docId, source),
			);
		} else {
			if (!query) throw new Error("query is required; search for literal labels in the workbook's language");
			const found = readWorkbookDocument(connection.database, connection.datasetId, options.docId, {
				action: "search",
				query,
				sheet: options.outputSheet,
				limit: 30,
				offset: options.offset ?? 0,
			});
			sourceCells = (found.cells as SqlRow[]).map((cell) => excelCellDetail({ ...document, ...cell }));
			if (typeof found.next_offset === "number") nextOffset = found.next_offset;
		}
		return {
			schema_version: "1.0",
			dataset_id: connection.datasetId,
			document: { doc_id: options.docId, filename: sourceFilename(document) },
			query,
			source_cells: sourceCells,
			...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
			status: selected ? "inferred" : "search_results",
			...(selected ? { valuation_date: options.valuationDate } : {}),
			resolution_method: selected ? "agent_interpretation_with_checked_source_text" : "source_text_search",
			evidence_ids: selected ? sourceCells.map((cell) => cell.evidence_id) : [],
			answer_contract:
				"Original source text is checked; date normalization and business role are agent interpretation. Review the date together with its label and output context. Do not treat financial periods, forecasts, market-price dates or file timestamps as valuation dates without source evidence. This tool does not certify a valuation date or recalculate formulas.",
		};
	} finally {
		connection.database.close();
	}
}

export const peValuationDateTool = defineTool({
	name: "pe_valuation_date_resolve",
	label: "PE Valuation Date Resolve",
	description:
		"Search date source text, or check the exact date and label cells selected by the agent. Does not infer dates from filenames, timestamps or cached semantic fields.",
	promptSnippet: PE_VALUATION_DATE_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
		query: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Required when searching. Literal source text in the workbook's labels or language.",
			}),
		),
		output_sheet: Type.Optional(Type.String()),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		date_source: Type.Optional(workbookContextSourceSchema),
		label_source: Type.Optional(workbookContextSourceSchema),
		valuation_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = resolvePeValuationDate(
			ctx.cwd,
			{
				docId: params.doc_id,
				datasetId: params.dataset_id,
				outputSheet: params.output_sheet,
				query: params.query,
				offset: params.offset,
				dateSource: params.date_source,
				labelSource: params.label_source,
				valuationDate: params.valuation_date,
			},
			signal,
		);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
