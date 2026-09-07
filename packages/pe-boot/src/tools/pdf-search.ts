import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	numberValue,
	openPeDataset,
	pdfDocumentSelection,
	matchPdfDocumentNames,
	type SqlRow,
	sourceCitation,
	sourceMarkdownCitation,
	textValue,
} from "./database.ts";

const DEFAULT_MAX_PAGES = 40;
const MAX_MAX_PAGES = 200;
const DEFAULT_MAX_LINES_PER_PAGE = 3;
const MAX_MAX_LINES_PER_PAGE = 20;
const MAX_QUERIES = 8;
const MAX_LINE_CHARS = 240;
const DISCLOSURE_ROLE = "disclosure_boilerplate";

export const PE_PDF_SEARCH_PROMPT_SNIPPET =
	"Grep-style literal search over page text of the project's PDFs: every matched page in document order with its matched lines and citations, no ranking";

export interface PePdfSearchOptions {
	queries: string[];
	documentName?: string;
	roles?: string[];
	includeDisclosure?: boolean;
	maxPages?: number;
	maxLinesPerPage?: number;
	datasetId?: string;
}

export interface PePdfSearchLine {
	line_number: number;
	text: string;
	matched_queries: string[];
}

export interface PePdfSearchPage {
	evidence_id: string;
	page_number: number;
	page_role: string;
	text_quality: string;
	page_header: string;
	matched_queries: string[];
	matched_line_count: number;
	lines: PePdfSearchLine[];
	citation: string;
	markdown_citation: string;
	page_image_paths: string[];
}

export interface PePdfSearchDocument {
	doc_id: string;
	version_no: number;
	filename: string;
	title?: string;
	page_count: number;
	matched_page_count: number;
	shown_page_count: number;
	pages: PePdfSearchPage[];
	folded_disclosure_pages: number[];
	document_markdown_path: string;
}

export interface PePdfSearchResult {
	dataset_id: string;
	queries: string[];
	document_name?: string;
	roles?: string[];
	documents: PePdfSearchDocument[];
	matched_document_count: number;
	matched_page_count: number;
	shown_page_count: number;
	truncated: boolean;
	answer_contract: string;
	hint: string;
}

interface CandidatePage {
	row: SqlRow;
	lines: PePdfSearchLine[];
	matchedQueries: Set<string>;
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

function normalizeQueries(values: readonly string[]): string[] {
	const queries: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const query = normalizeText(value);
		const key = query.toLocaleLowerCase("und");
		if (!query || seen.has(key)) continue;
		seen.add(key);
		queries.push(query);
	}
	if (queries.length === 0) throw new Error("queries must contain at least one non-empty search phrase");
	if (queries.length > MAX_QUERIES) throw new Error(`queries must not contain more than ${MAX_QUERIES} phrases`);
	return queries;
}

function normalizeRoles(values: readonly string[] | undefined): string[] | undefined {
	if (!values) return undefined;
	const roles = [...new Set(values.map((value) => normalizeText(value).toLocaleLowerCase("und")).filter(Boolean))];
	return roles.length > 0 ? roles : undefined;
}

function assertPageRetrievalSchema(database: DatabaseSync): void {
	for (const table of ["documents", "pdf_pages", "pdf_pages_fts"] as const) {
		if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name=?").get(table)) {
			throw new Error(`PE PDF retrieval requires the page-level Pipeline table ${table}`);
		}
	}
	const pageTextColumn = database.prepare("SELECT 1 FROM pragma_table_info('pdf_pages') WHERE name='page_text'").get();
	if (!pageTextColumn)
		throw new Error("PE PDF retrieval requires the page-level Pipeline schema; rebuild this project");
}

/** JSON array of resolved file names for `IN (SELECT value FROM json_each(?))`, or null for no filter. */
function documentFilter(database: DatabaseSync, datasetId: string, value: string | undefined): string | null {
	const requested = normalizeText(value);
	if (!requested) return null;
	return JSON.stringify(matchPdfDocumentNames(database, datasetId, requested));
}

