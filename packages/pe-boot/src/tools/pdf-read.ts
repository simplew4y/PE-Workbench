import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
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
const MAX_ATTACHED_BYTES = 10 * 1024 * 1024;

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
	reason:
		| "attachment_limit"
		| "byte_limit"
		| "missing"
		| "outside_workspace"
		| "unsupported_format"
		| "model_unsupported"
		| "not_loaded";
}

/**
 * Page roles whose numbers live in vector drawings or bitmaps rather than in the text layer.
 * Rating-history charts also print their date and target rows misaligned in the text layer.
 */
const IMAGE_FIRST_ROLES = new Set(["exhibit_chart", "exhibit_image", "rating_history"]);

function shouldAttachImage(page: PePdfReadPage, mode: PePdfReadImageMode): boolean {
	if (mode === "never") return false;
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
	if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd) || pageStart < 1 || pageEnd < pageStart)
		throw new Error("page range is invalid");
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
				path: page.page_image_paths[page.page_image_paths.length - 1] ?? "",
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
			attached_page_images: [],
			omitted_page_images: candidateImages.map((image) => ({ ...image, reason: "not_loaded" as const })),
			answer_contract:
				"Interpret complete pages and neighboring context; put the exact markdown_citation after each supported claim. Only attached_page_images were delivered as image blocks. Inspect omitted_page_images reasons before claiming visual verification. Never infer chart values from axis labels alone; when images are unavailable report that limitation.",
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
		const images = attachPePdfImages(ctx.cwd, result, ctx.model?.input.includes("image") === true, signal);
		const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
			{ type: "text", text: JSON.stringify(result) },
			...images,
		];
		return { content, details: result };
	},
});

/** Load bounded images and update delivery metadata only after reading the actual bytes. */
export function attachPePdfImages(cwd: string, result: PePdfReadResult, supportsImages: boolean, signal?: AbortSignal) {
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	const candidates = result.omitted_page_images.filter((image) => image.reason === "not_loaded");
	result.omitted_page_images = result.omitted_page_images.filter((image) => image.reason !== "not_loaded");
	const workspaceRoot = realpathSync(cwd);
	let totalBytes = 0;
	for (const candidate of candidates) {
		signal?.throwIfAborted();
		const { reason: _reason, ...image } = candidate;
		let reason: PePdfOmittedImage["reason"] | undefined;
		if (!supportsImages) reason = "model_unsupported";
		else if (result.attached_page_images.length >= MAX_ATTACHED_IMAGES) reason = "attachment_limit";
		if (!reason) {
			let descriptor: number | undefined;
			try {
				if (!image.path) throw new Error("Missing page image");
				const absolute = realpathSync(resolve(workspaceRoot, image.path));
				const inside = relative(workspaceRoot, absolute);
				const extension = extname(absolute).toLocaleLowerCase("und");
				if (!inside || inside.startsWith("..") || isAbsolute(inside)) reason = "outside_workspace";
				else if (![".png", ".jpg", ".jpeg"].includes(extension)) reason = "unsupported_format";
				else {
					descriptor = openSync(absolute, "r");
					const stat = fstatSync(descriptor);
					if (!stat.isFile()) reason = "missing";
					else if (stat.size > MAX_ATTACHED_BYTES - totalBytes) reason = "byte_limit";
					else {
						const bytes = Buffer.alloc(stat.size);
						let offset = 0;
						while (offset < bytes.length) {
							const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
							if (!count) throw new Error("Incomplete page image");
							offset += count;
						}
						const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
						const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
						if (!png && !jpeg) reason = "unsupported_format";
						else {
							totalBytes += bytes.length;
							content.push({
								type: "text",
								text: `Page image: ${result.document.filename} p.${image.page_number} (${image.page_role})`,
							});
							content.push({
								type: "image",
								data: bytes.toString("base64"),
								mimeType: png ? "image/png" : "image/jpeg",
							});
							result.attached_page_images.push(image);
						}
					}
				}
			} catch {
				reason = "missing";
			} finally {
				if (descriptor !== undefined) closeSync(descriptor);
			}
		}
		if (reason) result.omitted_page_images.push({ ...image, reason });
	}
	return content;
}
