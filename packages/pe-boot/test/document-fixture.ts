import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DOCUMENT_SCHEMA } from "../src/tools/database.ts";

export function createDocumentProject(datasetId = "dataset-1"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-document-"));
	for (const directory of ["raw", "meta"]) mkdirSync(join(root, directory));
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		database.exec("CREATE TABLE project_metadata (id INTEGER PRIMARY KEY, dataset_id TEXT NOT NULL)");
		database.prepare("INSERT INTO project_metadata VALUES (1, ?)").run(datasetId);
	} finally {
		database.close();
	}
	return root;
}

export function createTextDocumentProject(filename: string, datasetId = "dataset-1"): string {
	const root = createDocumentProject(datasetId);
	const text = "收入增长20%。\n毛利率改善。\n新增订单。";
	writeFileSync(join(root, "raw", filename), text);
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		database.exec(DOCUMENT_SCHEMA);
		database
			.prepare(
				`INSERT INTO documents (doc_id,dataset_id,logical_doc_id,version_no,title,original_filename,source_relpath,stored_path,file_type,checksum,file_size,created_at,updated_at) VALUES ('doc-1',?,'logical-1',1,?,?,?,?, 'txt',?,?,?,?)`,
			)
			.run(
				datasetId,
				filename,
				filename,
				filename,
				`raw/${filename}`,
				createHash("sha256").update(text).digest("hex"),
				Buffer.byteLength(text),
				new Date().toISOString(),
				new Date().toISOString(),
			);
	} finally {
		database.close();
	}
	return root;
}
