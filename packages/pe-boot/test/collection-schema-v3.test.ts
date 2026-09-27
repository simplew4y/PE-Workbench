import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase, openPeCollectionDatabase } from "../src/collection-schema.ts";

const roots: string[] = [];

function v2Fixture(): { root: string; databasePath: string } {
	const root = mkdtempSync(join(tmpdir(), "pe-schema-v3-"));
	roots.push(root);
	mkdirSync(join(root, "meta"));
	const databasePath = join(root, "meta", "collection.sqlite3");
	const database = new DatabaseSync(databasePath);
	database.exec(`
		CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
		CREATE TABLE project_metadata(id INTEGER PRIMARY KEY,dataset_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
		CREATE TABLE documents(
			doc_id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,original_filename TEXT NOT NULL,filename_key TEXT NOT NULL,
			raw_path TEXT NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL,page_count INTEGER NOT NULL,
			parser_name TEXT NOT NULL,parser_version TEXT NOT NULL,title TEXT NOT NULL,brokerage TEXT NOT NULL,
			document_date TEXT NOT NULL,rating TEXT NOT NULL,target_price TEXT NOT NULL,exhibits_json TEXT NOT NULL,
			pdf_metadata_json TEXT NOT NULL,artifact_directory TEXT NOT NULL,document_markdown_path TEXT NOT NULL,
			layout_json_path TEXT NOT NULL,warnings_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
			UNIQUE(dataset_id,sha256),UNIQUE(dataset_id,filename_key)
		);
		CREATE TABLE pdf_pages(
			page_id TEXT PRIMARY KEY,doc_id TEXT NOT NULL,page_number INTEGER NOT NULL,page_text TEXT NOT NULL,
			page_header TEXT NOT NULL,role TEXT NOT NULL,role_signals_json TEXT NOT NULL,text_quality TEXT NOT NULL,
			quality_signals_json TEXT NOT NULL,width REAL NOT NULL,height REAL NOT NULL,rotation INTEGER NOT NULL,
			image_paths_json TEXT NOT NULL,embedded_image_count INTEGER NOT NULL,large_embedded_image_count INTEGER NOT NULL,
			drawing_operator_count INTEGER NOT NULL,FOREIGN KEY(doc_id) REFERENCES documents(doc_id)
		);
		CREATE TABLE pdf_page_blocks(
			block_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,block_index INTEGER NOT NULL,block_type TEXT NOT NULL,
			block_text TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,width REAL NOT NULL,height REAL NOT NULL,
			reading_order INTEGER NOT NULL,column_no INTEGER NOT NULL,font_names_json TEXT NOT NULL,directions_json TEXT NOT NULL,
			FOREIGN KEY(page_id) REFERENCES pdf_pages(page_id)
		);
		CREATE TABLE ingest_jobs(
			job_id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,
			input_files_json TEXT NOT NULL,result_json TEXT NOT NULL,warnings_json TEXT NOT NULL,created_at TEXT NOT NULL,
			started_at TEXT,finished_at TEXT,updated_at TEXT NOT NULL
		);
		CREATE VIRTUAL TABLE pdf_pages_fts USING fts5(page_id UNINDEXED,doc_id UNINDEXED,page_text,tokenize='trigram');
		INSERT INTO schema_metadata VALUES('pipeline_schema_version','2','2026-09-07');
		INSERT INTO project_metadata VALUES(1,'dataset','Migration','2026-09-07','2026-09-07');
		INSERT INTO documents VALUES(
			'pdf-id','dataset','Report.pdf','report.pdf','raw/Report.pdf','pdf-hash','completed',1,
			'pdfjs-dist','6.3.289','Report','','','','','[]','{}','meta/documents/Report',
			'meta/text/Report.md','meta/documents/Report/layout.json','[]','2026-09-07','2026-09-07'
		);
		INSERT INTO pdf_pages VALUES(
			'page-id','pdf-id',1,'Revenue increased 20%','Report.pdf p.1','body','{}','passed','{}',
			595,842,0,'[]',0,0,0
		);
		INSERT INTO pdf_pages_fts VALUES('page-id','pdf-id','Report.pdf p.1 Revenue increased 20%');
	`);
	database.close();
	return { root, databasePath };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy research PDF collection migration", () => {
	it("migrates v2 without changing PDF rows or page IDs", () => {
		const { databasePath } = v2Fixture();
		initializePeCollectionDatabase(databasePath);
		const database = openPeCollectionDatabase(databasePath);
		try {
			const tables = new Set(
				(
					database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
				).map((row) => row.name),
			);
			for (const table of [
				"excel_workbooks",
				"excel_sheets",
				"excel_regions",
				"excel_cells",
				"excel_defined_names",
				"excel_formula_references",
				"valuation_date_candidates",
				"metric_facts",
				"document_cache",
				"processing_jobs",
			])
				expect(tables.has(table)).toBe(true);
			expect(database.prepare("SELECT page_id,page_text FROM pdf_pages").get()).toEqual({
				page_id: "page-id",
				page_text: "Revenue increased 20%",
			});
			expect(database.prepare("SELECT file_type,source_relpath FROM documents").get()).toEqual({
				file_type: "pdf",
				source_relpath: "Report.pdf",
			});
			expect(
				database.prepare("SELECT page_id FROM pdf_pages_fts WHERE pdf_pages_fts MATCH 'Revenue'").get(),
			).toEqual({
				page_id: "page-id",
			});
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(
				database.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get(),
			).toEqual({
				value: "4",
			});
		} finally {
			database.close();
		}
	});

	it("rejects populated legacy chunk data", () => {
		const { databasePath } = v2Fixture();
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TABLE chunks(chunk_id TEXT); INSERT INTO chunks VALUES('legacy')");
		database.close();
		expect(() => initializePeCollectionDatabase(databasePath)).toThrow("Legacy Python Pipeline data");
	});

	it("keeps one filename and one hash for pipeline PDFs", () => {
		const { databasePath } = v2Fixture();
		initializePeCollectionDatabase(databasePath);
		const database = openPeCollectionDatabase(databasePath);
		try {
			const base = database.prepare("SELECT * FROM documents WHERE doc_id='pdf-id'").get() as Record<
				string,
				SQLInputValue
			>;
			const columns = Object.keys(base);
			const insert = database.prepare(
				`INSERT INTO documents (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			);
			expect(() =>
				insert.run(
					...columns.map((column) =>
						column === "doc_id" ? "duplicate-name" : column === "sha256" ? "other" : base[column],
					),
				),
			).toThrow();
			expect(() =>
				insert.run(
					...columns.map((column) =>
						column === "doc_id" ? "duplicate-hash" : column === "filename_key" ? "other.pdf" : base[column],
					),
				),
			).toThrow();
		} finally {
			database.close();
		}
	});
});
