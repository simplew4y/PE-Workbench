import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	matchPdfDocumentNames,
	numberValue,
	openPeDataset,
	pdfDocumentSelection,
	type SqlRow,
	sourceCitation,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";

const MAX_PAGE_RANGE = 10;
const MAX_PAGE_TEXT_CHARS = 30_000;
/**
 * Rendered pages run 0.3-1.3 MB each, so an unbounded range would push tens of megabytes of
 * base64 into the transcript, where it stays for the rest of the session. Attach the first few
 * and let the agent request the rest by narrowing the range or reading page_image_paths directly.
 */
const MAX_ATTACHED_IMAGES = 3;

export const PE_PDF_READ_PROMPT_SNIPPET =
	"Read complete PDF pages by filename or immutable doc_id, including neighboring context, page images, and citations";

export type PePdfReadImageMode = "auto" | "always" | "never";

export interface PePdfReadOptions {
	documentName?: string;
	docId?: string;
	pageStart: number;
	pageEnd?: number;
	datasetId?: string;
	/** Which page images to attach as image blocks. "auto" attaches chart, screenshot, and OCR-needed pages. */
	includeImages?: PePdfReadImageMode;
}

export interface PePdfAttachedImage {
	page_number: number;
	page_role: string;
	path: string;
}

export interface PePdfOmittedImage {
	page_number: number;
	page_role: string;
	path: string;
	reason: "attachment_limit";
}

/**
 * Page roles whose numbers live in vector drawings or bitmaps rather than in the text layer.
 * Rating-history charts also print their date and target rows misaligned in the text layer.
 */
const IMAGE_FIRST_ROLES = new Set(["exhibit_chart", "exhibit_image", "rating_history"]);

function shouldAttachImage(page: PePdfReadPage, mode: PePdfReadImageMode): boolean {
	if (mode === "never" || page.page_image_paths.length === 0) return false;
	if (mode === "always") return true;
	return IMAGE_FIRST_ROLES.has(page.page_role) || page.text_quality === "needs_ocr";
}

export interface PePdfReadPage {
	evidence_id: string;
	page_number: number;
	page_role: string;
	text_quality: string;
	page_header: string;
	content: string;
	content_truncated: boolean;
	page_image_paths: string[];
	citation: string;
	markdown_citation: string;
}

export interface PePdfReadResult {
	dataset_id: string;
	document: {
		doc_id: string;
		version_no: number;
		filename: string;
		title?: string;
		page_count: number;
		document_markdown_path: string;
		layout_json_path: string;
	};
	page_start: number;
	page_end: number;
	pages: PePdfReadPage[];
	/** Page images delivered alongside this result as image blocks, in page order. */
	attached_page_images: PePdfAttachedImage[];
	/** Pages that qualified for an image but exceeded the per-call attachment limit. */
	omitted_page_images: PePdfOmittedImage[];
	answer_contract: string;
}

