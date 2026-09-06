import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PeSourcePayload, type PeSourceReference, parseExcelCellRange, parseSourceId } from "./source.ts";
import {
	DOCUMENT_SCHEMA,
	documentFilePath,
	numberValue,
	openPeDataset,
	openWritablePeDataset,
	type SqlRow,
	sourceCitation,
	sourceEvidenceId,
	sourceFilename,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";
import { readExcelCellsByBounds } from "./tools/excel-cells.ts";

export { DOCUMENT_EXTENSIONS, registerPeDocuments } from "./tools/database.ts";

interface DocumentBlock {
	text: string;
	page_start?: number;
	page_end?: number;
	block_index?: number;
	heading_path?: string;
}

interface DocumentCache {
	doc_id: string;
	revision: string;
	blocks: DocumentBlock[];
	text?: string;
	warnings: string[];
}

export interface PeDocumentOptions {
	docId?: string;
	path?: string;
	datasetId?: string;
}

export interface PreparedPeDocument {
	document: SqlRow;
	datasetId: string;
	workspaceRoot: string;
	filePath: string;
	readablePath: string;
	cachePath: string;
	warnings: string[];
}

export class PeSourceError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "PeSourceError";
		this.status = status;
	}
}

const readerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../python");
const preparations = new Map<string, Promise<PreparedPeDocument>>();

function cacheDirectory(workspaceRoot: string): string {
	const directory = join(workspaceRoot, "meta", "read-cache");
	mkdirSync(directory, { recursive: true });
	if (realpathSync(directory) !== directory) throw new PeSourceError(400, "Document cache must not be a symlink");
	return directory;
}

function readCache(path: string): DocumentCache {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object") throw new Error("Invalid document cache");
	const cache = value as DocumentCache;
	if (
		typeof cache.doc_id !== "string" ||
		typeof cache.revision !== "string" ||
		!Array.isArray(cache.blocks) ||
		!Array.isArray(cache.warnings)
	)
		throw new Error("Invalid document cache");
	if (
		!cache.blocks.every((block) => block && typeof block.text === "string") ||
		!cache.warnings.every((warning) => typeof warning === "string") ||
		(cache.text !== undefined && typeof cache.text !== "string")
	)
		throw new Error("Invalid document cache contents");
	return cache;
}

