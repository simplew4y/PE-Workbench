import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}

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
	return filename;
}

function resolvePeDatasetLocation(cwd: string): PeDatasetLocation {
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
