import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { numberValue, openPeDataset, pdfDocumentSelection, type SqlRow, textValue } from "./database.ts";

export const PE_PDF_LIST_PROMPT_SNIPPET =
	"List the project's PDF documents with title, brokerage, date, rating, target price, page count, and page-role summary; call it first to decide which documents to search or read";

export interface PePdfListOptions {
	datasetId?: string;
	includeHistorical?: boolean;
}

export interface PePdfListDocument {
	doc_id: string;
	version_no: number;
	is_current: boolean;
	filename: string;
	status: string;
	title?: string;
	brokerage?: string;
	document_date?: string;
	rating?: string;
	target_price?: string;
	page_count: number;
	exhibit_count: number;
	needs_ocr_page_count: number;
	page_roles: Record<string, number>;
	document_markdown_path?: string;
	warnings: string[];
}

export interface PePdfListResult {
	dataset_id: string;
	document_count: number;
	documents: PePdfListDocument[];
	hint: string;
}

function jsonArrayLength(value: string | undefined): number {
	if (!value) return 0;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}

function jsonStringArray(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function documentColumns(database: DatabaseSync): Set<string> {
	return new Set(
		database
			.prepare("PRAGMA table_info(documents)")
			.all()
			.map((row) => String((row as SqlRow).name)),
	);
}

export function listPePdfDocuments(cwd: string, options: PePdfListOptions = {}): PePdfListResult {
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		const { database, datasetId } = connection;
		const columns = documentColumns(database);
		const optional = (column: string, alias = column): string =>
			`${columns.has(column) ? `d.${column}` : "NULL"} AS ${alias}`;
		const selection = pdfDocumentSelection(database, Boolean(options.includeHistorical));
		const rows = database
			.prepare(
				`SELECT d.doc_id, ${selection.versionNo} AS version_no, d.original_filename, d.status, d.page_count,
				        ${optional("is_current")}, ${optional("title")}, ${optional("brokerage")}, ${optional("document_date")},
				        ${optional("rating")}, ${optional("target_price")}, ${optional("exhibits_json")},
				        ${optional("document_markdown_path")}, ${optional("warnings_json")}
				 FROM documents d
				 WHERE d.dataset_id=? AND ${selection.predicate}
				 ORDER BY CASE WHEN ${columns.has("document_date") ? "COALESCE(d.document_date,'')" : "''"}='' THEN 1 ELSE 0 END,
				          ${columns.has("document_date") ? "d.document_date" : "''"} DESC, d.original_filename`,
			)
			.all(datasetId) as SqlRow[];
		const roleRows = database
			.prepare(
				`SELECT p.doc_id, p.role, COUNT(*) AS n, SUM(CASE WHEN p.text_quality='needs_ocr' THEN 1 ELSE 0 END) AS ocr
				 FROM pdf_pages p JOIN documents d ON d.doc_id=p.doc_id
				 WHERE d.dataset_id=?
				 GROUP BY p.doc_id, p.role`,
			)
			.all(datasetId) as SqlRow[];
		const roles = new Map<string, { roles: Record<string, number>; ocr: number }>();
		for (const row of roleRows) {
			const docId = textValue(row, "doc_id") ?? "";
			const entry = roles.get(docId) ?? { roles: {}, ocr: 0 };
			entry.roles[textValue(row, "role") ?? "body"] = numberValue(row, "n") ?? 0;
			entry.ocr += numberValue(row, "ocr") ?? 0;
			roles.set(docId, entry);
		}
		const documents = rows.map((row): PePdfListDocument => {
			const docId = textValue(row, "doc_id") ?? "";
			const summary = roles.get(docId) ?? { roles: {}, ocr: 0 };
			const optionalText = (key: string): string | undefined => textValue(row, key);
			return {
				doc_id: docId,
				version_no: numberValue(row, "version_no") ?? 1,
				is_current: (numberValue(row, "is_current") ?? 1) === 1,
				filename: textValue(row, "original_filename") ?? "unknown.pdf",
				status: textValue(row, "status") ?? "unknown",
				...(optionalText("title") ? { title: optionalText("title") } : {}),
				...(optionalText("brokerage") ? { brokerage: optionalText("brokerage") } : {}),
				...(optionalText("document_date") ? { document_date: optionalText("document_date") } : {}),
				...(optionalText("rating") ? { rating: optionalText("rating") } : {}),
				...(optionalText("target_price") ? { target_price: optionalText("target_price") } : {}),
				page_count: numberValue(row, "page_count") ?? 0,
				exhibit_count: jsonArrayLength(optionalText("exhibits_json")),
				needs_ocr_page_count: summary.ocr,
				page_roles: summary.roles,
				...(optionalText("document_markdown_path")
					? { document_markdown_path: optionalText("document_markdown_path") }
					: {}),
				warnings: jsonStringArray(optionalText("warnings_json")),
			};
		});
		return {
			dataset_id: datasetId,
			document_count: documents.length,
			documents,
			hint: "Metadata comes from cover-page rules and may be blank or imperfect; confirm decisive values on the page. Only status completed or completed_with_warnings documents are searchable. Use pe_pdf_search with document_name to stay inside one document, or read document_markdown_path with native read for the whole document.",
		};
	} finally {
		connection.database.close();
	}
}

export const pePdfListTool = defineTool({
	name: "pe_pdf_list",
	label: "PE PDF List",
	description:
		"List every PDF in the current project with its immutable doc_id, filename, title, brokerage, report date, rating, target price, page count, exhibit count, page-role counts (cover, body, exhibit_chart, exhibit_image, table_heavy, rating_history, valuation_method, disclosure_boilerplate), OCR-needed pages, and processing status. Call it before searching so you know which documents exist and which to target.",
	promptSnippet: PE_PDF_LIST_PROMPT_SNIPPET,
	parameters: Type.Object({
		include_historical: Type.Optional(
			Type.Boolean({ description: "Also list superseded document versions. Defaults to current versions only." }),
		),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = listPePdfDocuments(ctx.cwd, {
			datasetId: params.dataset_id,
			includeHistorical: params.include_historical,
		});
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
