import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DOCUMENT_EXTENSIONS, sourceId, sourceLink } from "../source.ts";

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

export const DOCUMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, logical_doc_id TEXT NOT NULL,
  version_no INTEGER NOT NULL, supersedes_doc_id TEXT, is_current INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active', title TEXT NOT NULL,
  original_filename TEXT NOT NULL, source_relpath TEXT NOT NULL, stored_path TEXT NOT NULL,
  file_type TEXT NOT NULL, checksum TEXT NOT NULL, file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', doc_type TEXT, document_date TEXT,
  company_name TEXT, company_ticker TEXT, source_name TEXT, metadata_json TEXT,
  parser_name TEXT, parser_version TEXT, parser_metadata_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS documents_current ON documents(dataset_id, is_current, source_relpath);
CREATE TABLE IF NOT EXISTS document_cache (
  doc_id TEXT PRIMARY KEY, revision TEXT NOT NULL, prepared_at TEXT NOT NULL,
  FOREIGN KEY(doc_id) REFERENCES documents(doc_id)
);
`;

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

export function sourceMarkdownCitation(row: SqlRow, evidenceId: string): string {
	return sourceLink(sourceCitation(row), evidenceId);
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
	for (const directory of ["raw", "meta"]) {
		const entry = lstatSync(join(workspaceRoot, directory));
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`PE ${directory}/ must be a real directory`);
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
		const hasMetadata = database
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_metadata'")
			.get();
		const rows = database
			.prepare(
				hasMetadata
					? "SELECT dataset_id FROM project_metadata WHERE id = 1"
					: "SELECT DISTINCT dataset_id FROM documents WHERE dataset_id IS NOT NULL AND trim(dataset_id) <> '' ORDER BY dataset_id",
			)
			.all() as SqlRow[];
		const datasetIds = rows.map((row) => textValue(row, "dataset_id")).filter((value) => value !== undefined);
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

export function documentFilePath(workspaceRoot: string, document: SqlRow): string {
	const stored = textValue(document, "stored_path");
	if (!stored) throw new Error("Document has no original file path");
	const candidate = realpathSync(resolve(workspaceRoot, stored));
	const rel = relative(realpathSync(join(workspaceRoot, "raw")), candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(candidate).isFile()) {
		throw new Error("Document original must resolve to a file inside raw/");
	}
	return candidate;
}

/** Register originals only. Reading and parsing are separate operations. */
export function registerPeDocuments(
	cwd: string,
	datasetId: string,
	files: Array<{ name: string; bytes: Uint8Array }>,
): { documents: SqlRow[]; fileCount: number } {
	const connection = openWritablePeDataset(cwd, datasetId);
	const { database, workspaceRoot } = connection;
	const createdFiles: string[] = [];
	try {
		database.exec(DOCUMENT_SCHEMA);
		database.exec("BEGIN IMMEDIATE");
		const documents: SqlRow[] = [];
		for (const { name, bytes } of files) {
			const extension = extname(name).toLowerCase();
			if (basename(name) !== name || /[\\/\x00-\x1f]/u.test(name) || !DOCUMENT_EXTENSIONS.has(extension)) {
				throw new Error(`Unsupported document filename: ${name}`);
			}
			const checksum = createHash("sha256").update(bytes).digest("hex");
			const generatedLogicalId = createHash("sha256").update(`${datasetId}\0${name}`).digest("hex").slice(0, 40);
			const current = database
				.prepare(
					"SELECT * FROM documents WHERE dataset_id=? AND (logical_doc_id=? OR source_relpath=? OR source_relpath=?) AND is_current=1 AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1",
				)
				.get(datasetId, generatedLogicalId, name, `raw/${name}`) as SqlRow | undefined;
			const logicalId = textValue(current ?? {}, "logical_doc_id") ?? generatedLogicalId;
			if (current && textValue(current, "checksum") === checksum) {
				const original = documentFilePath(workspaceRoot, current);
				if (createHash("sha256").update(readFileSync(original)).digest("hex") !== checksum)
					throw new Error("Stored original was modified; restore it before uploading this version again");
				documents.push(current);
				continue;
			}
			const version = Number(
				(
					database
						.prepare(
							"SELECT COALESCE(MAX(version_no),0)+1 AS version FROM documents WHERE dataset_id=? AND logical_doc_id=?",
						)
						.get(datasetId, logicalId) as SqlRow
				).version,
			);
			const docId = createHash("sha256").update(`${logicalId}\0${version}\0${checksum}`).digest("hex").slice(0, 40);
			let storedName = name;
			if (existsSync(join(workspaceRoot, "raw", storedName)))
				storedName = `${name.slice(0, -extension.length)}--${docId}${extension}`;
			const target = join(workspaceRoot, "raw", storedName);
			writeFileSync(target, bytes, { flag: "wx" });
			createdFiles.push(target);
			const now = new Date().toISOString();
			database
				.prepare("UPDATE documents SET is_current=0 WHERE dataset_id=? AND (logical_doc_id=? OR doc_id=?)")
				.run(datasetId, logicalId, textValue(current ?? {}, "doc_id") ?? "");
			database
				.prepare(
					`INSERT INTO documents (doc_id,dataset_id,logical_doc_id,version_no,supersedes_doc_id,title,original_filename,source_relpath,stored_path,file_type,checksum,file_size,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					docId,
					datasetId,
					logicalId,
					version,
					textValue(current ?? {}, "doc_id") ?? null,
					name,
					name,
					name,
					`raw/${storedName}`,
					extension.slice(1),
					checksum,
					bytes.byteLength,
					"available",
					now,
					now,
				);
			documents.push(database.prepare("SELECT * FROM documents WHERE doc_id=?").get(docId) as SqlRow);
		}
		const count = database
			.prepare("SELECT COUNT(*) AS count FROM documents WHERE dataset_id=? AND is_current=1 AND deleted_at IS NULL")
			.get(datasetId) as SqlRow;
		database.exec("COMMIT");
		return { documents, fileCount: Number(count.count) };
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			/* No transaction was started. */
		}
		for (const file of createdFiles) rmSync(file, { force: true });
		throw error;
	} finally {
		database.close();
	}
}

export function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}
