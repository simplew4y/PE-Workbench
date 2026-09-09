import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	initializePeCollectionDatabase,
	openPeCollectionDatabase,
	rollbackPeTransaction,
} from "./collection-schema.ts";
import { portablePeFilename } from "./document-filenames.ts";
import { type PreparedWorkbook, prepareWorkbook, validatePeExcelUpload, verifyPeOriginal } from "./excel-processing.ts";
import { DOCUMENT_EXTENSIONS } from "./source.ts";
import {
	documentFilePath,
	openPeDataset,
	openWritablePeDataset,
	type SqlRow,
	sourceEvidenceId,
	sourceMarkdownCitation,
	textValue,
} from "./tools/database.ts";

export { resolvePeEvidenceSource, resolvePeEvidenceSources, sourceLocationRow } from "./evidence.ts";
export { DOCUMENT_EXTENSIONS } from "./source.ts";

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
		if (!entry.isDirectory() || entry.isSymbolicLink())
			throw new PeSourceError(400, `${name}/ must be a real project directory`);
	}
	const database = join(root, "meta", "collection.sqlite3");
	if (existsSync(database) && lstatSync(database).isSymbolicLink())
		throw new PeSourceError(400, "Project database must not be a symlink");
	return root;
}

/** Register immutable Excel originals. The upload worker prepares their derived data separately. */
export function registerPeDocuments(
	cwd: string,
	datasetId: string,
	files: Array<{ name: string; bytes: Uint8Array }>,
): { documents: SqlRow[]; fileCount: number } {
	const root = projectRoot(cwd);
	const inputs = files.map(({ name, bytes }) => {
		name = portablePeFilename(name);
		const extension = extname(name).toLowerCase();
		if (basename(name) !== name || /[\\/\x00-\x1f<>:"|?*]/u.test(name) || !DOCUMENT_EXTENSIONS.has(extension))
			throw new PeSourceError(400, `Unsupported document filename: ${name}`);
		try {
			if (extension === ".xlsx" || extension === ".xlsm") validatePeExcelUpload(bytes, extension.slice(1));
		} catch (error) {
			throw new PeSourceError(400, error instanceof Error ? error.message : String(error));
		}
		return { name, bytes, extension, checksum: createHash("sha256").update(bytes).digest("hex") };
	});
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	const metadata = openPeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	try {
		const now = new Date().toISOString();
		metadata
			.prepare("INSERT OR IGNORE INTO project_metadata(id,dataset_id,name,created_at,updated_at) VALUES (1,?,?,?,?)")
			.run(datasetId, basename(root), now, now);
	} finally {
		metadata.close();
	}
	const connection = openWritablePeDataset(root, datasetId);
	const database = connection.database;
	const created: string[] = [];
	try {
		database.exec("BEGIN IMMEDIATE");
		const documents: SqlRow[] = [];
		for (const { name, bytes, extension, checksum } of inputs) {
			const identityName = name.normalize("NFKC");
			const generatedLogicalId = createHash("sha256")
				.update(`${datasetId}\0${identityName}`)
				.digest("hex")
				.slice(0, 40);
			const current = database
				.prepare(`SELECT * FROM documents WHERE dataset_id=?
				AND (logical_doc_id=? OR source_relpath=? OR source_relpath=?
					OR (logical_doc_id GLOB 'doc_*' AND filename_key=? AND file_type=?))
				AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1`)
				.get(
					datasetId,
					generatedLogicalId,
					name,
					`raw/${name}`,
					identityName.toLocaleLowerCase("und"),
					extension.slice(1),
				) as SqlRow | undefined;
			const logicalId = textValue(current ?? {}, "logical_doc_id") ?? generatedLogicalId;
			if (current && textValue(current, "checksum") === checksum) {
				if (
					createHash("sha256")
						.update(readFileSync(documentFilePath(root, current)))
						.digest("hex") !== checksum
				)
					throw new PeSourceError(
						409,
						"Stored original was modified; restore it before uploading this version again",
					);
				documents.push(current);
				continue;
			}
			const sequence = database
				.prepare(
					"SELECT COALESCE(MAX(version_no),0)+1 AS version FROM documents WHERE dataset_id=? AND logical_doc_id=?",
				)
				.get(datasetId, logicalId) as SqlRow;
			const version = Number(sequence.version);
			const docId = createHash("sha256").update(`${logicalId}\0${version}\0${checksum}`).digest("hex").slice(0, 40);
			const storedName = existsSync(join(root, "raw", name))
				? `${name.slice(0, -extension.length)}--${docId}${extension}`
				: name;
			const target = join(root, "raw", storedName);
			const descriptor = openSync(target, "wx", 0o600);
			created.push(target);
			try {
				writeFileSync(descriptor, bytes);
			} finally {
				closeSync(descriptor);
			}
			const now = new Date().toISOString();
			database
				.prepare("UPDATE documents SET is_current=0 WHERE dataset_id=? AND logical_doc_id=?")
				.run(datasetId, logicalId);
			database
				.prepare(`INSERT INTO documents
				(doc_id,dataset_id,logical_doc_id,version_no,supersedes_doc_id,is_current,title,original_filename,filename_key,
				source_relpath,stored_path,raw_path,file_type,checksum,sha256,file_size,status,page_count,created_at,updated_at,registration_kind)
				VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,'catalog')`)
				.run(
					docId,
					datasetId,
					logicalId,
					version,
					current?.doc_id ?? null,
					name,
					name,
					identityName.toLocaleLowerCase("und"),
					name,
					`raw/${storedName}`,
					`raw/${storedName}`,
					extension.slice(1),
					checksum,
					checksum,
					bytes.byteLength,
					now,
					now,
				);
			documents.push(database.prepare("SELECT * FROM documents WHERE doc_id=?").get(docId) as SqlRow);
		}
		const count = database
			.prepare(
				"SELECT COUNT(*) AS count FROM documents WHERE dataset_id=? AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL",
			)
			.get(datasetId) as SqlRow;
		database.exec("COMMIT");
		return { documents, fileCount: Number(count.count) };
	} catch (error) {
		rollbackPeTransaction(database);
		for (const path of created) rmSync(path, { force: true });
		throw error;
	} finally {
		database.close();
	}
}

/** Shared readiness barrier for upload workers, Excel tools, and historical source previews. */
export async function preparePeDocument(
	cwd: string,
	options: PeDocumentOptions,
	signal?: AbortSignal,
): Promise<PreparedPeDocument> {
	signal?.throwIfAborted();
	if (!options.docId?.trim() && !options.path?.trim())
		throw new PeSourceError(400, "Specify a document filename or doc_id");
	const root = projectRoot(cwd);
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	const connection = openPeDataset(root, options.datasetId);
	let document: SqlRow | undefined;
	try {
		if (options.docId)
			document = connection.database
				.prepare("SELECT * FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
				.get(connection.datasetId, options.docId) as SqlRow | undefined;
		else {
			const requested = options.path?.trim() ?? "";
			const local = isAbsolute(requested) ? relative(root, resolve(requested)) : requested;
			if (local.startsWith("..") || isAbsolute(local))
				throw new PeSourceError(400, "Document path is outside the project");
			const name = local.replaceAll("\\", "/").replace(/^raw\//u, "");
			document = connection.database
				.prepare(`SELECT * FROM documents WHERE dataset_id=? AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL
				AND (source_relpath=? OR source_relpath=? OR stored_path=? OR stored_path=?) ORDER BY version_no DESC LIMIT 1`)
				.get(connection.datasetId, name, `raw/${name}`, `raw/${name}`, resolve(root, "raw", name)) as
				| SqlRow
				| undefined;
		}
	} finally {
		connection.database.close();
	}
	if (!document) throw new PeSourceError(404, "Document not found in this project's upload catalog");
	if (!DOCUMENT_EXTENSIONS.has(`.${document.file_type}`)) throw new PeSourceError(400, "Unsupported document type");
	let filePath: string;
	try {
		filePath = documentFilePath(root, document);
		await verifyPeOriginal(filePath, textValue(document, "checksum") ?? textValue(document, "sha256") ?? "", signal);
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
	let prepared: PreparedWorkbook;
	try {
		prepared =
			document.file_type === "pdf"
				? prepareIndexedPdf(root, document)
				: await prepareWorkbook(root, document, filePath, signal);
	} catch (error) {
		signal?.throwIfAborted();
		try {
			await verifyPeOriginal(filePath, String(document.sha256), signal);
		} catch (originalError) {
			signal?.throwIfAborted();
			const missing = originalError instanceof Error && "code" in originalError && originalError.code === "ENOENT";
			throw new PeSourceError(
				missing ? 404 : 409,
				missing
					? "Document original is missing"
					: originalError instanceof Error
						? originalError.message
						: String(originalError),
			);
		}
		throw error;
	}
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

/** PDF parsing remains owned by the upload pipeline; this view consumes its published pages. */
function prepareIndexedPdf(root: string, document: SqlRow): PreparedWorkbook {
	const connection = openPeDataset(root, String(document.dataset_id));
	try {
		const pages = connection.database
			.prepare("SELECT page_number,page_text FROM pdf_pages WHERE doc_id=? ORDER BY page_number")
			.all(document.doc_id) as SqlRow[];
		if (!pages.length || !["completed", "completed_with_warnings"].includes(String(document.status)))
			throw new PeSourceError(
				409,
				"PDF is not prepared; wait for the Node upload pipeline or retry its processing job",
			);
		const warnings = JSON.parse(String(document.warnings_json || "[]")) as string[];
		const blocks = pages.map((page) => ({
			page_start: Number(page.page_number),
			page_end: Number(page.page_number),
			text: String(page.page_text),
		}));
		const revision = createHash("sha256").update(JSON.stringify({ blocks, warnings })).digest("hex");
		const directory = join(root, "meta", "read-cache", String(document.doc_id), revision);
		mkdirSync(directory, { recursive: true });
		if (realpathSync(directory) !== directory) throw new PeSourceError(400, "Document cache must not be a symlink");
		const cachePath = join(directory, "manifest.json");
		const readablePath = join(directory, "readable.txt");
		const lines = [
			`# ${document.original_filename} (version ${document.version_no})`,
			...warnings.map((warning) => `Warning: ${warning}`),
		];
		for (const block of blocks) {
			const row = { ...document, ...block };
			const citation = sourceMarkdownCitation(row, sourceEvidenceId(row));
			lines.push(`\n ${citation}`);
			for (const line of block.text.split("\n")) lines.push(`${line} ${citation}`);
		}
		for (const [path, content] of [
			[cachePath, JSON.stringify({ doc_id: document.doc_id, revision, blocks, warnings })],
			[readablePath, `${lines.join("\n")}\n`],
		]) {
			if (existsSync(path) && realpathSync(path) !== path)
				throw new PeSourceError(400, "Document cache must not be a symlink");
			writeFileSync(path, content, { mode: 0o600 });
		}
		return { cachePath, readablePath, warnings };
	} finally {
		connection.database.close();
	}
}
