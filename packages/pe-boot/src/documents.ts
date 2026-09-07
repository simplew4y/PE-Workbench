import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { initializePeCollectionDatabase } from "./collection-schema.ts";
import { prepareWorkbook, validatePeExcelUpload, verifyPeOriginal } from "./excel-processing.ts";
import { documentFilePath, openPeDataset, openWritablePeDataset, type SqlRow, textValue } from "./tools/database.ts";

export const DOCUMENT_EXTENSIONS = new Set([".xlsx", ".xlsm"]);

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

function projectRoot(cwd: string): string {
	const root = realpathSync(cwd);
	for (const name of ["raw", "meta"]) {
		const entry = lstatSync(join(root, name));
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new PeSourceError(400, `${name}/ must be a real project directory`);
		}
	}
	const database = join(root, "meta", "collection.sqlite3");
	if (existsSync(database) && lstatSync(database).isSymbolicLink()) {
		throw new PeSourceError(400, "Project database must not be a symlink");
	}
	return root;
}

function normalizeExcelFilename(value: string): { filename: string; extension: ".xlsx" | ".xlsm"; key: string } {
	const filename = value.normalize("NFKC").trim();
	const extension = extname(filename).toLowerCase();
	if (
		basename(filename) !== filename ||
		/[\\/\x00-\x1f<>:"|?*]/u.test(filename) ||
		!DOCUMENT_EXTENSIONS.has(extension)
	) {
		throw new PeSourceError(400, `Unsupported Excel filename: ${value}`);
	}
	return {
		filename,
		extension: extension as ".xlsx" | ".xlsm",
		key: filename.toLocaleLowerCase("und"),
	};
}

export function registerPeDocuments(
	cwd: string,
	datasetId: string,
	files: Array<{ name: string; bytes: Uint8Array }>,
): { documents: SqlRow[]; fileCount: number } {
	const root = projectRoot(cwd);
	const inputs = files.map(({ name, bytes }) => {
		const normalized = normalizeExcelFilename(name);
		try {
			validatePeExcelUpload(bytes, normalized.extension.slice(1));
		} catch (error) {
			throw new PeSourceError(400, error instanceof Error ? error.message : String(error));
		}
		return {
			...normalized,
			bytes,
			checksum: createHash("sha256").update(bytes).digest("hex"),
		};
	});
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	const connection = openWritablePeDataset(root, datasetId);
	const database = connection.database;
	const createdFiles: string[] = [];
	try {
		database.exec("BEGIN IMMEDIATE");
		const documents: SqlRow[] = [];
		for (const input of inputs) {
			const existing = database
				.prepare(
					"SELECT original_filename,sha256 FROM documents WHERE dataset_id=? AND (filename_key=? OR sha256=?) LIMIT 1",
				)
				.get(datasetId, input.key, input.checksum) as SqlRow | undefined;
			if (existing) {
				const duplicate = textValue(existing, "sha256") === input.checksum ? "content" : "filename";
				throw new PeSourceError(
					409,
					`Excel ${duplicate} already exists in this project: ${textValue(existing, "original_filename") ?? input.filename}`,
				);
			}
			const target = join(root, "raw", input.filename);
			if (existsSync(target))
				throw new PeSourceError(409, `Excel filename already exists in raw/: ${input.filename}`);
			writeFileSync(target, input.bytes, { flag: "wx", mode: 0o600 });
			createdFiles.push(target);
			const docId = `doc_${createHash("sha256").update(`${datasetId}\0${input.checksum}`).digest("hex").slice(0, 24)}`;
			const now = new Date().toISOString();
			const artifactDirectory = `meta/documents/${input.filename}`;
			const readableTextPath = `meta/text/${input.filename}.txt`;
			database
				.prepare(`INSERT INTO documents
				(doc_id,dataset_id,original_filename,filename_key,raw_path,sha256,status,page_count,parser_name,parser_version,
				title,brokerage,document_date,rating,target_price,exhibits_json,pdf_metadata_json,artifact_directory,
				document_markdown_path,layout_json_path,warnings_json,created_at,updated_at,file_type,source_relpath,file_size,readable_text_path)
				VALUES (?,?,?,?,?,?,'queued',0,'','',?,'','','','','[]','{}',?,'','','[]',?,?,?, ?,?,?)`)
				.run(
					docId,
					datasetId,
					input.filename,
					input.key,
					`raw/${input.filename}`,
					input.checksum,
					input.filename.slice(0, -input.extension.length),
					artifactDirectory,
					now,
					now,
					input.extension.slice(1),
					input.filename,
					input.bytes.byteLength,
					readableTextPath,
				);
			documents.push(database.prepare("SELECT * FROM documents WHERE doc_id=?").get(docId) as SqlRow);
		}
		const count = database
			.prepare("SELECT COUNT(*) AS count FROM documents WHERE dataset_id=?")
			.get(datasetId) as SqlRow;
		database.exec("COMMIT");
		return { documents, fileCount: Number(count.count) };
	} catch (error) {
		database.exec("ROLLBACK");
		for (const file of createdFiles) rmSync(file, { force: true });
		throw error;
	} finally {
		database.close();
	}
}

export async function preparePeDocument(
	cwd: string,
	options: PeDocumentOptions,
	signal?: AbortSignal,
): Promise<PreparedPeDocument> {
	signal?.throwIfAborted();
	if (!options.docId?.trim() && !options.path?.trim())
		throw new PeSourceError(400, "Specify an Excel filename or doc_id");
	const root = projectRoot(cwd);
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	const connection = openPeDataset(root, options.datasetId);
	let document: SqlRow | undefined;
	try {
		if (options.docId) {
			document = connection.database
				.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND file_type IN ('xlsx','xlsm')")
				.get(connection.datasetId, options.docId) as SqlRow | undefined;
		} else {
			const requested = options.path?.trim() ?? "";
			const local = isAbsolute(requested) ? relative(root, resolve(requested)) : requested;
			if (local.startsWith("..") || isAbsolute(local))
				throw new PeSourceError(400, "Document path is outside the project");
			const name = local.replaceAll("\\", "/").replace(/^raw\//u, "");
			const normalized = normalizeExcelFilename(name);
			document = connection.database
				.prepare("SELECT * FROM documents WHERE dataset_id=? AND filename_key=? AND file_type IN ('xlsx','xlsm')")
				.get(connection.datasetId, normalized.key) as SqlRow | undefined;
		}
	} finally {
		connection.database.close();
	}
	if (!document) throw new PeSourceError(404, "Excel document not found in the current project");
	let filePath: string;
	try {
		filePath = documentFilePath(root, document);
		await verifyPeOriginal(filePath, textValue(document, "sha256") ?? "", signal);
	} catch (error) {
		signal?.throwIfAborted();
		const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
		const message = missing ? "Document original is missing" : error instanceof Error ? error.message : String(error);
		const writable = openWritablePeDataset(root, connection.datasetId);
		try {
			writable.database
				.prepare(
					"UPDATE documents SET status='failed',warnings_json=?,updated_at=? WHERE dataset_id=? AND doc_id=?",
				)
				.run(JSON.stringify([message]), new Date().toISOString(), connection.datasetId, document.doc_id);
		} finally {
			writable.database.close();
		}
		throw new PeSourceError(missing ? 404 : 409, message);
	}
	const prepared = await prepareWorkbook(root, document, filePath, signal);
	const refreshed = openPeDataset(root, connection.datasetId);
	try {
		document =
			(refreshed.database.prepare("SELECT * FROM documents WHERE doc_id=?").get(document.doc_id) as
				| SqlRow
				| undefined) ?? document;
	} finally {
		refreshed.database.close();
	}
	return { document, datasetId: connection.datasetId, workspaceRoot: root, filePath, ...prepared };
}
