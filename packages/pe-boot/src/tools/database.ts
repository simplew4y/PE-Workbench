import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { portablePeFilename } from "../document-filenames.ts";
import { sourceId } from "../source.ts";

export { DOCUMENT_SCHEMA } from "../collection-schema.ts";
export { registerPeDocuments } from "../documents.ts";
export { DOCUMENT_EXTENSIONS } from "../source.ts";

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export interface PeDatasetDatabase {
	database: DatabaseSync;
	datasetId: string;
	workspaceRoot: string;
}

interface PeDatasetLocation {
	databasePath: string;
	workspaceRoot: string;
}

export interface EvidenceLocator {
	page_start?: number;
	page_end?: number;
	sheet_name?: string;
	cell_range?: string;
	heading_path?: string;
	line_start?: number;
	line_end?: number;
	block_index?: number;
}

const PE_SOURCE_HASH = "#pe-source";

export function textValue(row: SqlRow, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(row: SqlRow, key: string): number | undefined {
	const value = row[key];
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return undefined;
}

export function booleanValue(row: SqlRow, key: string): boolean {
	const value = numberValue(row, key);
	return value === 1;
}

export function sourceFilename(row: SqlRow): string {
	return textValue(row, "source_relpath") ?? textValue(row, "original_filename") ?? "unknown source";
}

export function evidenceLocator(row: SqlRow): EvidenceLocator {
	const locator: EvidenceLocator = {};
	const pageStart = numberValue(row, "page_start");
	const pageEnd = numberValue(row, "page_end");
	const sheetName = textValue(row, "sheet_name");
	const cellRange = textValue(row, "cell_range") ?? textValue(row, "cell_ref");
	const headingPath = textValue(row, "heading_path") ?? textValue(row, "title_path");

	if (pageStart !== undefined) locator.page_start = pageStart;
	if (pageEnd !== undefined) locator.page_end = pageEnd;
	if (sheetName) locator.sheet_name = sheetName;
	if (cellRange) locator.cell_range = cellRange;
	if (headingPath) locator.heading_path = headingPath;
	for (const key of ["line_start", "line_end", "block_index"] as const) {
		const value = numberValue(row, key);
		if (value !== undefined) locator[key] = value;
	}

	return locator;
}

export function sourceCitation(row: SqlRow): string {
	const filename = sourceFilename(row);
	const locator = evidenceLocator(row);
	if (locator.page_start !== undefined) {
		return locator.page_end !== undefined && locator.page_end !== locator.page_start
			? `${filename} p.${locator.page_start}-${locator.page_end}`
			: `${filename} p.${locator.page_start}`;
	}
	if (locator.sheet_name && locator.cell_range) {
		return `${filename} ${locator.sheet_name}!${locator.cell_range}`;
	}
	if (locator.sheet_name) return `${filename} ${locator.sheet_name}`;
	if (locator.line_start !== undefined)
		return `${filename}:${locator.line_start}-${locator.line_end ?? locator.line_start}`;
	if (locator.block_index !== undefined) return `${filename} #${locator.block_index}`;
	return filename;
}

function escapeMarkdownLinkText(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function evidenceSourceUrl(evidenceId: string): string {
	const params = new URLSearchParams({ evidence_id: evidenceId });
	return `${PE_SOURCE_HASH}?${params.toString()}`;
}

export function sourceMarkdownCitation(row: SqlRow, evidenceId: string): string {
	const citation = sourceCitation(row);
	return `[${escapeMarkdownLinkText(citation)}](${evidenceSourceUrl(evidenceId)})`;
}

export function resolvePeDatasetLocation(cwd: string): PeDatasetLocation {
	let workspaceRoot: string;
	try {
		workspaceRoot = realpathSync(cwd);
	} catch {
		throw new Error(`PE project workspace does not exist: ${cwd}`);
	}

	const databaseCandidate = join(workspaceRoot, "meta", "collection.sqlite3");
	let databasePath: string;
	try {
		databasePath = realpathSync(databaseCandidate);
	} catch {
		throw new Error("PE project workspace must contain meta/collection.sqlite3");
	}

	const relativeDatabasePath = relative(workspaceRoot, databasePath);
	if (relativeDatabasePath.startsWith("..") || isAbsolute(relativeDatabasePath)) {
		throw new Error("PE collection database resolves outside the current project workspace");
	}
	if (!statSync(databasePath).isFile()) {
		throw new Error("meta/collection.sqlite3 is not a file");
	}
	return { databasePath, workspaceRoot };
}

function openResolvedPeDataset(
	location: PeDatasetLocation,
	expectedDatasetId: string | undefined,
	readOnly: boolean,
): PeDatasetDatabase {
	const database = new DatabaseSync(location.databasePath, { readOnly, timeout: 10_000 });
	try {
		database.exec("PRAGMA busy_timeout=10000");
		const rows = database
			.prepare(
				"SELECT DISTINCT dataset_id FROM documents WHERE dataset_id IS NOT NULL AND trim(dataset_id) <> '' ORDER BY dataset_id",
			)
			.all() as SqlRow[];
		let datasetIds = rows.map((row) => textValue(row, "dataset_id")).filter((value) => value !== undefined);
		if (
			datasetIds.length === 0 &&
			database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_metadata'").get()
		) {
			const projectRows = database
				.prepare(
					"SELECT DISTINCT dataset_id FROM project_metadata WHERE dataset_id IS NOT NULL AND trim(dataset_id) <> '' ORDER BY dataset_id",
				)
				.all() as SqlRow[];
			datasetIds = projectRows.map((row) => textValue(row, "dataset_id")).filter((value) => value !== undefined);
		}
		if (datasetIds.length === 0) {
			throw new Error("collection.sqlite3 contains no dataset ID");
		}
		if (datasetIds.length > 1) {
			throw new Error(`collection.sqlite3 contains multiple dataset IDs: ${datasetIds.join(", ")}`);
		}
		const datasetId = datasetIds[0];
		if (expectedDatasetId && expectedDatasetId !== datasetId) {
			throw new Error(`dataset_id ${expectedDatasetId} does not match the current project dataset ${datasetId}`);
		}
		return { database, datasetId, workspaceRoot: location.workspaceRoot };
	} catch (error) {
		database.close();
		throw error;
	}
}

export function openPeDataset(cwd: string, expectedDatasetId?: string): PeDatasetDatabase {
	return openResolvedPeDataset(resolvePeDatasetLocation(cwd), expectedDatasetId, true);
}

export function openWritablePeDataset(cwd: string, expectedDatasetId?: string): PeDatasetDatabase {
	return openResolvedPeDataset(resolvePeDatasetLocation(cwd), expectedDatasetId, false);
}

/** PDF v2 predates document versions; discovery still treats its rows as current. */
export function pdfDocumentSelection(
	database: DatabaseSync,
	includeHistorical = false,
): {
	predicate: string;
	versionNo: string;
} {
	const columns = new Set(
		database
			.prepare("PRAGMA table_info(documents)")
			.all()
			.map((row) => row.name),
	);
	const predicates: string[] = [];
	if (columns.has("file_type")) predicates.push("d.file_type='pdf'");
	if (columns.has("deleted_at")) predicates.push("d.deleted_at IS NULL");
	if (!includeHistorical) {
		if (columns.has("is_current")) predicates.push("COALESCE(d.is_current,1)=1");
		if (columns.has("lifecycle_state")) predicates.push("COALESCE(d.lifecycle_state,'active')='active'");
	}
	return {
		predicate: predicates.join(" AND ") || "1=1",
		versionNo: columns.has("version_no") ? "COALESCE(d.version_no,1)" : "1",
	};
}

export function sourceEvidenceId(row: SqlRow): string {
	const docId = textValue(row, "doc_id");
	if (!docId) throw new Error("A source must identify a document version");
	const locator = evidenceLocator(row);
	if (locator.sheet_name && locator.cell_range) {
		return sourceId({ docId, location: { kind: "excel", sheet: locator.sheet_name, range: locator.cell_range } });
	}
	if (locator.page_start !== undefined) {
		return sourceId({
			docId,
			location: { kind: "pdf", pageStart: locator.page_start, pageEnd: locator.page_end ?? locator.page_start },
		});
	}
	if (locator.line_start !== undefined) {
		return sourceId({
			docId,
			location: { kind: "text", lineStart: locator.line_start, lineEnd: locator.line_end ?? locator.line_start },
		});
	}
	if (locator.block_index !== undefined)
		return sourceId({ docId, location: { kind: "block", blockIndex: locator.block_index } });
	throw new Error("A source must include a concrete file location");
}

export function documentFilePath(workspaceRoot: string, document: SqlRow): string {
	const stored = textValue(document, "stored_path") ?? textValue(document, "raw_path");
	if (!stored) throw new Error("Document has no original file path");
	const candidate = realpathSync(resolve(workspaceRoot, stored));
	const rel = relative(realpathSync(join(workspaceRoot, "raw")), candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(candidate).isFile()) {
		throw new Error("Document original must resolve to a file inside raw/");
	}
	return candidate;
}

export function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * The upload pipeline folds file names with NFKC and then maps punctuation Windows forbids back to
 * full-width forms. Tool lookups by file name must apply the same mapping, otherwise a name copied
 * from search results ("Hermès： Stretching upwards") never matches the stored document.
 */

/**
 * Resolve a requested PDF name to stored file names. An exact match (with or without .pdf) wins;
 * otherwise any current file whose name contains the requested text matches, so agents can pass
 * a distinctive fragment instead of copying a long platform-generated file name.
 */
export function matchPdfDocumentNames(
	database: DatabaseSync,
	datasetId: string,
	requested: string,
	includeHistorical = false,
): string[] {
	const key = pdfFilenameKey(requested);
	if (!key) return [];
	const withExtension = key.endsWith(".pdf") ? key : `${key}.pdf`;
	const selection = pdfDocumentSelection(database, includeHistorical);
	const names = (
		database
			.prepare(
				`SELECT DISTINCT d.original_filename FROM documents d WHERE d.dataset_id=? AND ${selection.predicate}`,
			)
			.all(datasetId) as SqlRow[]
	)
		.map((row) => textValue(row, "original_filename"))
		.filter((name): name is string => name !== undefined);
	const exact = names.filter((name) => {
		const stored = pdfFilenameKey(name);
		return stored === key || stored === withExtension;
	});
	if (exact.length > 0) return exact;
	const fragment = key.endsWith(".pdf") ? key.slice(0, -4) : key;
	return names.filter((name) => pdfFilenameKey(name).includes(fragment));
}

export function pdfFilenameKey(value: string): string {
	return portablePeFilename(value).toLocaleLowerCase("und");
}
