import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PeSourceError, preparePeDocument } from "./documents.ts";
import { type PeSourcePayload, type PeSourceReference, parseExcelCellRange, parseSourceId } from "./source.ts";
import {
	documentFilePath,
	numberValue,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";
import { readExcelCellsByBounds } from "./tools/excel-cells.ts";

export function sourceLocationRow(reference: PeSourceReference): SqlRow {
	const { location } = reference;
	switch (location.kind) {
		case "excel":
			return { sheet_name: location.sheet, cell_range: location.range };
		case "pdf":
			return { page_start: location.pageStart, page_end: location.pageEnd };
		case "text":
			return { line_start: location.lineStart, line_end: location.lineEnd };
		case "block":
			return { block_index: location.blockIndex };
	}
}

/** Legacy IDs resolve to durable locations without changing their citation links. */
export function resolvePeEvidenceReference(cwd: string, evidenceId: string): PeSourceReference {
	const encoded = parseSourceId(evidenceId);
	if (encoded) return encoded;
	const match = /^(page|cell|fact):([A-Za-z0-9_-]{1,128})$/u.exec(evidenceId);
	if (!match) throw new PeSourceError(400, "Invalid evidence ID");
	const connection = openPeDataset(cwd);
	try {
		const exists = (table: string): boolean =>
			connection.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !==
			undefined;
		if (match[1] === "page" && exists("pdf_pages")) {
			const row = connection.database
				.prepare(
					"SELECT p.doc_id, p.page_number FROM pdf_pages p JOIN documents d ON d.doc_id=p.doc_id WHERE p.page_id=? AND d.dataset_id=?",
				)
				.get(match[2], connection.datasetId) as SqlRow | undefined;
			if (row)
				return {
					docId: String(row.doc_id),
					location: { kind: "pdf", pageStart: Number(row.page_number), pageEnd: Number(row.page_number) },
				};
		} else if (match[1] === "cell" || match[1] === "fact") {
			let row: SqlRow | undefined;
			if (exists("evidence_locations")) {
				row = connection.database
					.prepare(
						"SELECT e.doc_id, e.sheet_name, e.cell_range FROM evidence_locations e JOIN documents d ON d.doc_id=e.doc_id WHERE e.evidence_id=? AND d.dataset_id=?",
					)
					.get(evidenceId, connection.datasetId) as SqlRow | undefined;
			}
			const table = match[1] === "cell" ? "excel_cells" : "metric_facts";
			const key = match[1] === "cell" ? "cell_id" : "fact_id";
			if (!row && exists(table))
				row = connection.database
					.prepare(
						`SELECT doc_id, sheet_name, cell_ref AS cell_range FROM ${table} WHERE ${key}=? AND dataset_id=?`,
					)
					.get(match[2], connection.datasetId) as SqlRow | undefined;
			if (row)
				return {
					docId: String(row.doc_id),
					location: { kind: "excel", sheet: String(row.sheet_name), range: String(row.cell_range) },
				};
		}
		throw new PeSourceError(404, "Evidence location was not found in the current project");
	} finally {
		connection.database.close();
	}
}

/** Shared by agent tools and web previews; explicit versions may be superseded. */
export async function resolvePeEvidenceSource(
	cwd: string,
	evidenceId: string,
	signal?: AbortSignal,
): Promise<{ payload: PeSourcePayload; filePath: string }> {
	signal?.throwIfAborted();
	const reference = resolvePeEvidenceReference(cwd, evidenceId);
	const location = reference.location;
	if (location.kind === "excel") {
		const prepared = await preparePeDocument(cwd, { docId: reference.docId }, signal);
		const row = { ...prepared.document, ...sourceLocationRow(reference) };
		const bounds = parseExcelCellRange(location.range);
		if (!bounds) throw new PeSourceError(400, "Invalid Excel range");
		const connection = openPeDataset(cwd, prepared.datasetId);
		try {
			const sheet = connection.database
				.prepare("SELECT used_range FROM excel_sheets WHERE dataset_id=? AND doc_id=? AND sheet_name=?")
				.get(prepared.datasetId, reference.docId, location.sheet) as SqlRow | undefined;
			if (!sheet) throw new PeSourceError(404, "Worksheet not found in this document version");
			const used = parseExcelCellRange(textValue(sheet, "used_range"));
			if (!used || bounds.rowEnd > used.rowEnd || bounds.columnEnd > used.columnEnd)
				throw new PeSourceError(404, "Source range is outside the worksheet's used range");
			const window = {
				rowStart: Math.max(1, bounds.rowStart - 3),
				rowEnd: 0,
				columnStart: Math.max(1, bounds.columnStart - 3),
				columnEnd: 0,
			};
			window.rowEnd = Math.min(used.rowEnd, window.rowStart + 11);
			window.columnEnd = Math.min(used.columnEnd, window.columnStart + 11);
			return {
				filePath: prepared.filePath,
				payload: {
					kind: "excel",
					dataset_id: prepared.datasetId,
					doc_id: reference.docId,
					version_no: numberValue(row, "version_no") ?? 1,
					evidence_id: evidenceId,
					citation: sourceCitation(row),
					markdown_citation: sourceMarkdownCitation(row, evidenceId),
					filename: sourceFilename(row),
					warnings: prepared.warnings,
					sheet_name: location.sheet,
					cell_range: location.range,
					grid_window: {
						row_start: window.rowStart,
						row_end: window.rowEnd,
						col_start: window.columnStart,
						col_end: window.columnEnd,
					},
					cells: readExcelCellsByBounds(
						connection.database,
						prepared.datasetId,
						reference.docId,
						location.sheet,
						window,
						144,
					),
					truncated: bounds.rowEnd > window.rowEnd || bounds.columnEnd > window.columnEnd,
				},
			};
		} finally {
			connection.database.close();
		}
	}
	if (location.kind !== "pdf") throw new PeSourceError(400, "This pipeline supports PDF pages and Excel ranges");
	const connection = openPeDataset(cwd);
	try {
		const document = connection.database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=?")
			.get(connection.datasetId, reference.docId) as SqlRow | undefined;
		if (!document || textValue(document, "file_type") !== "pdf" || document.deleted_at)
			throw new PeSourceError(404, "PDF document version was not found");
		const filePath = documentFilePath(connection.workspaceRoot, document);
		const checksum = textValue(document, "checksum") ?? textValue(document, "sha256");
		if (checksum && createHash("sha256").update(readFileSync(filePath)).digest("hex") !== checksum)
			throw new PeSourceError(
				409,
				"Original document was modified; restore this version before resolving its citation",
			);
		if (location.pageEnd - location.pageStart >= 20)
			throw new PeSourceError(400, "Invalid PDF page range (maximum 20 pages)");
		const rows = connection.database
			.prepare(
				"SELECT page_number, page_text FROM pdf_pages WHERE doc_id=? AND page_number BETWEEN ? AND ? ORDER BY page_number",
			)
			.all(reference.docId, location.pageStart, location.pageEnd) as SqlRow[];
		if (rows.length !== location.pageEnd - location.pageStart + 1)
			throw new PeSourceError(404, "PDF page was not found in this document version");
		let budget = 12_000;
		let truncated = false;
		const pages = rows.map((page) => {
			const content = textValue(page, "page_text") ?? "";
			const text = content.slice(0, budget);
			budget -= text.length;
			truncated ||= text.length < content.length;
			return { page_number: Number(page.page_number), text };
		});
		const row = { ...document, ...sourceLocationRow(reference) };
		return {
			filePath,
			payload: {
				kind: "pdf",
				dataset_id: connection.datasetId,
				doc_id: reference.docId,
				version_no: numberValue(row, "version_no") ?? 1,
				evidence_id: evidenceId,
				citation: sourceCitation(row),
				markdown_citation: sourceMarkdownCitation(row, evidenceId),
				filename: sourceFilename(row),
				warnings: [],
				truncated,
				page_start: location.pageStart,
				page_end: location.pageEnd,
				pdf_pages: pages,
				content: pages.map((page) => page.text).join("\n\n"),
			},
		};
	} finally {
		connection.database.close();
	}
}

/** Cache recovery must complete before artifact writers enter a SQLite transaction. */
export async function resolvePeEvidenceSources(
	cwd: string,
	evidenceIds: readonly string[],
	signal?: AbortSignal,
): Promise<Map<string, PeSourcePayload>> {
	const sources = new Map<string, PeSourcePayload>();
	for (const id of new Set(evidenceIds.map((value) => value.trim()))) {
		signal?.throwIfAborted();
		try {
			sources.set(id, (await resolvePeEvidenceSource(cwd, id, signal)).payload);
		} catch {
			signal?.throwIfAborted();
		}
	}
	return sources;
}
