import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { sourceId } from "../src/source.ts";

const roots: string[] = [];
const bytes = Buffer.from("PDF original pinned to its published page index");
const checksum = createHash("sha256").update(bytes).digest("hex");

function project() {
	const root = mkdtempSync(join(tmpdir(), "pe-evidence-upgrade-"));
	roots.push(root);
	for (const directory of ["meta", "raw"]) mkdirSync(join(root, directory));
	writeFileSync(join(root, "raw/Report.pdf"), bytes);
	return { root, path: join(root, "meta/collection.sqlite3") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("citations opened before the project catalog after an upgrade", () => {
	it("migrates a v2 page citation on first access and preserves its page and document IDs", async () => {
		const { root, path } = project();
		const database = new DatabaseSync(path);
		database.exec(readFileSync(new URL("./fixtures/pdf-schema-v2.sql", import.meta.url), "utf8"));
		database.exec(`
			INSERT INTO schema_metadata VALUES ('pipeline_schema_version','2','before');
			INSERT INTO project_metadata VALUES (1,'dataset','Original project','before','before');
			INSERT INTO documents VALUES ('pdf-id','dataset','Report.pdf','report.pdf','raw/Report.pdf','${checksum}',
			 'completed',1,'pdfjs-dist','6.3.289','Report','','','','','[]','{}',
			 'meta/documents/Report','meta/text/Report.md','meta/documents/Report/layout.json','[]','before','before');
			INSERT INTO pdf_pages VALUES ('page-id','pdf-id',1,'Revenue increased 20%','Report.pdf p.1','body','{}','passed','{}',
			 595,842,0,'[]',0,0,0);
			INSERT INTO pdf_pages_fts VALUES ('page-id','pdf-id','Revenue increased 20%');
		`);
		database.close();
		const result = await resolvePeEvidenceSource(root, "page:page-id");
		expect(result.payload).toMatchObject({
			kind: "pdf",
			doc_id: "pdf-id",
			version_no: 1,
			evidence_id: "page:page-id",
			content: "Revenue increased 20%",
		});
		const migrated = new DatabaseSync(path);
		try {
			expect(migrated.prepare("SELECT page_id,doc_id FROM pdf_pages").get()).toEqual({
				page_id: "page-id",
				doc_id: "pdf-id",
			});
			expect(
				migrated.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get()?.value,
			).toBe("4");
			expect(migrated.prepare("SELECT name FROM project_metadata").get()?.name).toBe("Original project");
			expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			migrated.close();
		}
		writeFileSync(join(root, "raw/Report.pdf"), "changed original");
		await expect(resolvePeEvidenceSource(root, "page:page-id")).rejects.toMatchObject({ status: 409 });
	});

	it("migrates an old main PDF citation directly to a recoverable 409 without changing its version", async () => {
		const { root, path } = project();
		const database = new DatabaseSync(path);
		database.exec(readFileSync(new URL("./fixtures/main-document-schema.sql", import.meta.url), "utf8"));
		database
			.prepare(`INSERT INTO documents(doc_id,dataset_id,logical_doc_id,version_no,is_current,title,original_filename,source_relpath,stored_path,file_type,checksum,file_size,created_at,updated_at)
		 VALUES('historic-pdf','dataset','logical-pdf',4,0,'Report','Report.pdf','Report.pdf','raw/Report.pdf','pdf',?,?,'before','before')`)
			.run(checksum, bytes.length);
		database.close();
		const citation = sourceId({ docId: "historic-pdf", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		await expect(resolvePeEvidenceSource(root, citation)).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining("reprocessing"),
		});
		const migrated = new DatabaseSync(path);
		try {
			expect(
				migrated
					.prepare(
						"SELECT doc_id,logical_doc_id,version_no,is_current,stored_path,status,registration_kind FROM documents",
					)
					.get(),
			).toEqual({
				doc_id: "historic-pdf",
				logical_doc_id: "logical-pdf",
				version_no: 4,
				is_current: 0,
				stored_path: "raw/Report.pdf",
				status: "failed",
				registration_kind: "catalog",
			});
			expect(migrated.prepare("SELECT * FROM pdf_pages").all()).toEqual([]);
			migrated.exec(
				"INSERT INTO pdf_pages VALUES ('restored-page','historic-pdf',1,'Restored Node page','','body','{}','passed','{}',595,842,0,'[]',0,0,0); UPDATE documents SET status='completed',page_count=1",
			);
		} finally {
			migrated.close();
		}
		expect((await resolvePeEvidenceSource(root, citation)).payload).toMatchObject({
			doc_id: "historic-pdf",
			version_no: 4,
			evidence_id: citation,
			content: "Restored Node page",
		});
	});

	it("leaves a minimal legacy page collection unchanged for compatibility readers", async () => {
		const { root, path } = project();
		const database = new DatabaseSync(path);
		database.exec(`
			CREATE TABLE documents(doc_id TEXT,dataset_id TEXT,file_type TEXT,original_filename TEXT,raw_path TEXT);
			INSERT INTO documents VALUES ('legacy-pdf','dataset','pdf','Report.pdf','raw/Report.pdf');
			CREATE TABLE pdf_pages(page_id TEXT,doc_id TEXT,page_number INTEGER,page_text TEXT);
			INSERT INTO pdf_pages VALUES ('legacy-page','legacy-pdf',1,'Legacy text');
		`);
		database.close();
		expect((await resolvePeEvidenceSource(root, "page:legacy-page")).payload).toMatchObject({
			doc_id: "legacy-pdf",
			content: "Legacy text",
		});
		const unchanged = new DatabaseSync(path);
		try {
			expect(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_metadata'").get()).toBeUndefined();
			expect(unchanged.prepare("PRAGMA table_info(documents)").all()).toHaveLength(5);
		} finally {
			unchanged.close();
		}
	});
});