function requestedDocumentName(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("document_name is required");
	return normalized;
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

function pagePayload(row: SqlRow, filename: string): PePdfReadPage {
	const pageId = textValue(row, "page_id") ?? "";
	const pageNumber = numberValue(row, "page_number") ?? 0;
	const evidenceId = `page:${pageId}`;
	const citationRow: SqlRow = {
		original_filename: filename,
		page_start: pageNumber,
		page_end: pageNumber,
	};
	const fullText = textValue(row, "page_text") ?? "";
	const truncated = fullText.length > MAX_PAGE_TEXT_CHARS;
	return {
		evidence_id: evidenceId,
		page_number: pageNumber,
		page_role: textValue(row, "role") ?? "body",
		text_quality: textValue(row, "text_quality") ?? "passed",
		page_header: textValue(row, "page_header") ?? "",
		content: truncated
			? `${fullText.slice(0, MAX_PAGE_TEXT_CHARS)}\n[本页文本过长，余下内容请读取文档 Markdown。]`
			: fullText,
		content_truncated: truncated,
		page_image_paths: jsonStringArray(textValue(row, "image_paths_json")),
		citation: sourceCitation(citationRow),
		markdown_citation: sourceMarkdownCitation(citationRow, evidenceId),
	};
}

export function readPePdfPages(cwd: string, options: PePdfReadOptions, signal?: AbortSignal): PePdfReadResult {
	const requestedDocId = options.docId?.trim();
	if (!requestedDocId && !options.documentName?.trim()) throw new Error("document_name or doc_id is required");
	const documentName = options.documentName?.trim() ? requestedDocumentName(options.documentName) : undefined;
	const pageStart = Math.trunc(options.pageStart);
	const pageEnd = Math.trunc(options.pageEnd ?? pageStart);
	if (pageStart < 1 || pageEnd < pageStart) throw new Error("page range is invalid");
	if (pageEnd - pageStart + 1 > MAX_PAGE_RANGE) {
		throw new Error(`page range must not exceed ${MAX_PAGE_RANGE} pages`);
	}
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		signal?.throwIfAborted();
		const pageTextColumn = connection.database
			.prepare("SELECT 1 FROM pragma_table_info('pdf_pages') WHERE name='page_text'")
			.get();
		if (!pageTextColumn)
			throw new Error("pe_pdf_read requires the page-level PDF Pipeline schema; rebuild this project");
		const selection = pdfDocumentSelection(connection.database, Boolean(requestedDocId));
		let resolvedName: string | undefined;
		if (!requestedDocId && documentName) {
			const matches = matchPdfDocumentNames(connection.database, connection.datasetId, documentName);
			if (matches.length > 1) {
				throw new Error(
					`Ambiguous PDF filename: ${options.documentName} matches ${matches.length} documents (${matches.join(" | ")}). Give a longer fragment or the exact doc_id from pe_pdf_list.`,
				);
			}
			resolvedName = matches[0];
			if (!resolvedName) throw new Error(`PDF is not indexed in the current project: ${options.documentName}`);
		}
		const documents = connection.database
			.prepare(
				`SELECT d.doc_id, ${selection.versionNo} AS version_no, d.original_filename, d.title, d.page_count,
				        d.document_markdown_path, d.layout_json_path, d.status
				 FROM documents d
				 WHERE d.dataset_id=? AND ${requestedDocId ? "d.doc_id=?" : "d.original_filename=?"}
				   AND ${selection.predicate}`,
			)
			.all(connection.datasetId, requestedDocId ?? resolvedName ?? "") as SqlRow[];
		if (documents.length > 1)
			throw new Error(
				`Ambiguous PDF filename: ${options.documentName}. Specify the exact doc_id from pe_pdf_list or pe_pdf_search.`,
			);
		const document = documents[0];
		if (!document || !["completed", "completed_with_warnings"].includes(textValue(document, "status") ?? ""))
			throw new Error(`PDF is not indexed in the current project: ${requestedDocId ?? options.documentName}`);
		// A doc_id is authoritative; document_name is a redundant hint that must still name this document.
		// Resolving it through the same matcher keeps one normalization rule instead of an ad-hoc compare.
		if (
			requestedDocId &&
			documentName &&
			!matchPdfDocumentNames(connection.database, connection.datasetId, documentName, true).includes(
				String(document.original_filename),
			)
		)
			throw new Error("document_name does not match the selected doc_id");
		const pageCount = numberValue(document, "page_count") ?? 0;
		if (pageStart > pageCount || pageEnd > pageCount) {
			throw new Error(`requested page range exceeds the document's ${pageCount} pages`);
		}
		const docId = textValue(document, "doc_id") ?? "";
		const rows = connection.database
			.prepare(
				`SELECT page_id, page_number, page_text, page_header, role,
				        text_quality, image_paths_json
				 FROM pdf_pages
				 WHERE doc_id=? AND page_number BETWEEN ? AND ?
				 ORDER BY page_number`,
			)
			.all(docId, pageStart, pageEnd) as SqlRow[];
		if (rows.length !== pageEnd - pageStart + 1)
			throw new Error("PDF page index is incomplete; retry document processing before reading these pages");
		const filename = textValue(document, "original_filename") ?? options.documentName ?? "unknown.pdf";
		const title = textValue(document, "title");
		const imageMode: PePdfReadImageMode = options.includeImages ?? "auto";
		const pages = rows.map((row) => pagePayload(row, filename));
		const candidateImages: PePdfAttachedImage[] = pages
			.filter((page) => shouldAttachImage(page, imageMode))
			.map((page) => ({
				page_number: page.page_number,
				page_role: page.page_role,
				// The last rendering is the highest resolution (200 dpi when the page has large bitmaps).
				path: page.page_image_paths[page.page_image_paths.length - 1],
			}));
		return {
			dataset_id: connection.datasetId,
			document: {
				doc_id: docId,
				version_no: numberValue(document, "version_no") ?? 1,
				filename,
				...(title ? { title } : {}),
				page_count: pageCount,
				document_markdown_path: textValue(document, "document_markdown_path") ?? "",
				layout_json_path: textValue(document, "layout_json_path") ?? "",
			},
			page_start: pageStart,
			page_end: pageEnd,
			pages,
			attached_page_images: candidateImages.slice(0, MAX_ATTACHED_IMAGES),
			omitted_page_images: candidateImages
				.slice(MAX_ATTACHED_IMAGES)
				.map((image) => ({ ...image, reason: "attachment_limit" as const })),
			answer_contract:
				"Use the complete page text and neighboring pages to interpret evidence. Put each exact markdown_citation immediately after the claim it supports; never expose a bare evidence_id. Chart, screenshot, and OCR-needed pages arrive with their page image attached: read values from the image itself, say they are read from the chart, and never estimate them from axis labels in the text. Use native read on page_image_paths for any other page whose layout matters, including every page listed in omitted_page_images.",
		};
	} finally {
		connection.database.close();
	}
}

