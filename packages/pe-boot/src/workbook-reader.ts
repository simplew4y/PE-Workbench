import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
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
	action: "inspect" | "search" | "read" | "trace" | "render" | "validate";
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

export interface WorkbookReadProgress {
	phase: "start" | "retry" | "complete";
	attempt: number;
	elapsedMs: number;
	cacheHit: boolean;
}

export interface WorkbookReadOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (progress: WorkbookReadProgress) => void;
}

export interface WorkbookReadFailure extends Error {
	code?: string;
	attempts: number;
}

function cachedResponse(key: string): string | undefined {
	const serialized = cache.get(key);
	if (serialized !== undefined) {
		cache.delete(key);
		cache.set(key, serialized);
	}
	return serialized;
}

function retainResponse(key: string, checksum: string, output: string): string {
	const parsed: unknown = JSON.parse(output);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Invalid workbook reader response");
	const response = parsed as Record<string, unknown>;
	if (response._navigation && typeof response._navigation === "object") {
		if (navigationCache.size >= 16) navigationCache.delete(navigationCache.keys().next().value!);
		navigationCache.set(checksum, response._navigation as Record<string, unknown>);
		delete response._navigation;
	}
	const serialized = JSON.stringify(response);
	const bytes = Buffer.byteLength(serialized);
	const missingRange = Array.isArray(response.ranges) && response.ranges.some((range) => range.exists !== true);
	if (bytes <= MAX_CACHE_BYTES / 2 && !missingRange) {
		const previous = cache.get(key);
		if (previous !== undefined) {
			cacheBytes -= Buffer.byteLength(previous);
			cache.delete(key);
		}
		while (cacheBytes + bytes > MAX_CACHE_BYTES && cache.size) {
			const oldest = cache.keys().next().value!;
			cacheBytes -= Buffer.byteLength(cache.get(oldest)!);
			cache.delete(oldest);
		}
		cache.set(key, serialized);
		cacheBytes += bytes;
	}
	return serialized;
}

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
	let serialized = cachedResponse(key);
	if (serialized === undefined) {
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
		serialized = retainResponse(key, actualChecksum, result.stdout);
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
	return documentResponse(result, document, datasetId, docId);
}

function documentResponse(
	result: Record<string, unknown>,
	document: SqlRow,
	datasetId: string,
	docId: string,
): Record<string, unknown> {
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

async function workbookChecksum(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
	return hash.digest("hex");
}

function runWorkbookReader(args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	return new Promise((resolveOutput, reject) => {
		const child = spawn(excelPython(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const abort = () => stop(new DOMException("Workbook reading was cancelled", "AbortError"));
		const timer = setTimeout(() => {
			stop(Object.assign(new Error(`Workbook reader timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
		}, timeoutMs);
		const collect = (target: Buffer[], data: Buffer) => {
			bytes += data.length;
			if (bytes > MAX_CACHE_BYTES) stop(new Error("Workbook reader output exceeds the size limit"));
			else target.push(data);
		};
		child.stdout.on("data", (data: Buffer) => collect(stdout, data));
		child.stderr.on("data", (data: Buffer) => collect(stderr, data));
		child.on("error", (error) => {
			failure ??= error;
		});
		child.stdin.on("error", (error) => stop(error));
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "Workbook reader failed"));
			else resolveOutput(Buffer.concat(stdout).toString("utf8"));
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else child.stdin.end(input);
	});
}

/** Batch source validation without blocking the agent while Python reads the workbook. */
export async function readWorkbookDocumentAsync(
	database: DatabaseSync,
	datasetId: string,
	docId: string,
	request: WorkbookRequest,
	options: WorkbookReadOptions = {},
): Promise<Record<string, unknown>> {
	const { signal } = options;
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Workbook timeout must be positive");
	const started = Date.now();
	let attempt = 0;
	const context = JSON.stringify({
		docId,
		action: request.action,
		sheet: request.sheet,
		range: request.range,
		ranges: request.ranges,
	});
	try {
		signal?.throwIfAborted();
		const { document, filePath } = workbookSource(database, datasetId, docId);
		const path = await realpath(filePath);
		const actualChecksum = await workbookChecksum(path, signal);
		const expectedChecksum = textValue(document, "checksum") ?? textValue(document, "sha256");
		if (expectedChecksum && actualChecksum !== expectedChecksum)
			throw new Error("Original file changed; upload it as a new version before citing it");
		const revision = excelParserRevision();
		const key = JSON.stringify([actualChecksum, revision, request]);
		let serialized = cachedResponse(key);
		const cacheHit = serialized !== undefined;
		if (serialized === undefined) {
			let navigation = navigationCache.get(actualChecksum);
			let textIndex: string | undefined;
			if (request.action !== "render") {
				try {
					const dbFile = database
						.prepare("PRAGMA database_list")
						.all()
						.find((row) => row.name === "main")!.file;
					const pointer = database.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?").get(docId);
					if (pointer) {
						const manifestPath = resolve(dirname(dirname(String(dbFile))), String(pointer.cache_path));
						const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
						if (manifest.source_sha256 === actualChecksum && manifest.revision === revision) {
							const navigationPath = join(dirname(manifestPath), "navigation.json");
							if ((await realpath(navigationPath)) === navigationPath)
								navigation = JSON.parse(await readFile(navigationPath, "utf8")).navigation;
							if (request.action === "search") {
								const candidate = join(dirname(manifestPath), "text-index.json");
								if (
									(await realpath(candidate)) === candidate &&
									(await workbookChecksum(candidate, signal)) === manifest.text_index_sha256
								)
									textIndex = candidate;
							}
						}
					}
				} catch {
					// Missing or damaged derived indexes fall back to the original workbook.
					signal?.throwIfAborted();
				}
			}
			const args =
				request.action === "render"
					? [join(dirname(readerPath), "render_workbook.py"), path]
					: [readerPath, "--input", path];
			if (textIndex) args.push("--text-index", textIndex);
			const input = JSON.stringify({ ...request, _navigation: navigation });
			for (attempt = 1; attempt <= 2; attempt++) {
				signal?.throwIfAborted();
				options.onProgress?.({
					phase: attempt === 1 ? "start" : "retry",
					attempt,
					elapsedMs: Date.now() - started,
					cacheHit: false,
				});
				try {
					const output = await runWorkbookReader(args, input, timeoutMs, signal);
					signal?.throwIfAborted();
					if ((await workbookChecksum(path, signal)) !== actualChecksum)
						throw new Error("Original workbook changed during reading");
					serialized = retainResponse(key, actualChecksum, output);
					break;
				} catch (error) {
					signal?.throwIfAborted();
					if (attempt === 2 || !(error instanceof Error) || !("code" in error) || error.code !== "ETIMEDOUT")
						throw error;
				}
			}
		} else if ((await workbookChecksum(path, signal)) !== actualChecksum) {
			throw new Error("Original workbook changed during reading");
		}
		signal?.throwIfAborted();
		if (serialized === undefined) throw new Error("Workbook reader returned no response");
		options.onProgress?.({ phase: "complete", attempt, elapsedMs: Date.now() - started, cacheHit });
		return documentResponse(JSON.parse(serialized) as Record<string, unknown>, document, datasetId, docId);
	} catch (error) {
		signal?.throwIfAborted();
		const failure: WorkbookReadFailure = Object.assign(
			new Error(
				`Workbook reader failed for ${context} (attempt ${attempt}, ${Date.now() - started}ms): ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			),
			{
				code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined,
				attempts: attempt,
			},
		);
		throw failure;
	}
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
