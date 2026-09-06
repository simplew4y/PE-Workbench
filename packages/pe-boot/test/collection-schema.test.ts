import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase, openPeCollectionDatabase } from "../src/collection-schema.ts";
import { readPePdfPages } from "../src/tools/pdf-read.ts";
import { searchPePdfPages } from "../src/tools/pdf-search.ts";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pe-schema-v3-"));
	roots.push(root);
	mkdirSync(join(root, "meta"));
	const path = join(root, "meta", "collection.sqlite3");
	const db = new DatabaseSync(path);
	db.exec(readFileSync(new URL("./fixtures/pdf-schema-v2.sql", import.meta.url), "utf8"));
	db.exec(`
		INSERT INTO schema_metadata VALUES ('pipeline_schema_version', '2', '2026-09-07');
		INSERT INTO project_metadata VALUES (1, 'dataset', 'Migration', '2026-09-07', '2026-09-07');
		INSERT INTO documents VALUES ('pdf-id','dataset','Report.pdf','report.pdf','raw/Report.pdf','pdf-hash',
		 'completed',1,'pdfjs-dist','6.3.289','Report','','','','','[]','{}',
		 'meta/documents/Report','meta/text/Report.md','meta/documents/Report/layout.json','[]','2026-09-07','2026-09-07');
		INSERT INTO pdf_pages VALUES ('page-id','pdf-id',1,'Revenue increased 20%','Report.pdf p.1','body','{}','passed','{}',
		 595,842,0,'["meta/documents/Report/pages/page-0001@110.png"]',0,0,0);
		INSERT INTO pdf_page_blocks VALUES ('block-id','page-id',0,'body','Revenue increased 20%',10,10,200,20,0,0,'[]','[]');
		INSERT INTO pdf_pages_fts VALUES ('page-id','pdf-id','Report.pdf p.1 Revenue increased 20%');
	`);
	db.close();
	return { root, path };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared PDF and Excel collection migration", () => {
	it("preserves existing PDF search/read results, IDs, FTS, blocks and foreign keys", () => {
		const { root, path } = fixture();
		const beforeSearch = searchPePdfPages(root, { queries: ["Revenue"] });
		const beforeRead = readPePdfPages(root, { documentName: "Report.pdf", pageStart: 1 });
		initializePeCollectionDatabase(path);
		initializePeCollectionDatabase(path);
		expect(searchPePdfPages(root, { queries: ["Revenue"] })).toEqual(beforeSearch);
		expect(readPePdfPages(root, { documentName: "Report.pdf", pageStart: 1 })).toEqual(beforeRead);
		const db = openPeCollectionDatabase(path);
		try {
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(db.prepare("SELECT * FROM pdf_page_blocks").all()).toHaveLength(1);
			expect(db.prepare("SELECT * FROM documents WHERE doc_id='pdf-id'").get()).toMatchObject({
				logical_doc_id: "pdf-id",
				version_no: 1,
				file_type: "pdf",
				source_relpath: "Report.pdf",
				stored_path: "raw/Report.pdf",
				checksum: "pdf-hash",
			});
			expect(db.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get()?.value).toBe(
				"3",
			);
		} finally {
			db.close();
		}
	});

	it("keeps PDF duplicate rules while allowing distinct Excel names and A to B to A versions", () => {
		const { path } = fixture();
		initializePeCollectionDatabase(path);
		const db = openPeCollectionDatabase(path);
		try {
			const insert = db.prepare(`INSERT INTO documents
			 (doc_id,dataset_id,original_filename,filename_key,raw_path,sha256,file_type,logical_doc_id,version_no,is_current,created_at,updated_at)
			 VALUES (?,'dataset',?,?,?,? ,?,?,?,?, 'now','now')`);
			insert.run("v1", "Model.xlsx", "Model.xlsx", "raw/Model.xlsx", "A", "xlsx", "logical", 1, 0);
			insert.run("v2", "Model.xlsx", "Model.xlsx", "raw/Model-v2.xlsx", "B", "xlsx", "logical", 2, 0);
			insert.run("v3", "Model.xlsx", "Model.xlsx", "raw/Model-v3.xlsx", "A", "xlsx", "logical", 3, 1);
			insert.run("different", "Other.xlsx", "Other.xlsx", "raw/Other.xlsx", "A", "xlsx", "other-logical", 1, 1);
			expect(() =>
				insert.run("duplicate-current", "Model.xlsx", "Model.xlsx", "raw/new.xlsx", "C", "xlsx", "logical", 4, 1),
			).toThrow();
			expect(() =>
				insert.run("duplicate-pdf", "Other.pdf", "other.pdf", "raw/Other.pdf", "pdf-hash", "pdf", "p2", 1, 1),
			).toThrow();
			expect(() =>
				insert.run("duplicate-name", "REPORT.pdf", "report.pdf", "raw/REPORT.pdf", "other-hash", "pdf", "p3", 1, 1),
			).toThrow();
			db.prepare(`INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type)
			 VALUES ('cell','dataset','v3','DCF','B2',2,2,'number')`).run();
		} finally {
			db.close();
		}
		// A normal reopen must not mistake newly created Excel caches for legacy data.
		expect(() => initializePeCollectionDatabase(path)).not.toThrow();
	});

	it("rolls back migration on foreign key corruption without replacing the original schema", () => {
		const { path } = fixture();
		const db = new DatabaseSync(path);
		db.exec("PRAGMA foreign_keys=OFF; UPDATE pdf_pages SET doc_id='missing'");
		db.close();
		expect(() => initializePeCollectionDatabase(path)).toThrow("foreign key validation");
		const check = new DatabaseSync(path);
		try {
			expect(
				check.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get()?.value,
			).toBe("2");
			expect(
				check
					.prepare("PRAGMA table_info(documents)")
					.all()
					.some((row) => row.name === "logical_doc_id"),
			).toBe(false);
		} finally {
			check.close();
		}
	});
});