function writeAtomic(path: string, text: string): void {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

async function verifyOriginal(path: string, checksum: string, signal?: AbortSignal): Promise<void> {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
	if (hash.digest("hex") !== checksum)
		throw new PeSourceError(409, "Original file changed; upload it as a new version before citing it");
}

function runReader(workspaceRoot: string, docId: string, revision: string, signal?: AbortSignal): Promise<void> {
	const localPython = join(readerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const python = process.env.PE_DOCUMENT_PYTHON?.trim() || (existsSync(localPython) ? localPython : "python3");
	return new Promise((resolveReader, reject) => {
		const child = spawn(
			python,
			[join(readerRoot, "read_document.py"), "--project", workspaceRoot, "--doc-id", docId, "--revision", revision],
			{ signal, stdio: ["ignore", "ignore", "pipe"] },
		);
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => {
			error = (error + chunk.toString()).slice(-8_000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolveReader();
			else reject(new Error(error.trim() || `Document reader exited with code ${code}`));
		});
	});
}

function writeReadableView(prepared: PreparedPeDocument, cache: DocumentCache): void {
	const document = prepared.document;
	const docId = textValue(document, "doc_id") ?? "";
	const lines = [
		`# ${sourceFilename(document)} (version ${numberValue(document, "version_no")})`,
		...cache.warnings.map((warning) => `Warning: ${warning}`),
	];
	const fileType = textValue(document, "file_type");
	if (fileType === "xlsx" || fileType === "xlsm") {
		const connection = openPeDataset(prepared.workspaceRoot, prepared.datasetId);
		try {
			const sheets = connection.database
				.prepare("SELECT sheet_name,used_range,sheet_state FROM excel_sheets WHERE doc_id=? ORDER BY sheet_index")
				.all(docId) as SqlRow[];
			for (const sheet of sheets)
				lines.push(
					`Sheet: ${textValue(sheet, "sheet_name")} | ${textValue(sheet, "used_range") ?? "empty"} | ${textValue(sheet, "sheet_state")}`,
				);
			const cells = connection.database
				.prepare("SELECT * FROM excel_cells WHERE doc_id=? ORDER BY sheet_name,row_index,col_index")
				.iterate(docId);
			for (const cell of cells) {
				const row: SqlRow = { ...document, ...cell };
				const id = sourceEvidenceId(row);
				lines.push(
					`${sourceCitation(row)} | value=${JSON.stringify(textValue(row, "raw_value") ?? "")} | cached=${JSON.stringify(textValue(row, "cached_value") ?? "")} | formula=${JSON.stringify(textValue(row, "formula") ?? "")} | ${sourceMarkdownCitation(row, id)}`,
				);
			}
		} finally {
			connection.database.close();
		}
	} else if (cache.text !== undefined) {
		for (const [index, line] of cache.text.split("\n").entries()) {
			const row = { ...document, line_start: index + 1, line_end: index + 1 };
			lines.push(`${line} ${sourceMarkdownCitation(row, sourceEvidenceId(row))}`);
		}
	} else {
		for (const block of cache.blocks) {
			const row: SqlRow = { ...document, ...block };
			const citation = sourceMarkdownCitation(row, sourceEvidenceId(row));
			lines.push(`\n${block.heading_path ?? ""} ${citation}`);
			// Each matching line carries a source marker when grep omits surrounding lines.
			for (const line of block.text.split("\n")) lines.push(`${line} ${citation}`);
		}
	}
	writeAtomic(prepared.readablePath, `${lines.join("\n")}\n`);
}

export async function preparePeDocument(
	cwd: string,
	options: PeDocumentOptions,
	signal?: AbortSignal,
): Promise<PreparedPeDocument> {
	signal?.throwIfAborted();
	if (!options.docId?.trim() && !options.path?.trim())
		throw new PeSourceError(400, "Specify a document filename or doc_id");
	const connection = openWritablePeDataset(cwd, options.datasetId);
	let selected: SqlRow | undefined;
	try {
		connection.database.exec(DOCUMENT_SCHEMA);
		if (options.docId)
			selected = connection.database
				.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
				.get(connection.datasetId, options.docId) as SqlRow | undefined;
		else {
			const requested = options.path?.trim() ?? "";
			const path = isAbsolute(requested) ? relative(connection.workspaceRoot, resolve(requested)) : requested;
			if (path.startsWith("..") || isAbsolute(path))
				throw new PeSourceError(400, "Document path is outside the project");
			const name = path.replaceAll("\\", "/").replace(/^raw\//u, "");
			selected = connection.database
				.prepare(
					"SELECT * FROM documents WHERE dataset_id=? AND is_current=1 AND deleted_at IS NULL AND (source_relpath=? OR source_relpath=? OR stored_path=? OR stored_path=?) ORDER BY version_no DESC LIMIT 1",
				)
				.get(
					connection.datasetId,
					name,
					`raw/${name}`,
					`raw/${name}`,
					resolve(connection.workspaceRoot, "raw", name),
				) as SqlRow | undefined;
		}
	} finally {
		connection.database.close();
	}
	const document = selected;
	if (!document) throw new PeSourceError(404, "Document not found in this project's upload catalog");
	const docId = textValue(document, "doc_id") ?? "";
	const filePath = documentFilePath(connection.workspaceRoot, document);
	await verifyOriginal(filePath, textValue(document, "checksum") ?? "", signal);
	const key = `${connection.workspaceRoot}\0${docId}`;
	const existing = preparations.get(key);
	if (existing) return existing;
	const prepare = async (): Promise<PreparedPeDocument> => {
		const directory = cacheDirectory(connection.workspaceRoot);
		const revision = createHash("sha256");
		for (const file of [
			"read_document.py",
			"workbook.py",
			"office.py",
			"excel_formula_parser.py",
			"excel_date_candidates.py",
			"requirements.txt",
		])
			revision.update(readFileSync(join(readerRoot, file)));
		const revisionId = revision.digest("hex");
		const prepared: PreparedPeDocument = {
			document,
			datasetId: connection.datasetId,
			workspaceRoot: connection.workspaceRoot,
			filePath,
			readablePath: join(directory, `${docId}.txt`),
			cachePath: join(directory, `${docId}.json`),
			warnings: [],
		};
		let cache: DocumentCache | undefined;
		if (existsSync(prepared.cachePath)) {
			try {
				cache = readCache(prepared.cachePath);
			} catch {
				/* Rebuild a damaged disposable cache. */
			}
		}
		const inspection = openPeDataset(connection.workspaceRoot, connection.datasetId);
		let storedRevision: string | undefined;
		try {
			storedRevision = textValue(
				(inspection.database.prepare("SELECT revision FROM document_cache WHERE doc_id=?").get(docId) as
					| SqlRow
					| undefined) ?? {},
				"revision",
			);
		} finally {
			inspection.database.close();
		}
		if (cache?.revision !== revisionId || cache.doc_id !== docId || storedRevision !== revisionId) {
			await runReader(connection.workspaceRoot, docId, revisionId, signal);
			cache = readCache(prepared.cachePath);
			writeReadableView(prepared, cache);
		} else if (!existsSync(prepared.readablePath)) writeReadableView(prepared, cache);
		prepared.warnings = cache.warnings;
		return prepared;
	};
	const pending = prepare();
	preparations.set(key, pending);
	try {
		return await pending;
	} finally {
		preparations.delete(key);
	}
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

/** Shared by the agent and the web preview. Always resolve an immutable version. */
export async function resolvePeEvidenceSource(
	cwd: string,
	evidenceId: string,
	signal?: AbortSignal,
): Promise<{ payload: PeSourcePayload; filePath: string }> {
	const reference = parseSourceId(evidenceId);
	if (!reference) throw new PeSourceError(400, "Invalid source ID");
	const prepared = await preparePeDocument(cwd, { docId: reference.docId }, signal);
	const cache = readCache(prepared.cachePath);
	const row = { ...prepared.document, ...sourceLocationRow(reference) };
	const base = {
		dataset_id: prepared.datasetId,
		doc_id: reference.docId,
		version_no: numberValue(row, "version_no") ?? 1,
		evidence_id: evidenceId,
		citation: sourceCitation(row),
		markdown_citation: sourceMarkdownCitation(row, evidenceId),
		filename: sourceFilename(row),
		truncated: false,
		warnings: cache.warnings,
	};
	const location = reference.location;
	const fileType = textValue(row, "file_type");
	if (location.kind === "excel" && (fileType === "xlsx" || fileType === "xlsm")) {
		const bounds = parseExcelCellRange(location.range);
		if (!bounds) throw new PeSourceError(400, "Invalid Excel range");
		const connection = openPeDataset(cwd, prepared.datasetId);
		try {
			const sheet = connection.database
				.prepare("SELECT used_range FROM excel_sheets WHERE doc_id=? AND sheet_name=?")
				.get(reference.docId, location.sheet) as SqlRow | undefined;
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
			const cells = readExcelCellsByBounds(
				connection.database,
				prepared.datasetId,
				reference.docId,
				location.sheet,
				window,
				144,
			);
			return {
				filePath: prepared.filePath,
				payload: {
					...base,
					kind: "excel",
					sheet_name: location.sheet,
					cell_range: location.range,
					grid_window: {
						row_start: window.rowStart,
						row_end: window.rowEnd,
						col_start: window.columnStart,
						col_end: window.columnEnd,
					},
					cells,
					truncated: bounds.rowEnd > window.rowEnd || bounds.columnEnd > window.columnEnd,
				},
			};
		} finally {
			connection.database.close();
		}
	}
	if (location.kind === "pdf" && fileType === "pdf") {
		if (location.pageEnd > cache.blocks.length || location.pageEnd - location.pageStart >= 20)
			throw new PeSourceError(400, "Invalid PDF page range (maximum 20 pages)");
		let budget = 12_000;
		let truncated = false;
		const pages = cache.blocks
			.filter(
				(block) => (block.page_start ?? 0) >= location.pageStart && (block.page_start ?? 0) <= location.pageEnd,
			)
			.map((block) => {
				const text = block.text.slice(0, budget);
				budget -= text.length;
				truncated ||= text.length < block.text.length;
				return { page_number: block.page_start ?? 0, text };
			});
		return {
			filePath: prepared.filePath,
			payload: {
				...base,
				kind: "pdf",
				page_start: location.pageStart,
				page_end: location.pageEnd,
				pdf_pages: pages,
				content: pages.map((page) => page.text).join("\n\n"),
				truncated,
			},
		};
	}
	let content: string | undefined;
	if (location.kind === "text" && cache.text !== undefined) {
		const lines = cache.text.split("\n");
		if (location.lineEnd <= lines.length && location.lineEnd - location.lineStart < 2_000)
			content = lines.slice(location.lineStart - 1, location.lineEnd).join("\n");
	} else if (location.kind === "block" && (fileType === "docx" || fileType === "pptx"))
		content = cache.blocks.find((block) => block.block_index === location.blockIndex)?.text;
	if (content === undefined) throw new PeSourceError(404, "Source location does not exist in this document version");
	return {
		filePath: prepared.filePath,
		payload: { ...base, kind: "text", content: content.slice(0, 12_000), truncated: content.length > 12_000 },
	};
}

/** Resolve citations before saving an artifact or entering its write transaction. */
export async function resolvePeEvidenceSources(
	cwd: string,
	evidenceIds: readonly string[],
	signal?: AbortSignal,
): Promise<Map<string, PeSourcePayload>> {
	const sources = new Map<string, PeSourcePayload>();
	for (const id of new Set(evidenceIds.map((value) => value.trim()))) {
		signal?.throwIfAborted();
		try {
			const { payload } = await resolvePeEvidenceSource(cwd, id, signal);
			sources.set(id, payload);
		} catch {
			signal?.throwIfAborted();
			// Missing, changed, or unreadable originals stay unresolved in the citation audit.
		}
	}
	return sources;
}