function literalFtsQuery(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

const PAGE_COLUMNS = `p.page_id, p.page_number, p.page_text, p.page_header, p.role, p.text_quality, p.image_paths_json,
	        d.doc_id, d.original_filename, d.title, d.page_count, d.document_markdown_path`;

/** FTS5 trigram recall for phrases of three or more characters. */
function ftsRows(
	database: DatabaseSync,
	datasetId: string,
	query: string,
	documentFilterJson: string | null,
): SqlRow[] {
	if (Array.from(query).length < 3) return [];
	const selection = pdfDocumentSelection(database);
	return database
		.prepare(
			`SELECT ${PAGE_COLUMNS}, ${selection.versionNo} AS version_no
			 FROM pdf_pages_fts
			 JOIN pdf_pages p ON p.page_id=pdf_pages_fts.page_id
			 JOIN documents d ON d.doc_id=p.doc_id AND d.doc_id=pdf_pages_fts.doc_id
			 WHERE pdf_pages_fts MATCH ? AND d.dataset_id=?
			   AND ${selection.predicate}
			   AND d.status IN ('completed', 'completed_with_warnings')
			   AND (? IS NULL OR d.original_filename IN (SELECT value FROM json_each(?)))`,
		)
		.all(literalFtsQuery(query), datasetId, documentFilterJson, documentFilterJson ?? "[]") as SqlRow[];
}

/** Substring recall covers short terms and anything the trigram index cannot express. */
function substringRows(
	database: DatabaseSync,
	datasetId: string,
	query: string,
	documentFilterJson: string | null,
): SqlRow[] {
	const selection = pdfDocumentSelection(database);
	return database
		.prepare(
			`SELECT ${PAGE_COLUMNS}, ${selection.versionNo} AS version_no
			 FROM pdf_pages p
			 JOIN documents d ON d.doc_id=p.doc_id
			 WHERE d.dataset_id=?
			   AND ${selection.predicate}
			   AND d.status IN ('completed', 'completed_with_warnings')
			   AND (? IS NULL OR d.original_filename IN (SELECT value FROM json_each(?)))
			   AND instr(lower(p.page_text), lower(?)) > 0`,
		)
		.all(datasetId, documentFilterJson, documentFilterJson ?? "[]", query) as SqlRow[];
}

function comparable(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("und");
}

/** `firstMatchIndex` must be an offset into `text` itself, not into a folded or untrimmed copy. */
function trimLine(text: string, firstMatchIndex: number): string {
	if (text.length <= MAX_LINE_CHARS) return text;
	const start = Math.max(0, Math.min(firstMatchIndex - Math.floor(MAX_LINE_CHARS / 3), text.length - MAX_LINE_CHARS));
	const end = Math.min(text.length, start + MAX_LINE_CHARS);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** A query paired with its case-folded form, normalized once per search instead of once per line. */
interface Needle {
	query: string;
	folded: string;
}

/** Every line containing at least one query, in page order, like grep output. */
function matchedLines(pageText: string, needles: readonly Needle[]): PePdfSearchLine[] {
	const lines: PePdfSearchLine[] = [];
	pageText.split(/\r?\n/u).forEach((rawLine, index) => {
		// Trim first so the match offsets below index the same string trimLine slices.
		const line = rawLine.trim();
		const haystack = comparable(line);
		const matched: string[] = [];
		let firstIndex = Number.POSITIVE_INFINITY;
		for (const needle of needles) {
			const position = haystack.indexOf(needle.folded);
			if (position < 0) continue;
			matched.push(needle.query);
			firstIndex = Math.min(firstIndex, position);
		}
		if (matched.length > 0) {
			lines.push({ line_number: index + 1, text: trimLine(line, firstIndex), matched_queries: matched });
		}
	});
	return lines;
}

/** Keep the lines that cover the most queries, then restore page order. */
function selectLines(lines: PePdfSearchLine[], limit: number): PePdfSearchLine[] {
	if (lines.length <= limit) return lines;
	return [...lines]
		.map((line, index) => ({ line, index }))
		.sort(
			(left, right) =>
				right.line.matched_queries.length - left.line.matched_queries.length || left.index - right.index,
		)
		.slice(0, limit)
		.sort((left, right) => left.index - right.index)
		.map(({ line }) => line);
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

function searchPage(candidate: CandidatePage, filename: string, maxLinesPerPage: number): PePdfSearchPage {
	const pageId = textValue(candidate.row, "page_id") ?? "";
	const evidenceId = `page:${pageId}`;
	const pageNumber = numberValue(candidate.row, "page_number") ?? 0;
	const citationRow: SqlRow = { original_filename: filename, page_start: pageNumber, page_end: pageNumber };
	return {
		evidence_id: evidenceId,
		page_number: pageNumber,
		page_role: textValue(candidate.row, "role") ?? "body",
		text_quality: textValue(candidate.row, "text_quality") ?? "passed",
		page_header: textValue(candidate.row, "page_header") ?? "",
		matched_queries: [...candidate.matchedQueries],
		matched_line_count: candidate.lines.length,
		lines: selectLines(candidate.lines, maxLinesPerPage),
		citation: sourceCitation(citationRow),
		markdown_citation: sourceMarkdownCitation(citationRow, evidenceId),
		page_image_paths: jsonStringArray(textValue(candidate.row, "image_paths_json")),
	};
}

export function searchPePdfPages(cwd: string, options: PePdfSearchOptions, signal?: AbortSignal): PePdfSearchResult {
	const queries = normalizeQueries(options.queries);
	const roles = normalizeRoles(options.roles);
	const includeDisclosure = Boolean(options.includeDisclosure) || (roles?.includes(DISCLOSURE_ROLE) ?? false);
	const maxPages = Math.max(1, Math.min(MAX_MAX_PAGES, Math.trunc(options.maxPages ?? DEFAULT_MAX_PAGES)));
	const maxLinesPerPage = Math.max(
		1,
		Math.min(MAX_MAX_LINES_PER_PAGE, Math.trunc(options.maxLinesPerPage ?? DEFAULT_MAX_LINES_PER_PAGE)),
	);
	const needles: Needle[] = queries.map((query) => ({ query, folded: comparable(query) }));
	const connection = openPeDataset(cwd, options.datasetId);
	try {
		assertPageRetrievalSchema(connection.database);
		const documentName = documentFilter(connection.database, connection.datasetId, options.documentName);
		const candidates = new Map<string, CandidatePage>();
		for (const query of queries) {
			signal?.throwIfAborted();
			let rows: SqlRow[] = [];
			try {
				rows = ftsRows(connection.database, connection.datasetId, query, documentName);
			} catch {
				// Substring recall below remains available when FTS rejects an unusual query.
			}
			const knownPageIds = new Set(rows.map((row) => textValue(row, "page_id")));
			for (const row of substringRows(connection.database, connection.datasetId, query, documentName)) {
				if (!knownPageIds.has(textValue(row, "page_id"))) rows.push(row);
			}
			for (const row of rows) {
				const pageId = textValue(row, "page_id");
				if (!pageId || candidates.has(pageId)) continue;
				// Line matching in JS is the source of truth; SQL recall only narrows the candidate set.
				const lines = matchedLines(textValue(row, "page_text") ?? "", needles);
				if (lines.length === 0) continue;
				const matchedQueries = new Set<string>();
				for (const line of lines) for (const matched of line.matched_queries) matchedQueries.add(matched);
				candidates.set(pageId, { row, lines, matchedQueries });
			}
		}

		const byDocument = new Map<string, CandidatePage[]>();
		for (const candidate of candidates.values()) {
			const role = textValue(candidate.row, "role") ?? "body";
			if (roles && !roles.includes(role)) continue;
			const docId = textValue(candidate.row, "doc_id") ?? "";
			const group = byDocument.get(docId) ?? [];
			group.push(candidate);
			byDocument.set(docId, group);
		}

		const documents: PePdfSearchDocument[] = [];
		let matchedPageCount = 0;
		let shownPageCount = 0;
		let truncated = false;
		const orderedGroups = [...byDocument.values()].sort((left, right) => {
			const difference = right.length - left.length;
			if (difference !== 0) return difference;
			return (textValue(left[0].row, "original_filename") ?? "").localeCompare(
				textValue(right[0].row, "original_filename") ?? "",
			);
		});
		for (const group of orderedGroups) {
			group.sort(
				(left, right) => (numberValue(left.row, "page_number") ?? 0) - (numberValue(right.row, "page_number") ?? 0),
			);
			const first = group[0].row;
			const filename = textValue(first, "original_filename") ?? "unknown.pdf";
			const title = textValue(first, "title");
			const pages: PePdfSearchPage[] = [];
			const folded: number[] = [];
			for (const candidate of group) {
				matchedPageCount += 1;
				if (!includeDisclosure && textValue(candidate.row, "role") === DISCLOSURE_ROLE) {
					folded.push(numberValue(candidate.row, "page_number") ?? 0);
					continue;
				}
				if (shownPageCount >= maxPages) {
					truncated = true;
					continue;
				}
				pages.push(searchPage(candidate, filename, maxLinesPerPage));
				shownPageCount += 1;
			}
			documents.push({
				doc_id: textValue(first, "doc_id") ?? "",
				version_no: numberValue(first, "version_no") ?? 1,
				filename,
				...(title ? { title } : {}),
				page_count: numberValue(first, "page_count") ?? 0,
				matched_page_count: group.length,
				shown_page_count: pages.length,
				pages,
				folded_disclosure_pages: folded,
				document_markdown_path: textValue(first, "document_markdown_path") ?? "",
			});
		}

		return {
			dataset_id: connection.datasetId,
			queries,
			...(options.documentName ? { document_name: options.documentName } : {}),
			...(roles ? { roles } : {}),
			documents,
			matched_document_count: documents.length,
			matched_page_count: matchedPageCount,
			shown_page_count: shownPageCount,
			truncated,
			answer_contract:
				"Matched lines are locators, not evidence. Read decisive pages with pe_pdf_read before answering. Put the exact markdown_citation immediately after each material sourced claim and never expose a bare evidence_id.",
			hint: "Search is literal and case-insensitive over page text only; it does not inject domain synonyms and does not match file names, titles, or page headers, so find documents with pe_pdf_list instead. Every matched page is listed in document and page order without ranking. Disclosure pages are folded into folded_disclosure_pages unless include_disclosure is true or roles names them. When truncated is true, narrow with document_name or roles, or raise max_pages.",
		};
	} finally {
		connection.database.close();
	}
}

export const pePdfSearchTool = defineTool({
	name: "pe_pdf_search",
	label: "PE PDF Search",
	description:
		"Grep-style search over the page text of current, active PDFs in the project. Supply one to eight literal terms or phrases; use variants when terminology is uncertain. Returns every matched page grouped by document in page order, with the matched lines, page header (role and exhibit captions), immutable doc_id, page images, and clickable citations. Nothing is ranked. Filter by document_name or roles; disclosure pages are folded unless requested. Pass doc_id to pe_pdf_read before relying on decisive evidence.",
	promptSnippet: PE_PDF_SEARCH_PROMPT_SNIPPET,
	parameters: Type.Object({
		queries: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
			description:
				"One to eight literal search terms or phrases. Add your own Chinese, English, abbreviation, or synonym variants.",
			minItems: 1,
			maxItems: MAX_QUERIES,
		}),
		document_name: Type.Optional(
			Type.String({
				description: "Optional exact PDF filename or filename without .pdf, as shown by pe_pdf_list.",
				minLength: 1,
				maxLength: 500,
			}),
		),
		roles: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
				description:
					"Optional page roles to keep: cover, body, exhibit_chart, exhibit_image, table_heavy, rating_history, valuation_method, disclosure_boilerplate.",
				maxItems: 8,
			}),
		),
		include_disclosure: Type.Optional(
			Type.Boolean({ description: "Show disclosure_boilerplate pages instead of folding them. Defaults to false." }),
		),
		max_pages: Type.Optional(
			Type.Integer({
				description: `Maximum pages to show across all documents. Defaults to ${DEFAULT_MAX_PAGES}; maximum ${MAX_MAX_PAGES}.`,
				minimum: 1,
				maximum: MAX_MAX_PAGES,
			}),
		),
		max_lines_per_page: Type.Optional(
			Type.Integer({
				description: `Matched lines to show per page. Defaults to ${DEFAULT_MAX_LINES_PER_PAGE}; maximum ${MAX_MAX_LINES_PER_PAGE}.`,
				minimum: 1,
				maximum: MAX_MAX_LINES_PER_PAGE,
			}),
		),
		dataset_id: Type.Optional(
			Type.String({ description: "Optional dataset ID. It must match the dataset bound to the current workspace." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = searchPePdfPages(
			ctx.cwd,
			{
				queries: params.queries,
				documentName: params.document_name,
				roles: params.roles,
				includeDisclosure: params.include_disclosure,
				maxPages: params.max_pages,
				maxLinesPerPage: params.max_lines_per_page,
				datasetId: params.dataset_id,
			},
			signal,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: result,
		};
	},
});
