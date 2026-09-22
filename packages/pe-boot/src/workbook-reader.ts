import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { excelParserRevision, excelPython } from "./excel-processing.ts";
import { type ExcelBounds, excelColumnLabel } from "./source.ts";
import {
	documentFilePath,
	type SqlRow,
	sourceEvidenceId,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";

export interface WorkbookRequest {
	action: "inspect" | "search" | "read" | "trace" | "render";
	section?:
		| "sheets"
		| "defined_names"
		| "external_links"
		| "content_ranges"
		| "comment_cells"
		| "merged_ranges"
		| "hidden_rows"
		| "hidden_columns"
		| "tables"
		| "drawings";
	sheet?: string;
	range?: string;
	ranges?: Array<{ sheet: string; range: string }>;
	query?: string;
	offset?: number;
	limit?: number;
	max_depth?: number;
	max_nodes?: number;
}

export const WorkbookRequestProperties = {
	action: Type.Union([
		Type.Literal("inspect"),
		Type.Literal("search"),
		Type.Literal("read"),
		Type.Literal("trace"),
		Type.Literal("render"),
	]),
	section: Type.Optional(
		Type.Union(
			(
				[
					"sheets",
					"defined_names",
					"external_links",
					"content_ranges",
					"comment_cells",
					"merged_ranges",
					"hidden_rows",
					"hidden_columns",
					"tables",
					"drawings",
				] as const
			).map((value) => Type.Literal(value)),
		),
	),
	sheet: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	range: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	ranges: Type.Optional(
		Type.Array(Type.Object({ sheet: Type.String({ minLength: 1 }), range: Type.String({ minLength: 1 }) }), {
			minItems: 1,
			maxItems: 100,
		}),
	),
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
	max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
};
export const WorkbookRequestSchema = Type.Object(WorkbookRequestProperties);

const readerPath = join(dirname(fileURLToPath(import.meta.url)), "../python/workbook_reader.py");
const cache = new Map<string, string>();
const navigationCache = new Map<string, Record<string, unknown>>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let cacheBytes = 0;

/** Read source facts only. Callers authorize the file before entering this shared reader. */
export function readWorkbookFile(
	filePath: string,
	request: WorkbookRequest,
	checksum?: string,
	textIndex?: string,
	navigation?: Record<string, unknown>,
): Record<string, unknown> {
	const path = realpathSync(filePath);
	const actualChecksum = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (checksum && actualChecksum !== checksum)
		throw new Error("Original file changed; upload it as a new version before citing it");
	const key = JSON.stringify([actualChecksum, excelParserRevision(), request]);
	let serialized = cache.get(key);
	if (serialized !== undefined) {
		cache.delete(key);
		cache.set(key, serialized);
	} else {
		const args =
			request.action === "render"
				? [join(dirname(readerPath), "render_workbook.py"), path]
				: [readerPath, "--input", path];
		if (textIndex && request.action === "search") args.push("--text-index", textIndex);
		// ponytail: one bounded synchronous query; use async workers if concurrent workbook reads contend.
		const result = spawnSync(excelPython(), args, {
			input: JSON.stringify({ ...request, _navigation: navigation ?? navigationCache.get(actualChecksum) }),
			encoding: "utf8",
			maxBuffer: MAX_CACHE_BYTES,
			timeout: 120_000,
		});
		if (result.error) throw new Error(`Workbook reader failed: ${result.error.message}`);
		if (result.status !== 0) throw new Error(result.stderr.trim() || "Workbook reader failed");
		if (createHash("sha256").update(readFileSync(path)).digest("hex") !== actualChecksum)
			throw new Error("Original workbook changed during reading");
		const response = JSON.parse(result.stdout) as Record<string, unknown>;
		if (response._navigation && typeof response._navigation === "object") {
			if (navigationCache.size >= 16) navigationCache.delete(navigationCache.keys().next().value!);
			navigationCache.set(actualChecksum, response._navigation as Record<string, unknown>);
			delete response._navigation;
		}
		serialized = JSON.stringify(response);
		const bytes = Buffer.byteLength(serialized);
		if (bytes <= MAX_CACHE_BYTES / 2) {
			while (cacheBytes + bytes > MAX_CACHE_BYTES && cache.size) {
				const oldest = cache.keys().next().value!;
				cacheBytes -= Buffer.byteLength(cache.get(oldest)!);
				cache.delete(oldest);
			}
			cache.set(key, serialized);
			cacheBytes += bytes;
		}
	}
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workbook reader response");
	return value as Record<string, unknown>;
}

export function workbookSource(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
): { document: SqlRow; filePath: string } {
	const document = database
		.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
		.get(datasetId, docId) as SqlRow | undefined;
	if (!document || !["xlsx", "xlsm"].includes(String(document.file_type)))
		throw new Error("Workbook is outside the authorized dataset");
	const location = database
		.prepare("PRAGMA database_list")
		.all()
		.find((row) => row.name === "main");
	if (!location?.file) throw new Error("Workbook reader requires an original file in a project workspace");
	return { document, filePath: documentFilePath(dirname(dirname(String(location.file))), document) };
}

export function readWorkbookDocument(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	request: WorkbookRequest,
): Record<string, unknown> {
	const { document, filePath } = workbookSource(database, datasetId, docId);
	let textIndex: string | undefined;
	let navigation: Record<string, unknown> | undefined;
	if (request.action !== "render") {
		try {
			const dbFile = database
				.prepare("PRAGMA database_list")
				.all()
				.find((row) => row.name === "main")!.file;
			const pointer = database.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?").get(docId);
			if (pointer) {
				const manifestPath = resolve(dirname(dirname(String(dbFile))), String(pointer.cache_path));
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
				if (
					manifest.source_sha256 === (document.checksum || document.sha256) &&
					manifest.revision === excelParserRevision()
				) {
					const navigationPath = join(dirname(manifestPath), "navigation.json");
					if (realpathSync(navigationPath) === navigationPath)
						navigation = JSON.parse(readFileSync(navigationPath, "utf8")).navigation;
					if (request.action === "search") {
						const candidate = join(dirname(manifestPath), "text-index.json");
						if (
							realpathSync(candidate) === candidate &&
							createHash("sha256").update(readFileSync(candidate)).digest("hex") === manifest.text_index_sha256
						)
							textIndex = candidate;
					}
				}
			}
		} catch {
			// Derived indexes are optional; search the original when missing or damaged.
		}
	}
	const result = readWorkbookFile(
		filePath,
		request,
		textValue(document, "checksum") ?? textValue(document, "sha256"),
		textIndex,
		navigation,
	);
	for (const field of ["cells", "nodes"] as const) {
		if (!Array.isArray(result[field])) continue;
		result[field] = result[field].map((value: Record<string, unknown>) => {
			const cell: SqlRow = {
				doc_id: docId,
				dataset_id: datasetId,
				original_filename: document.original_filename,
				source_relpath: document.source_relpath,
				version_no: document.version_no,
				file_type: document.file_type,
			};
			for (const [key, entry] of Object.entries(value)) {
				if (entry === null || typeof entry === "string" || typeof entry === "number") cell[key] = entry;
				else if (typeof entry === "boolean") cell[key] = Number(entry);
			}
			cell.cell_id = createHash("sha256")
				.update(`${docId}\0${cell.sheet_name}\0${cell.cell_ref}`)
				.digest("hex")
				.slice(0, 40);
			cell.cell_range = cell.cell_ref;
			cell.evidence_id = sourceEvidenceId(cell);
			cell.markdown_citation = sourceMarkdownCitation(cell, String(cell.evidence_id));
			return { ...value, ...cell };
		});
	}
	return { ...result, doc_id: docId, dataset_id: datasetId, version_no: document.version_no };
}

export function inspectWorkbookDocument(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
): Record<string, unknown> {
	return readWorkbookDocument(database, datasetId, docId, { action: "inspect" });
}

export function readWorkbookCells(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	sheet: string,
	bounds: ExcelBounds,
	maxCells: number,
): SqlRow[] {
	const range = `${excelColumnLabel(bounds.columnStart)}${bounds.rowStart}:${excelColumnLabel(bounds.columnEnd)}${bounds.rowEnd}`;
	return readWorkbookDocument(database, datasetId, docId, { action: "read", sheet, range, limit: maxCells })
		.cells as SqlRow[];
}
