import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openPeCollectionDatabase } from "./collection-schema.ts";
import { type SqlRow, sourceEvidenceId, sourceMarkdownCitation, textValue } from "./tools/database.ts";

export const EXCEL_TABLES = [
	"excel_workbooks",
	"excel_sheets",
	"excel_regions",
	"excel_cells",
	"excel_defined_names",
	"excel_formula_references",
	"valuation_date_candidates",
	"metric_facts",
] as const;
type ExcelTable = (typeof EXCEL_TABLES)[number];
const readerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../python");
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

interface WorkbookResult {
	schema_version: number;
	doc_id: string;
	dataset_id: string;
	revision: string;
	source_sha256: string;
	parser_name: string;
	parser_version: string;
	document_date: string;
	warnings: string[];
	tables: Record<ExcelTable, SqlRow[]>;
	blocks?: DocumentBlock[];
	text?: string;
}

interface DocumentBlock {
	text: string;
	block_index?: number;
	heading_path?: string;
}

interface WorkbookManifest {
	doc_id: string;
	revision: string;
	source_sha256: string;
	blocks: DocumentBlock[];
	text?: string;
	warnings: string[];
	row_counts: Record<ExcelTable, number>;
	workbook_sha256: string;
	readable_sha256: string;
}

export interface PreparedWorkbook {
	cachePath: string;
	readablePath: string;
	warnings: string[];
}

export function excelPython(): string {
	const local = join(readerRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	return (
		process.env.PE_EXCEL_PYTHON?.trim() ||
		process.env.PE_DOCUMENT_PYTHON?.trim() ||
		(existsSync(local) ? local : process.platform === "win32" ? "python" : "python3")
	);
}

export function validatePeExcelUpload(bytes: Uint8Array, fileType: string): void {
	const result = spawnSync(excelPython(), [join(readerRoot, "validate_workbook.py"), fileType], {
		input: bytes,
		encoding: "utf8",
		maxBuffer: 64_000,
		timeout: 30_000,
	});
	if (result.error) throw new Error(`Excel upload validation requires Python 3: ${result.error.message}`);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Invalid OOXML workbook");
}

export async function verifyPeOriginal(filePath: string, checksum: string, signal?: AbortSignal): Promise<void> {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(filePath, { signal })) hash.update(bytes);
	if (hash.digest("hex") !== checksum)
		throw new Error("Original file changed; upload it as a new version before citing it");
}

export function excelParserRevision(): string {
	const hash = createHash("sha256").update("pe-excel-json-v1\0readable-utf8-v4\0");
	for (const filename of [
		"parse_workbook.py",
		"validate_workbook.py",
		"workbook.py",
		"excel_formula_parser.py",
		"excel_date_candidates.py",
		"requirements.txt",
	])
		hash.update(readFileSync(join(readerRoot, filename)));
	return hash.digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResult(value: unknown, document: SqlRow, revision: string, database: DatabaseSync): WorkbookResult {
	const excel = document.file_type === "xlsx" || document.file_type === "xlsm";
	if (
		!object(value) ||
		value.schema_version !== 1 ||
		value.doc_id !== document.doc_id ||
		value.dataset_id !== document.dataset_id ||
		value.revision !== revision ||
		value.source_sha256 !== document.sha256 ||
		(excel
			? value.parser_name !== "openpyxl" || value.parser_version !== "3.1.5"
			: value.parser_version !== "1" ||
				value.parser_name !== (["docx", "pptx"].includes(String(document.file_type)) ? "stdlib_ooxml" : "text")) ||
		typeof value.document_date !== "string" ||
		!Array.isArray(value.warnings) ||
		!value.warnings.every((item) => typeof item === "string") ||
		(excel && !object(value.tables))
	)
		throw new Error("Invalid workbook parser result identity or metadata");
	if (!excel) {
		if (
			!Array.isArray(value.blocks) ||
			!value.blocks.every(
				(block) =>
					object(block) &&
					typeof block.text === "string" &&
					(block.block_index === undefined ||
						(typeof block.block_index === "number" &&
							Number.isInteger(block.block_index) &&
							block.block_index > 0)) &&
					(block.heading_path === undefined || typeof block.heading_path === "string"),
			) ||
			(value.text !== undefined && typeof value.text !== "string")
		)
			throw new Error("Invalid document content");
		return {
			...value,
			tables: Object.fromEntries(EXCEL_TABLES.map((table) => [table, []])),
		} as unknown as WorkbookResult;
	}
	if (!object(value.tables)) throw new Error("Missing workbook tables");
	for (const table of EXCEL_TABLES) {
		const columns = new Set(
			(database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) => row.name),
		);
		const rows = value.tables[table];
		if (!Array.isArray(rows)) throw new Error(`Workbook parser omitted ${table}`);
		for (const row of rows) {
			if (!object(row) || row.doc_id !== document.doc_id || row.dataset_id !== document.dataset_id)
				throw new Error(`Workbook row is outside its registered document: ${table}`);
			for (const [key, item] of Object.entries(row)) {
				if (
					!columns.has(key) ||
					!(item === null || typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))
				)
					throw new Error(`Invalid workbook row field: ${table}.${key}`);
			}
		}
	}
	const result = value as unknown as WorkbookResult;
	if (result.tables.excel_workbooks.length !== 1) throw new Error("Parser must return exactly one workbook");
	const sheets = new Set(result.tables.excel_sheets.map((row) => row.sheet_name));
	const cells = new Set<string>();
	for (const row of result.tables.excel_cells) {
		const expected = createHash("sha256")
			.update(`${document.doc_id}\0${row.sheet_name}\0${row.cell_ref}`)
			.digest("hex")
			.slice(0, 40);
		if (row.cell_id !== expected || !sheets.has(row.sheet_name) || cells.has(expected))
			throw new Error("Invalid workbook cell identity");
		cells.add(expected);
	}
	for (const row of result.tables.excel_formula_references)
		if (!cells.has(String(row.source_cell_id))) throw new Error("Formula reference has no source cell");
	return result;
}

