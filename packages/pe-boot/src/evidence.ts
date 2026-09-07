import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { PeSourceError, preparePeDocument } from "./documents.ts";
import { type PeSourcePayload, parseExcelCellRange, parseSourceId } from "./source.ts";
import {
	documentFilePath,
	evidenceLocator,
	openPeDataset,
	type SqlRow,
	sourceCitation,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";
import { readExcelCellsByBounds } from "./tools/excel-cells.ts";

interface ResolvedEvidence {
	kind: "pdf" | "excel";
	docId: string;
	pageStart?: number;
	pageEnd?: number;
	sheet?: string;
	range?: string;
}

export interface PeEvidenceRecord {
	evidenceId: string;
	citation: string;
	filename: string;
	locator: ReturnType<typeof evidenceLocator>;
}

export function resolvePeEvidenceRecord(
	database: DatabaseSync,
	datasetId: string,
	evidenceId: string,
): PeEvidenceRecord | undefined {
	let row: SqlRow | undefined;
	const page = /^page:([A-Za-z0-9_-]{1,128})$/u.exec(evidenceId);
	if (page) {
		row = database
			.prepare(
				`SELECT d.original_filename,d.source_relpath,p.page_number AS page_start,p.page_number AS page_end
				 FROM pdf_pages p JOIN documents d ON d.doc_id=p.doc_id
				 WHERE d.dataset_id=? AND d.file_type='pdf' AND p.page_id=?`,
			)
			.get(datasetId, page[1]) as SqlRow | undefined;
	} else {
		const source = parseSourceId(evidenceId);
		const bounds = parseExcelCellRange(source?.range);
		if (!source || !bounds) return undefined;
		const document = database
			.prepare(
				`SELECT original_filename,source_relpath FROM documents
				 WHERE dataset_id=? AND doc_id=? AND file_type IN ('xlsx','xlsm')`,
			)
			.get(datasetId, source.docId) as SqlRow | undefined;
		if (!document) return undefined;
		const cell = database
			.prepare(
				`SELECT 1 FROM excel_cells WHERE dataset_id=? AND doc_id=? AND sheet_name=?
				 AND row_index BETWEEN ? AND ? AND col_index BETWEEN ? AND ? LIMIT 1`,
			)
			.get(
				datasetId,
				source.docId,
				source.sheet,
				bounds.rowStart,
				bounds.rowEnd,
				bounds.columnStart,
				bounds.columnEnd,
			);
		if (!cell) return undefined;
		row = { ...document, sheet_name: source.sheet, cell_range: source.range };
	}
	if (!row) return undefined;
	return {
		evidenceId,
		citation: sourceCitation(row),
		filename: sourceFilename(row),
		locator: evidenceLocator(row),
	};
}

export function resolvePeEvidenceReference(cwd: string, evidenceId: string): ResolvedEvidence {
	const encoded = parseSourceId(evidenceId);
	if (encoded) return { kind: "excel", ...encoded };
	const match = /^page:([A-Za-z0-9_-]{1,128})$/u.exec(evidenceId);
	if (!match) throw new PeSourceError(400, "Evidence ID must use page: or source:");
	const connection = openPeDataset(cwd);
	try {
		const row = connection.database
			.prepare(
				"SELECT p.doc_id,p.page_number FROM pdf_pages p JOIN documents d ON d.doc_id=p.doc_id WHERE p.page_id=? AND d.dataset_id=? AND d.file_type='pdf'",
			)
			.get(match[1], connection.datasetId) as SqlRow | undefined;
		if (!row) throw new PeSourceError(404, "PDF page was not found in the current project");
		const page = Number(row.page_number);
		return { kind: "pdf", docId: String(row.doc_id), pageStart: page, pageEnd: page };
	} finally {
		connection.database.close();
	}
}

export async function resolvePeEvidenceSource(
	cwd: string,
	evidenceId: string,
	signal?: AbortSignal,
): Promise<{ payload: PeSourcePayload; filePath: string }> {
	signal?.throwIfAborted();
	const reference = resolvePeEvidenceReference(cwd, evidenceId);
	if (reference.kind === "excel") {
		const sheetName = reference.sheet ?? "";
		const cellRange = reference.range ?? "";
		const bounds = parseExcelCellRange(cellRange);
		if (!bounds) throw new PeSourceError(400, "Invalid Excel range");
		const prepared = await preparePeDocument(cwd, { docId: reference.docId }, signal);
		const row: SqlRow = { ...prepared.document, sheet_name: sheetName, cell_range: cellRange };
		const connection = openPeDataset(cwd, prepared.datasetId);
		try {
			const sheet = connection.database
				.prepare("SELECT used_range FROM excel_sheets WHERE dataset_id=? AND doc_id=? AND sheet_name=?")
				.get(prepared.datasetId, reference.docId, sheetName) as SqlRow | undefined;
			if (!sheet) throw new PeSourceError(404, "Worksheet was not found in this workbook");
			const used = parseExcelCellRange(textValue(sheet, "used_range"));
			if (!used || bounds.rowEnd > used.rowEnd || bounds.columnEnd > used.columnEnd) {
				throw new PeSourceError(404, "Source range is outside the worksheet's used range");
			}
			const rowStart = Math.max(1, bounds.rowStart - 3);
			const columnStart = Math.max(1, bounds.columnStart - 3);
			const window = {
				rowStart,
				rowEnd: Math.min(used.rowEnd, rowStart + 11),
				columnStart,
				columnEnd: Math.min(used.columnEnd, columnStart + 11),
			};
			return {
				filePath: prepared.filePath,
				payload: {
					kind: "excel",
					dataset_id: prepared.datasetId,
					doc_id: reference.docId,
					evidence_id: evidenceId,
					citation: sourceCitation(row),
					markdown_citation: sourceMarkdownCitation(row, evidenceId),
					filename: sourceFilename(row),
					warnings: prepared.warnings,
					sheet_name: sheetName,
					cell_range: cellRange,
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
						sheetName,
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
	const connection = openPeDataset(cwd);
	try {
		const document = connection.database
			.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND file_type='pdf'")
			.get(connection.datasetId, reference.docId) as SqlRow | undefined;
		if (!document) throw new PeSourceError(404, "PDF document was not found");
		const filePath = documentFilePath(connection.workspaceRoot, document);
		const checksum = textValue(document, "sha256");
		if (checksum && createHash("sha256").update(readFileSync(filePath)).digest("hex") !== checksum) {
			throw new PeSourceError(409, "Original document was modified after ingestion");
		}
		const pageStart = reference.pageStart ?? 0;
		const pageEnd = reference.pageEnd ?? 0;
		const rows = connection.database
			.prepare(
				"SELECT page_number,page_text FROM pdf_pages WHERE doc_id=? AND page_number BETWEEN ? AND ? ORDER BY page_number",
			)
			.all(reference.docId, pageStart, pageEnd) as SqlRow[];
		if (rows.length !== pageEnd - pageStart + 1) throw new PeSourceError(404, "PDF page was not found");
		let budget = 12_000;
		let truncated = false;
		const pages = rows.map((page) => {
			const content = textValue(page, "page_text") ?? "";
			const text = content.slice(0, budget);
			budget -= text.length;
			truncated ||= text.length < content.length;
			return { page_number: Number(page.page_number), text };
		});
		const row: SqlRow = { ...document, page_start: pageStart, page_end: pageEnd };
		return {
			filePath,
			payload: {
				kind: "pdf",
				dataset_id: connection.datasetId,
				doc_id: reference.docId,
				evidence_id: evidenceId,
				citation: sourceCitation(row),
				markdown_citation: sourceMarkdownCitation(row, evidenceId),
				filename: sourceFilename(row),
				warnings: [],
				truncated,
				page_start: pageStart,
				page_end: pageEnd,
				pdf_pages: pages,
				content: pages.map((page) => page.text).join("\n\n"),
			},
		};
	} finally {
		connection.database.close();
	}
}

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
