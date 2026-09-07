import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
const parserRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../python");
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
}

interface WorkbookManifest {
	doc_id: string;
	revision: string;
	source_sha256: string;
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

interface PublishedFiles {
	artifactDirectory: string;
	readablePath: string;
	backupDirectory?: string;
	backupReadable?: string;
}

export function excelPython(): string {
	const local = join(parserRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	return (
		process.env.PE_EXCEL_PYTHON?.trim() ||
		process.env.PE_DOCUMENT_PYTHON?.trim() ||
		(existsSync(local) ? local : process.platform === "win32" ? "python" : "python3")
	);
}

export function validatePeExcelUpload(bytes: Uint8Array, fileType: string): void {
	const result = spawnSync(excelPython(), [join(parserRoot, "validate_workbook.py"), fileType], {
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
	if (hash.digest("hex") !== checksum) throw new Error("Original file changed after it was registered");
}

export function excelParserRevision(): string {
	const hash = createHash("sha256").update("pe-excel-json-v1\0readable-utf8-v3\0");
	for (const filename of [
		"parse_workbook.py",
		"validate_workbook.py",
		"workbook.py",
		"excel_formula_parser.py",
		"excel_date_candidates.py",
		"requirements.txt",
	]) {
		hash.update(readFileSync(join(parserRoot, filename)));
	}
	return hash.digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResult(value: unknown, document: SqlRow, revision: string, database: DatabaseSync): WorkbookResult {
	if (
		!object(value) ||
		value.schema_version !== 1 ||
		value.doc_id !== document.doc_id ||
		value.dataset_id !== document.dataset_id ||
		value.revision !== revision ||
		value.source_sha256 !== document.sha256 ||
		value.parser_name !== "openpyxl" ||
		value.parser_version !== "3.1.5" ||
		typeof value.document_date !== "string" ||
		!Array.isArray(value.warnings) ||
		!value.warnings.every((item) => typeof item === "string") ||
		!object(value.tables)
	) {
		throw new Error("Invalid workbook parser result identity or metadata");
	}
	for (const table of EXCEL_TABLES) {
		const columns = new Set(
			(database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) => row.name),
		);
		const rows = value.tables[table];
		if (!Array.isArray(rows)) throw new Error(`Workbook parser omitted ${table}`);
		for (const row of rows) {
			if (!object(row) || row.doc_id !== document.doc_id || row.dataset_id !== document.dataset_id) {
				throw new Error(`Workbook row is outside its registered document: ${table}`);
			}
			for (const [key, item] of Object.entries(row)) {
				if (
					!columns.has(key) ||
					!(item === null || typeof item === "string" || (typeof item === "number" && Number.isFinite(item)))
				) {
					throw new Error(`Invalid workbook row field: ${table}.${key}`);
				}
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
		if (row.cell_id !== expected || !sheets.has(row.sheet_name) || cells.has(expected)) {
			throw new Error("Invalid workbook cell identity");
		}
		cells.add(expected);
	}
	for (const row of result.tables.excel_formula_references) {
		if (!cells.has(String(row.source_cell_id))) throw new Error("Formula reference has no source cell");
	}
	return result;
}

function within(root: string, candidate: string): boolean {
	const local = relative(root, candidate);
	return !local.startsWith("..") && !isAbsolute(local);
}

function artifactPaths(workspaceRoot: string, document: SqlRow): { directory: string; readable: string } {
	const filename = textValue(document, "original_filename");
	if (!filename || basename(filename) !== filename) throw new Error("Invalid registered Excel filename");
	const directory = resolve(workspaceRoot, "meta", "documents", filename);
	const readable = resolve(workspaceRoot, "meta", "text", `${filename}.txt`);
	if (!within(workspaceRoot, directory) || !within(workspaceRoot, readable)) {
		throw new Error("Excel artifacts resolve outside the project workspace");
	}
	return { directory, readable };
}

function cachedWorkbook(
	database: DatabaseSync,
	document: SqlRow,
	revision: string,
	workspaceRoot: string,
): PreparedWorkbook | undefined {
	try {
		const row = database
			.prepare("SELECT revision,cache_path,readable_path FROM document_cache WHERE doc_id=?")
			.get(document.doc_id) as SqlRow | undefined;
		if (row?.revision !== revision) return undefined;
		const cachePath = resolve(workspaceRoot, String(row.cache_path));
		const readablePath = resolve(workspaceRoot, String(row.readable_path));
		const expected = artifactPaths(workspaceRoot, document);
		if (
			cachePath !== join(expected.directory, "manifest.json") ||
			readablePath !== expected.readable ||
			realpathSync(dirname(cachePath)) !== expected.directory ||
			realpathSync(cachePath) !== cachePath ||
			realpathSync(readablePath) !== readablePath
		) {
			return undefined;
		}
		const workbookPath = join(expected.directory, "workbook.json");
		if (realpathSync(workbookPath) !== workbookPath) return undefined;
		const manifest: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
		if (
			!object(manifest) ||
			manifest.doc_id !== document.doc_id ||
			manifest.revision !== revision ||
			manifest.source_sha256 !== document.sha256 ||
			!object(manifest.row_counts) ||
			!Array.isArray(manifest.warnings) ||
			!manifest.warnings.every((item) => typeof item === "string")
		) {
			return undefined;
		}
		if (
			createHash("sha256").update(readFileSync(workbookPath)).digest("hex") !== manifest.workbook_sha256 ||
			createHash("sha256").update(readFileSync(readablePath)).digest("hex") !== manifest.readable_sha256
		) {
			return undefined;
		}
		for (const table of EXCEL_TABLES) {
			const count = database
				.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE doc_id=?`)
				.get(document.doc_id) as SqlRow;
			if (count.count !== manifest.row_counts[table]) return undefined;
		}
		return { cachePath, readablePath, warnings: manifest.warnings as string[] };
	} catch {
		return undefined;
	}
}

function claim(database: DatabaseSync, document: SqlRow, revision: string, ownerId: string): boolean {
	const jobKey = `${document.doc_id}:${revision}`;
	database.exec("BEGIN IMMEDIATE");
	try {
		if (
			database
				.prepare("SELECT 1 FROM processing_jobs WHERE doc_id=? AND status='processing' AND lease_expires_at>?")
				.get(document.doc_id, Date.now())
		) {
			database.exec("COMMIT");
			return false;
		}
		const now = new Date().toISOString();
		database
			.prepare(`INSERT INTO processing_jobs
				(job_key,doc_id,revision,status,owner_id,lease_expires_at,attempt,error,created_at,updated_at)
				VALUES (?,?,?,'processing',?,?,1,'',?,?)
				ON CONFLICT(job_key) DO UPDATE SET status='processing',owner_id=excluded.owner_id,
				lease_expires_at=excluded.lease_expires_at,attempt=processing_jobs.attempt+1,error='',updated_at=excluded.updated_at`)
			.run(jobKey, document.doc_id, revision, ownerId, Date.now() + LEASE_MS, now, now);
		database
			.prepare("UPDATE documents SET status='processing',updated_at=? WHERE doc_id=?")
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
		join(parserRoot, "parse_workbook.py"),
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
		const timer = setTimeout(() => stop(new Error(`Workbook parser exceeded ${timeoutMs} ms`)), timeoutMs);
		timer.unref();
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => {
			error = (error + chunk.toString()).slice(-8_000);
		});
		child.once("error", (cause) => {
			failure = cause;
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", aborted);
			if (code === 0 && !failure) {
				resolveParser();
				return;
			}
			reject(
				failure ??
					new Error(
						error.trim() ||
							`Workbook parser exited with code ${code}; run npm run setup:python --workspace=@earendil-works/pe-boot`,
					),
			);
		});
	});
}

function installFiles(
	workspaceRoot: string,
	document: SqlRow,
	stageDirectory: string,
	ownerId: string,
): PublishedFiles {
	const target = artifactPaths(workspaceRoot, document);
	mkdirSync(dirname(target.directory), { recursive: true });
	mkdirSync(dirname(target.readable), { recursive: true });
	const backupDirectory = `${stageDirectory}.artifact-backup`;
	const backupReadable = `${stageDirectory}.readable-backup`;
	if (existsSync(target.directory)) renameSync(target.directory, backupDirectory);
	if (existsSync(target.readable)) renameSync(target.readable, backupReadable);
	try {
		renameSync(join(stageDirectory, "artifact"), target.directory);
		renameSync(join(stageDirectory, "readable.txt"), target.readable);
		return {
			artifactDirectory: target.directory,
			readablePath: target.readable,
			...(existsSync(backupDirectory) ? { backupDirectory } : {}),
			...(existsSync(backupReadable) ? { backupReadable } : {}),
		};
	} catch (error) {
		rmSync(target.directory, { recursive: true, force: true });
		rmSync(target.readable, { force: true });
		if (existsSync(backupDirectory)) renameSync(backupDirectory, target.directory);
		if (existsSync(backupReadable)) renameSync(backupReadable, target.readable);
		throw new Error(`Failed to publish Excel artifacts for ${ownerId}`, { cause: error });
	}
}

function restoreFiles(files: PublishedFiles): void {
	rmSync(files.artifactDirectory, { recursive: true, force: true });
	rmSync(files.readablePath, { force: true });
	if (files.backupDirectory) renameSync(files.backupDirectory, files.artifactDirectory);
	if (files.backupReadable) renameSync(files.backupReadable, files.readablePath);
}

function finishFiles(files: PublishedFiles): void {
	if (files.backupDirectory) rmSync(files.backupDirectory, { recursive: true, force: true });
	if (files.backupReadable) rmSync(files.backupReadable, { force: true });
}

function publish(
	database: DatabaseSync,
	document: SqlRow,
	revision: string,
	ownerId: string,
	result: WorkbookResult,
	stageDirectory: string,
	workspaceRoot: string,
): PreparedWorkbook {
	let files: PublishedFiles | undefined;
	database.exec("BEGIN IMMEDIATE");
	try {
		const job = database
			.prepare("SELECT owner_id FROM processing_jobs WHERE job_key=? AND status='processing' AND lease_expires_at>?")
			.get(`${document.doc_id}:${revision}`, Date.now()) as SqlRow | undefined;
		if (job?.owner_id !== ownerId) throw new Error("Workbook processing lease was lost");
		if (
			!database.prepare("SELECT 1 FROM documents WHERE doc_id=? AND sha256=?").get(document.doc_id, document.sha256)
		) {
			throw new Error("Workbook was removed during preparation");
		}
		for (const table of [...EXCEL_TABLES].reverse()) {
			database.prepare(`DELETE FROM ${table} WHERE doc_id=?`).run(document.doc_id);
		}
		for (const table of EXCEL_TABLES) {
			const rows = result.tables[table];
			if (rows.length === 0) continue;
			const columns = Object.keys(rows[0]);
			const statement = database.prepare(
				`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			);
			for (const row of rows) statement.run(...columns.map((column) => row[column] ?? null));
		}
		files = installFiles(workspaceRoot, document, stageDirectory, ownerId);
		const rel = (path: string) => relative(workspaceRoot, path).replaceAll("\\", "/");
		const manifestPath = join(files.artifactDirectory, "manifest.json");
		const now = new Date().toISOString();
		database
			.prepare(`INSERT INTO document_cache (doc_id,revision,prepared_at,cache_path,readable_path) VALUES (?,?,?,?,?)
				ON CONFLICT(doc_id) DO UPDATE SET revision=excluded.revision,prepared_at=excluded.prepared_at,
				cache_path=excluded.cache_path,readable_path=excluded.readable_path`)
			.run(document.doc_id, revision, now, rel(manifestPath), rel(files.readablePath));
		database
			.prepare(`UPDATE documents SET status=?,parser_name=?,parser_version=?,document_date=?,artifact_directory=?,
				document_markdown_path='',layout_json_path='',readable_text_path=?,warnings_json=?,updated_at=? WHERE doc_id=?`)
			.run(
				result.warnings.length > 0 ? "completed_with_warnings" : "completed",
				result.parser_name,
				result.parser_version,
				result.document_date,
				rel(files.artifactDirectory),
				rel(files.readablePath),
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
		finishFiles(files);
		return { cachePath: manifestPath, readablePath: files.readablePath, warnings: result.warnings };
	} catch (error) {
		database.exec("ROLLBACK");
		if (files) restoreFiles(files);
		throw error;
	}
}

export async function prepareWorkbook(
	workspaceRoot: string,
	document: SqlRow,
	filePath: string,
	signal?: AbortSignal,
): Promise<PreparedWorkbook> {
	const revision = excelParserRevision();
	const stagingRoot = join(workspaceRoot, "meta", ".excel-staging");
	mkdirSync(stagingRoot, { recursive: true });
	if (realpathSync(stagingRoot) !== stagingRoot) throw new Error("Excel staging directory must not be a symlink");
	const database = openPeCollectionDatabase(join(workspaceRoot, "meta", "collection.sqlite3"));
	const ownerId = randomUUID();
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", forwardAbort, { once: true });
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let claimed = false;
	const stageDirectory = join(stagingRoot, ownerId);
	try {
		for (;;) {
			signal?.throwIfAborted();
			const existing = cachedWorkbook(database, document, revision, workspaceRoot);
			if (existing) return existing;
			if (claim(database, document, revision, ownerId)) {
				claimed = true;
				break;
			}
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
		mkdirSync(join(stageDirectory, "artifact"), { recursive: true });
		const workbookPath = join(stageDirectory, "artifact", "workbook.json");
		await runParser(filePath, workbookPath, document, revision, controller.signal);
		controller.signal.throwIfAborted();
		const result = validateResult(
			JSON.parse(readFileSync(workbookPath, "utf8")) as unknown,
			document,
			revision,
			database,
		);
		await verifyPeOriginal(filePath, String(document.sha256), controller.signal);
		const lines = [`# ${document.original_filename}`, ...result.warnings.map((warning) => `Warning: ${warning}`)];
		for (const sheet of result.tables.excel_sheets) {
			lines.push(`Sheet: ${sheet.sheet_name} | ${sheet.used_range || "empty"} | ${sheet.sheet_state}`);
		}
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
		const readable = `${lines.join("\n")}\n`;
		writeFileSync(join(stageDirectory, "readable.txt"), readable, { flag: "wx", mode: 0o600 });
		const manifest: WorkbookManifest = {
			doc_id: String(document.doc_id),
			revision,
			source_sha256: String(document.sha256),
			warnings: result.warnings,
			row_counts: Object.fromEntries(EXCEL_TABLES.map((table) => [table, result.tables[table].length])) as Record<
				ExcelTable,
				number
			>,
			workbook_sha256: createHash("sha256").update(readFileSync(workbookPath)).digest("hex"),
			readable_sha256: createHash("sha256").update(readable).digest("hex"),
		};
		writeFileSync(join(stageDirectory, "artifact", "manifest.json"), JSON.stringify(manifest), {
			flag: "wx",
			mode: 0o600,
		});
		return publish(database, document, revision, ownerId, result, stageDirectory, workspaceRoot);
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
				if (Number(updated.changes) > 0) {
					database
						.prepare("UPDATE documents SET status='failed',warnings_json=?,updated_at=? WHERE doc_id=?")
						.run(JSON.stringify([message]), now, document.doc_id);
				}
				database.exec("COMMIT");
			} catch {
				database.exec("ROLLBACK");
			}
		}
		throw error;
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		signal?.removeEventListener("abort", forwardAbort);
		rmSync(stageDirectory, { recursive: true, force: true });
		database.close();
	}
}