function cachedWorkbook(
	database: DatabaseSync,
	document: SqlRow,
	revision: string,
	directory: string,
	workspaceRoot: string,
): PreparedWorkbook | undefined {
	database.exec("BEGIN");
	try {
		const row = database
			.prepare("SELECT revision,cache_path,readable_path FROM document_cache WHERE doc_id=?")
			.get(document.doc_id) as SqlRow | undefined;
		if (row?.revision !== revision) return undefined;
		const cachePath = resolve(workspaceRoot, String(row.cache_path));
		const readablePath = resolve(workspaceRoot, String(row.readable_path));
		const generationDirectory = dirname(cachePath);
		if (
			cachePath !== join(generationDirectory, "manifest.json") ||
			readablePath !== join(generationDirectory, "readable.txt") ||
			dirname(generationDirectory) !== directory ||
			dirname(readablePath) !== generationDirectory ||
			realpathSync(generationDirectory) !== generationDirectory ||
			realpathSync(cachePath) !== cachePath ||
			realpathSync(readablePath) !== readablePath
		)
			return undefined;
		const workbookPath = join(generationDirectory, "workbook.json");
		if (realpathSync(workbookPath) !== workbookPath) return undefined;
		const manifest: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
		if (
			!object(manifest) ||
			manifest.doc_id !== document.doc_id ||
			manifest.revision !== revision ||
			manifest.source_sha256 !== document.sha256 ||
			!object(manifest.row_counts) ||
			!Array.isArray(manifest.warnings) ||
			!manifest.warnings.every((item) => typeof item === "string") ||
			!Array.isArray(manifest.blocks) ||
			!manifest.blocks.every((block) => object(block) && typeof block.text === "string") ||
			(manifest.text !== undefined && typeof manifest.text !== "string")
		)
			return undefined;
		if (
			createHash("sha256").update(readFileSync(workbookPath)).digest("hex") !== manifest.workbook_sha256 ||
			createHash("sha256").update(readFileSync(readablePath)).digest("hex") !== manifest.readable_sha256
		)
			return undefined;
		for (const table of EXCEL_TABLES) {
			const count = database
				.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE doc_id=?`)
				.get(document.doc_id) as SqlRow;
			if (count.count !== manifest.row_counts[table]) return undefined;
		}
		return { cachePath, readablePath, warnings: manifest.warnings as string[] };
	} catch {
		return undefined;
	} finally {
		database.exec("COMMIT");
	}
}

function claim(
	database: DatabaseSync,
	document: SqlRow,
	revision: string,
	ownerId: string,
	waited: boolean,
	expectedCachePath: string | undefined,
): boolean {
	const jobKey = `${document.doc_id}:${revision}`;
	database.exec("BEGIN IMMEDIATE");
	try {
		const cache = database.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?").get(document.doc_id) as
			| SqlRow
			| undefined;
		if (textValue(cache ?? {}, "cache_path") !== expectedCachePath) {
			database.exec("COMMIT");
			return false;
		}
		const row = database.prepare("SELECT * FROM processing_jobs WHERE job_key=?").get(jobKey) as SqlRow | undefined;
		if (
			database
				.prepare("SELECT 1 FROM processing_jobs WHERE doc_id=? AND status='processing' AND lease_expires_at>?")
				.get(document.doc_id, Date.now())
		) {
			database.exec("COMMIT");
			return false;
		}
		if (waited && row?.status === "failed") throw new Error(textValue(row, "error") || "Workbook preparation failed");
		const now = new Date().toISOString();
		database
			.prepare(`INSERT INTO processing_jobs (job_key,doc_id,revision,status,owner_id,lease_expires_at,attempt,error,created_at,updated_at)
			VALUES (?,?,?,'processing',?,?,1,'',?,?) ON CONFLICT(job_key) DO UPDATE SET
			status='processing',owner_id=excluded.owner_id,lease_expires_at=excluded.lease_expires_at,
			attempt=processing_jobs.attempt+1,error='',updated_at=excluded.updated_at`)
			.run(jobKey, document.doc_id, revision, ownerId, Date.now() + LEASE_MS, now, now);
		database
			.prepare("UPDATE documents SET status='processing',updated_at=? WHERE doc_id=? AND deleted_at IS NULL")
			.run(now, document.doc_id);
		database.exec("COMMIT");
		return true;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function runParser(
	filePath: string,
	output: string,
	document: SqlRow,
	revision: string,
	signal: AbortSignal,
): Promise<void> {
	const args = [
		join(
			readerRoot,
			document.file_type === "xlsx" || document.file_type === "xlsm" ? "parse_workbook.py" : "read_document.py",
		),
		"--input",
		filePath,
		"--output",
		output,
		"--doc-id",
		String(document.doc_id),
		"--dataset-id",
		String(document.dataset_id),
		"--revision",
		revision,
		"--sha256",
		String(document.sha256),
		"--filename",
		String(document.original_filename),
		"--modified-at",
		statSync(filePath).mtime.toISOString(),
	];
	return new Promise((resolveParser, reject) => {
		signal.throwIfAborted();
		const child = spawn(excelPython(), args, { stdio: ["ignore", "ignore", "pipe"] });
		let failure: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = (reason: Error) => {
			failure ??= reason;
			child.kill("SIGTERM");
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
			killTimer.unref();
		};
		const aborted = () =>
			stop(signal.reason instanceof Error ? signal.reason : new Error("Workbook preparation aborted"));
		signal.addEventListener("abort", aborted, { once: true });
		const configuredTimeout = Number(process.env.PE_EXCEL_TIMEOUT_MS);
		const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15 * 60_000;
		const timer = setTimeout(() => {
			stop(new Error(`Workbook parser exceeded ${timeoutMs} ms`));
		}, timeoutMs);
		timer.unref();
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => {
			error = (error + chunk.toString()).slice(-8_000);
		});
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", aborted);
			code === 0 && !failure
				? resolveParser()
				: reject(
						failure ??
							new Error(
								error.trim() ||
									`Workbook parser exited with code ${code}; run npm run setup:python --workspace=@earendil-works/pe-boot`,
							),
					);
		});
	});
}

function publish(
	database: DatabaseSync,
	document: SqlRow,
	revision: string,
	ownerId: string,
	result: WorkbookResult,
	directory: string,
	workspaceRoot: string,
): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		const job = database
			.prepare("SELECT owner_id FROM processing_jobs WHERE job_key=? AND status='processing' AND lease_expires_at>?")
			.get(`${document.doc_id}:${revision}`, Date.now()) as SqlRow | undefined;
		if (job?.owner_id !== ownerId) throw new Error("Workbook processing lease was lost");
		if (
			!database
				.prepare("SELECT 1 FROM documents WHERE doc_id=? AND sha256=? AND deleted_at IS NULL")
				.get(document.doc_id, document.sha256)
		)
			throw new Error("Workbook version was removed during preparation");
		for (const table of [...EXCEL_TABLES].reverse())
			database.prepare(`DELETE FROM ${table} WHERE doc_id=?`).run(document.doc_id);
		for (const table of EXCEL_TABLES) {
			const rows = result.tables[table];
			if (rows.length === 0) continue;
			const columns = Object.keys(rows[0]);
			const statement = database.prepare(
				`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			);
			for (const row of rows) statement.run(...columns.map((column) => row[column] ?? null));
		}
		const evidence = database.prepare(
			"INSERT OR IGNORE INTO evidence_locations (evidence_id,doc_id,sheet_name,cell_range) VALUES (?,?,?,?)",
		);
		for (const row of result.tables.excel_cells)
			evidence.run(`cell:${row.cell_id}`, document.doc_id, row.sheet_name, row.cell_ref);
		for (const row of result.tables.metric_facts)
			evidence.run(`fact:${row.fact_id}`, document.doc_id, row.sheet_name, row.cell_ref);
		const rel = (file: string) => relative(workspaceRoot, join(directory, file)).replaceAll("\\", "/");
		const now = new Date().toISOString();
		database
			.prepare(`INSERT INTO document_cache (doc_id,revision,prepared_at,cache_path,readable_path) VALUES (?,?,?,?,?)
			ON CONFLICT(doc_id) DO UPDATE SET revision=excluded.revision,prepared_at=excluded.prepared_at,cache_path=excluded.cache_path,readable_path=excluded.readable_path`)
			.run(document.doc_id, revision, now, rel("manifest.json"), rel("readable.txt"));
		database
			.prepare(`UPDATE documents SET status=?,parser_name=?,parser_version=?,document_date=?,artifact_directory=?,
			document_markdown_path=?,readable_text_path=?,warnings_json=?,updated_at=? WHERE doc_id=?`)
			.run(
				result.warnings.length > 0 ? "completed_with_warnings" : "completed",
				result.parser_name,
				result.parser_version,
				result.document_date,
				relative(workspaceRoot, directory).replaceAll("\\", "/"),
				rel("readable.txt"),
				rel("readable.txt"),
				JSON.stringify(result.warnings),
				now,
				document.doc_id,
			);
		database
			.prepare(
				"UPDATE processing_jobs SET status='completed',lease_expires_at=0,error='',updated_at=? WHERE job_key=? AND owner_id=?",
			)
			.run(now, `${document.doc_id}:${revision}`, ownerId);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

export async function prepareWorkbook(
	workspaceRoot: string,
	document: SqlRow,
	filePath: string,
	signal?: AbortSignal,
): Promise<PreparedWorkbook> {
	const excel = document.file_type === "xlsx" || document.file_type === "xlsm";
	const revision = excel
		? excelParserRevision()
		: createHash("sha256")
				.update("pe-document-json-v1\0")
				.update(readFileSync(join(readerRoot, "read_document.py")))
				.update(readFileSync(join(readerRoot, "office.py")))
				.digest("hex");
	const documentDirectory = join(workspaceRoot, "meta", excel ? "excel" : "read-cache", String(document.doc_id));
	mkdirSync(documentDirectory, { recursive: true });
	if (realpathSync(documentDirectory) !== documentDirectory) throw new Error("Excel cache must not be a symlink");
	const directory = join(documentDirectory, revision);
	mkdirSync(directory, { recursive: true });
	if (realpathSync(directory) !== directory) throw new Error("Excel revision directory must not be a symlink");
	const database = openPeCollectionDatabase(join(workspaceRoot, "meta", "collection.sqlite3"));
	const ownerId = randomUUID();
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", forwardAbort, { once: true });
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let claimed = false;
	let stage: string | undefined;
	try {
		let waited = false;
		for (;;) {
			signal?.throwIfAborted();
			const observedCache = database
				.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?")
				.get(document.doc_id) as SqlRow | undefined;
			const existing = cachedWorkbook(database, document, revision, directory, workspaceRoot);
			if (existing) return existing;
			if (claim(database, document, revision, ownerId, waited, textValue(observedCache ?? {}, "cache_path"))) {
				claimed = true;
				break;
			}
			waited = true;
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
		}
		heartbeat = setInterval(() => {
			try {
				const updated = database
					.prepare(
						"UPDATE processing_jobs SET lease_expires_at=?,updated_at=? WHERE job_key=? AND owner_id=? AND status='processing' AND lease_expires_at>?",
					)
					.run(
						Date.now() + LEASE_MS,
						new Date().toISOString(),
						`${document.doc_id}:${revision}`,
						ownerId,
						Date.now(),
					);
				if (Number(updated.changes) !== 1) controller.abort(new Error("Workbook processing lease was lost"));
			} catch (error) {
				controller.abort(error);
			}
		}, HEARTBEAT_MS);
		heartbeat.unref();
		const published = database.prepare("SELECT cache_path FROM document_cache WHERE doc_id=?").get(document.doc_id) as
			| SqlRow
			| undefined;
		const publishedDirectory = published ? dirname(resolve(workspaceRoot, String(published.cache_path))) : undefined;
		for (const entry of readdirSync(directory)) {
			if (!/^\.?[a-f0-9-]{36}(?:\.tmp)?$/u.test(entry)) continue;
			const path = join(directory, entry);
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink() || path === publishedDirectory) continue;
			const retention = entry.endsWith(".tmp") ? LEASE_MS : 24 * 60 * 60_000;
			if (Date.now() - stat.mtimeMs > retention) rmSync(path, { recursive: true, force: true });
		}
		stage = join(directory, `.${ownerId}.tmp`);
		mkdirSync(stage);
		const output = join(stage, "workbook.json");
		await runParser(filePath, output, document, revision, controller.signal);
		controller.signal.throwIfAborted();
		const result = validateResult(JSON.parse(readFileSync(output, "utf8")) as unknown, document, revision, database);
		await verifyPeOriginal(filePath, String(document.sha256), controller.signal);
		const lines = [
			`# ${document.original_filename} (version ${document.version_no})`,
			...result.warnings.map((warning) => `Warning: ${warning}`),
		];
		for (const sheet of result.tables.excel_sheets)
			lines.push(`Sheet: ${sheet.sheet_name} | ${sheet.used_range || "empty"} | ${sheet.sheet_state}`);
		for (const cell of [...result.tables.excel_cells].sort(
			(left, right) =>
				Buffer.compare(
					Buffer.from(String(left.sheet_name), "utf8"),
					Buffer.from(String(right.sheet_name), "utf8"),
				) ||
				Number(left.row_index) - Number(right.row_index) ||
				Number(left.col_index) - Number(right.col_index),
		)) {
			const row: SqlRow = { ...document, ...cell };
			lines.push(
				`${document.original_filename} ${cell.sheet_name}!${cell.cell_ref} | value=${JSON.stringify(cell.raw_value ?? "")} | cached=${JSON.stringify(cell.cached_value ?? "")} | formula=${JSON.stringify(cell.formula ?? "")} | ${sourceMarkdownCitation(row, sourceEvidenceId(row))}`,
			);
		}
		if (result.text !== undefined) {
			for (const [index, line] of result.text.split("\n").entries()) {
				const row = { ...document, line_start: index + 1, line_end: index + 1 };
				lines.push(`${line} ${sourceMarkdownCitation(row, sourceEvidenceId(row))}`);
			}
		} else
			for (const block of result.blocks ?? []) {
				const row = { ...document, ...block };
				const citation = sourceMarkdownCitation(row, sourceEvidenceId(row));
				lines.push(`\n${block.heading_path ?? ""} ${citation}`);
				for (const line of block.text.split("\n")) lines.push(`${line} ${citation}`);
			}
		const readable = `${lines.join("\n")}\n`;
		writeFileSync(join(stage, "readable.txt"), readable, { flag: "wx", mode: 0o600 });
		const manifest: WorkbookManifest = {
			doc_id: String(document.doc_id),
			revision,
			source_sha256: String(document.sha256),
			blocks: result.blocks ?? [],
			...(result.text === undefined ? {} : { text: result.text }),
			warnings: result.warnings,
			row_counts: Object.fromEntries(EXCEL_TABLES.map((table) => [table, result.tables[table].length])) as Record<
				ExcelTable,
				number
			>,
			workbook_sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
			readable_sha256: createHash("sha256").update(readable).digest("hex"),
		};
		writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
		// Generations are immutable. Only the transaction below changes the visible pointer.
		const generation = join(directory, ownerId);
		renameSync(stage, generation);
		stage = undefined;
		publish(database, document, revision, ownerId, result, generation, workspaceRoot);
		return {
			cachePath: join(generation, "manifest.json"),
			readablePath: join(generation, "readable.txt"),
			warnings: result.warnings,
		};
	} catch (error) {
		if (claimed) {
			const message = error instanceof Error ? error.message : String(error);
			const now = new Date().toISOString();
			database.exec("BEGIN IMMEDIATE");
			try {
				const updated = database
					.prepare(
						"UPDATE processing_jobs SET status='failed',lease_expires_at=0,error=?,updated_at=? WHERE job_key=? AND owner_id=? AND status='processing'",
					)
					.run(message, now, `${document.doc_id}:${revision}`, ownerId);
				if (Number(updated.changes) > 0)
					database
						.prepare(`UPDATE documents SET status='failed',warnings_json=?,updated_at=?
							WHERE doc_id=? AND status='processing' AND NOT EXISTS (
								SELECT 1 FROM processing_jobs WHERE doc_id=? AND job_key<>?
								AND status='processing' AND lease_expires_at>?
							)`)
						.run(
							JSON.stringify([message]),
							now,
							document.doc_id,
							document.doc_id,
							`${document.doc_id}:${revision}`,
							Date.now(),
						);
				database.exec("COMMIT");
			} catch {
				database.exec("ROLLBACK");
			}
		}
		throw error;
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		signal?.removeEventListener("abort", forwardAbort);
		if (stage) rmSync(stage, { recursive: true, force: true });
		database.close();
	}
}
