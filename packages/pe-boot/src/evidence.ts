import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { initializePeCollectionDatabase, PE_PIPELINE_SCHEMA_VERSION } from "./collection-schema.ts";
import { PeSourceError, preparePeDocument } from "./documents.ts";
import { type PeSourcePayload, type PeSourceReference, parseExcelCellRange, parseSourceId } from "./source.ts";
import {
	documentFilePath,
	evidenceLocator,
	numberValue,
	openPeDataset,
	resolvePeDatasetLocation,
	type SqlRow,
	sourceCitation,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";
import { readExcelCellsByBounds } from "./tools/excel-cells.ts";
import { readWindSnapshot } from "./trusted-sources.ts";

/** A citation can be the first entry into a project after an upgrade. */
function migrateEvidenceCollection(cwd: string): void {
	const connection = openPeDataset(cwd);
	let needsMigration = false;
	try {
		const database = connection.database;
		const version = database
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_metadata'")
			.get()
			? database.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get()
			: undefined;
		if (version) {
			needsMigration = Number(version.value) !== PE_PIPELINE_SCHEMA_VERSION;
		} else {
			const columns = new Set(
				database
					.prepare("PRAGMA table_info(documents)")
					.all()
					.map((row) => row.name),
			);
			const mainCatalog =
				!columns.has("raw_path") &&
				["logical_doc_id", "version_no", "stored_path", "file_type", "checksum"].every((name) => columns.has(name));
			const pdfCatalog =
				!columns.has("version_no") && ["filename_key", "raw_path", "sha256"].every((name) => columns.has(name));
			needsMigration = mainCatalog || pdfCatalog;
		}
	} finally {
		connection.database.close();
	}
	// The schema owner validates exact catalog shapes and rolls back unsupported legacy data.
	if (needsMigration) initializePeCollectionDatabase(resolvePeDatasetLocation(cwd).databasePath);
}

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

export interface PeEvidenceRecord {
	evidenceId: string;
	citation: string;
	filename: string;
	locator: ReturnType<typeof evidenceLocator>;
}

/** Synchronous validation for existing research artifact writers. */
export function resolvePeEvidenceRecord(
	database: DatabaseSync,
	datasetId: string,
	evidenceId: string,
): PeEvidenceRecord | undefined {
	let reference = parseSourceId(evidenceId);
	if (!reference) {
		const match = /^(page|cell|fact):([A-Za-z0-9_-]{1,128})$/u.exec(evidenceId);
		if (!match) return undefined;
		const table = match[1] === "page" ? "pdf_pages" : match[1] === "cell" ? "excel_cells" : "metric_facts";
		const key = match[1] === "page" ? "page_id" : match[1] === "cell" ? "cell_id" : "fact_id";
		let legacy: SqlRow | undefined;
		if (
			match[1] !== "page" &&
			database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_locations'").get()
		)
			legacy = database
				.prepare("SELECT doc_id,sheet_name,cell_range AS cell_ref FROM evidence_locations WHERE evidence_id=?")
				.get(evidenceId) as SqlRow | undefined;
		if (!legacy && database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
			legacy = database.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(match[2]) as SqlRow | undefined;
		if (!legacy) return undefined;
		reference = {
			docId: String(legacy.doc_id),
			location:
				match[1] === "page"
					? { kind: "pdf", pageStart: Number(legacy.page_number), pageEnd: Number(legacy.page_number) }
					: { kind: "excel", sheet: String(legacy.sheet_name), range: String(legacy.cell_ref) },
		};
	}
	const document = database
		.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=?")
		.get(datasetId, reference.docId) as SqlRow | undefined;
	if (!document || document.deleted_at) return undefined;
	const { location } = reference;
	if (location.kind === "excel") {
		const bounds = parseExcelCellRange(location.range);
		if (!bounds || !["xlsx", "xlsm"].includes(String(document.file_type))) return undefined;
		const cell = database
			.prepare(`SELECT 1 FROM excel_cells WHERE dataset_id=? AND doc_id=? AND sheet_name=?
				AND row_index BETWEEN ? AND ? AND col_index BETWEEN ? AND ? LIMIT 1`)
			.get(
				datasetId,
				reference.docId,
				location.sheet,
				bounds.rowStart,
				bounds.rowEnd,
				bounds.columnStart,
				bounds.columnEnd,
			);
		if (!cell) return undefined;
	} else if (location.kind === "pdf") {
		if (document.file_type !== "pdf") return undefined;
		const count = database
			.prepare("SELECT COUNT(*) AS count FROM pdf_pages WHERE doc_id=? AND page_number BETWEEN ? AND ?")
			.get(reference.docId, location.pageStart, location.pageEnd);
		if (Number(count?.count) !== location.pageEnd - location.pageStart + 1) return undefined;
	} else if (location.kind === "text" && document.parser_name === "wind_snapshot") {
		const snapshot = readWindSnapshot(database, datasetId, reference.docId);
		if (
			!snapshot ||
			location.lineEnd > snapshot.text.split("\n").length ||
			location.lineEnd - location.lineStart >= 2000
		)
			return undefined;
	} else {
		// Text and Office citations require the asynchronous cache readiness barrier.
		return undefined;
	}
	const row = { ...document, ...sourceLocationRow(reference) };
	return { evidenceId, citation: sourceCitation(row), filename: sourceFilename(row), locator: evidenceLocator(row) };
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
	migrateEvidenceCollection(cwd);
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
	if (location.kind === "text" || location.kind === "block") {
		if (location.kind === "text") {
			const connection = openPeDataset(cwd);
			try {
				const snapshot = readWindSnapshot(connection.database, connection.datasetId, reference.docId);
				if (snapshot) {
					const lines = snapshot.text.split("\n");
					if (location.lineEnd > lines.length || location.lineEnd - location.lineStart >= 2000)
						throw new PeSourceError(404, "Source lines do not exist in this snapshot");
					const content = lines.slice(location.lineStart - 1, location.lineEnd).join("\n");
					const row = { ...snapshot.document, ...sourceLocationRow(reference) };
					return {
						filePath: snapshot.filePath,
						payload: {
							kind: "text",
							dataset_id: connection.datasetId,
							doc_id: reference.docId,
							version_no: Number(row.version_no),
							evidence_id: evidenceId,
							citation: sourceCitation(row),
							markdown_citation: sourceMarkdownCitation(row, evidenceId),
							filename: sourceFilename(row),
							warnings: [],
							content: content.slice(0, 12000),
							truncated: content.length > 12000,
						},
					};
				}
			} finally {
				connection.database.close();
			}
		}
		const prepared = await preparePeDocument(cwd, { docId: reference.docId }, signal);
		const cache = JSON.parse(readFileSync(prepared.cachePath, "utf8")) as {
			text?: string;
			blocks: Array<{ text: string; block_index?: number }>;
		};
		const row = { ...prepared.document, ...sourceLocationRow(reference) };
		const fileType = textValue(row, "file_type");
		let content: string | undefined;
		if (location.kind === "text" && cache.text !== undefined) {
			const lines = cache.text.split("\n");
			if (location.lineEnd <= lines.length && location.lineEnd - location.lineStart < 2_000)
				content = lines.slice(location.lineStart - 1, location.lineEnd).join("\n");
		} else if (location.kind === "block" && (fileType === "docx" || fileType === "pptx"))
			content = cache.blocks.find((block) => block.block_index === location.blockIndex)?.text;
		if (content === undefined)
			throw new PeSourceError(404, "Source location does not exist in this document version");
		return {
			filePath: prepared.filePath,
			payload: {
				kind: "text",
				dataset_id: prepared.datasetId,
				doc_id: reference.docId,
				version_no: numberValue(row, "version_no") ?? 1,
				evidence_id: evidenceId,
				citation: sourceCitation(row),
				markdown_citation: sourceMarkdownCitation(row, evidenceId),
				filename: sourceFilename(row),
				warnings: prepared.warnings,
				content: content.slice(0, 12_000),
				truncated: content.length > 12_000,
			},
		};
	}
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
		if (rows.length !== location.pageEnd - location.pageStart + 1) {
			const pageCount = numberValue(document, "page_count") ?? 0;
			if (pageCount > 0 && location.pageEnd > pageCount)
				throw new PeSourceError(404, "PDF page was not found in this document version");
			if (textValue(document, "status") === "queued")
				throw new PeSourceError(409, "PDF index is being rebuilt; retry this citation after processing completes");
			if (textValue(document, "registration_kind") === "catalog" && textValue(document, "status") === "failed")
				throw new PeSourceError(409, "PDF index requires reprocessing; retry this document in the PDF pipeline");
			throw new PeSourceError(404, "PDF page was not found in this document version");
		}
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
		let warnings: string[] = [];
		try {
			const value: unknown = JSON.parse(textValue(document, "warnings_json") ?? "[]");
			if (Array.isArray(value) && value.every((warning): warning is string => typeof warning === "string"))
				warnings = value;
		} catch {
			// Older page indexes may not contain structured warnings.
		}
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
				warnings,
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
