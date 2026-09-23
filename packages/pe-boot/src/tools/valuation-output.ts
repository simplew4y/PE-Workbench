import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preparePeDocument } from "../documents.ts";
import { readWorkbookDocument } from "../workbook-reader.ts";
import { formatWorkbookEvidenceText } from "../workbook-text.ts";
import { numberValue, openPeDataset, type SqlRow, sourceFilename } from "./database.ts";
import { type ExcelCellDetail, excelCellDetail } from "./excel-cells.ts";

export const PE_VALUATION_OUTPUT_PROMPT_SNIPPET =
	"Search valuation source text, inspect nearby cells, and select outputs using agent reasoning; search hits are not automatically classified or verified outputs";

export interface PeValuationOutputOptions {
	docId: string;
	datasetId?: string;
	sheetName?: string;
	topK?: number;
	query?: string;
	offset?: number;
}

export interface PeValuationOutputResult {
	schema_version: "1.0";
	dataset_id: string;
	document: { doc_id: string; filename: string; version_no?: number };
	status: "search_results";
	selection_method: "source_text_search";
	matches: ExcelCellDetail[];
	query: string;
	next_offset?: number;
	search_complete: boolean;
	answer_contract: string;
}

export function locatePeValuationOutputs(
	cwd: string,
	options: PeValuationOutputOptions,
	signal?: AbortSignal,
): PeValuationOutputResult {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const document = connection.database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
			.get(connection.datasetId, options.docId) as SqlRow | undefined;
		if (!document) throw new Error("Workbook document not found");
		const query = options.query?.trim();
		if (!query) throw new Error("query is required; search for literal labels in the workbook's language");
		const result = readWorkbookDocument(connection.database, connection.datasetId, options.docId, {
			action: "search",
			query,
			sheet: options.sheetName,
			limit: options.topK ?? 10,
			offset: options.offset ?? 0,
		});
		const matches = (result.cells as SqlRow[]).map((cell) => excelCellDetail({ ...document, ...cell }));
		return {
			schema_version: "1.0",
			dataset_id: connection.datasetId,
			document: {
				doc_id: options.docId,
				filename: sourceFilename(document),
				version_no: numberValue(document, "version_no"),
			},
			status: "search_results",
			selection_method: "source_text_search",
			query,
			matches,
			...(typeof result.next_offset === "number" ? { next_offset: result.next_offset } : {}),
			search_complete: result.complete === true,
			answer_contract:
				"Read matching regions and choose the output, label, period and unit from original cells. Change query or continue with next_offset when needed. Interpret business roles at query time. Use pe_formula_trace only for selected formulas. A completed text search does not prove complete valuation coverage or recalculation.",
		};
	} finally {
		connection.database.close();
	}
}

export const peValuationOutputTool = defineTool({
	name: "pe_valuation_output_locate",
	label: "PE Valuation Output Locate",
	description:
		"Search one workbook for source text used to locate valuation outputs. Returns original cell locations, without inferred roles, ranking, periods or units.",
	promptSnippet: PE_VALUATION_OUTPUT_PROMPT_SNIPPET,
	parameters: Type.Object({
		doc_id: Type.String({ minLength: 1 }),
		dataset_id: Type.Optional(Type.String()),
		query: Type.String({
			minLength: 1,
			description:
				"Literal source text in the workbook's language. A query with no matches does not prove the model has no valuation outputs; try shorter or alternate labels.",
		}),
		sheet_name: Type.Optional(Type.String()),
		top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		await preparePeDocument(ctx.cwd, { docId: params.doc_id, datasetId: params.dataset_id }, signal);
		const result = locatePeValuationOutputs(
			ctx.cwd,
			{
				docId: params.doc_id,
				datasetId: params.dataset_id,
				sheetName: params.sheet_name,
				query: params.query,
				topK: params.top_k,
				offset: params.offset,
			},
			signal,
		);
		const rendered = formatWorkbookEvidenceText(result as unknown as Record<string, unknown>, [
			"status",
			"selection_method",
			"search_complete",
		]);
		return { content: [{ type: "text", text: rendered.text }], details: { ...result, model_text: rendered.summary } };
	},
});