export const pePdfReadTool = defineTool({
	name: "pe_pdf_read",
	label: "PE PDF Read",
	description:
		"Read one to ten complete pages from a PDF in the current project. A filename selects one current active document; ambiguous names require doc_id. Pass the immutable doc_id returned by pe_pdf_search to read that exact version, including a historical version. Deleted versions are unavailable. Inspect the full page, adjacent pages, extraction quality, and page image before relying on decisive evidence.",
	promptSnippet: PE_PDF_READ_PROMPT_SNIPPET,
	parameters: Type.Object({
		document_name: Type.Optional(
			Type.String({
				description: "Exact current PDF filename, with or without .pdf. Required unless doc_id is supplied.",
				minLength: 1,
				maxLength: 500,
			}),
		),
		doc_id: Type.Optional(
			Type.String({
				description: "Exact immutable PDF document ID from pe_pdf_search. Allows historical versions.",
				minLength: 1,
				maxLength: 128,
			}),
		),
		page_start: Type.Integer({ description: "First one-based page number to read.", minimum: 1 }),
		page_end: Type.Optional(
			Type.Integer({
				description: "Last one-based page number, inclusive. Defaults to page_start; maximum range is 10 pages.",
				minimum: 1,
			}),
		),
		include_images: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("never")], {
				description:
					"Which page images to attach as image blocks. auto (default): chart, screenshot, and OCR-needed pages; always: every page in the range; never: text only.",
			}),
		),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = readPePdfPages(
			ctx.cwd,
			{
				documentName: params.document_name,
				docId: params.doc_id,
				pageStart: params.page_start,
				pageEnd: params.page_end,
				datasetId: params.dataset_id,
				includeImages: params.include_images,
			},
			signal,
		);
		const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
			{ type: "text", text: JSON.stringify(result) },
		];
		for (const image of result.attached_page_images) {
			const block = loadPageImage(ctx.cwd, image.path);
			if (!block) continue;
			content.push({
				type: "text",
				text: `Page image: ${result.document.filename} p.${image.page_number} (${image.page_role})`,
			});
			content.push(block);
		}
		return { content, details: result };
	},
});

/** Load a rendered page image from inside the workspace; anything missing or outside it is skipped. */
function loadPageImage(cwd: string, relativePath: string): { type: "image"; data: string; mimeType: string } | null {
	try {
		const workspaceRoot = realpathSync(cwd);
		const absolute = realpathSync(resolve(workspaceRoot, relativePath));
		const inside = relative(workspaceRoot, absolute);
		if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
		const extension = extname(absolute).toLocaleLowerCase("und");
		const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
		return { type: "image", data: readFileSync(absolute).toString("base64"), mimeType };
	} catch {
		return null;
	}
}
