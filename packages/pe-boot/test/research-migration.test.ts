import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase, openPeCollectionDatabase } from "../src/collection-schema.ts";
import { resolvePeEvidenceRecord, resolvePeEvidenceReference } from "../src/evidence.ts";
import { parseSourceId, sourceId } from "../src/source.ts";

const roots: string[] = [];
const oldDocId = "doc_0123456789abcdef01234567";
const oldSourceId = `source:${Buffer.from(JSON.stringify({ v: 1, doc_id: oldDocId, sheet: "DCF 中文", range: "B2" })).toString("base64url")}`;

function project() {
	const root = mkdtempSync(join(tmpdir(), "pe-research-upgrade-"));
	roots.push(root);
	mkdirSync(join(root, "meta"));
	const path = join(root, "meta/collection.sqlite3");
	const database = new DatabaseSync(path);
	database.exec(readFileSync(new URL("./fixtures/research-schema-v3.sql", import.meta.url), "utf8"));
	database.exec(`
		INSERT INTO schema_metadata VALUES('pipeline_schema_version','3','before');
		INSERT INTO project_metadata VALUES(1,'dataset','Research','before','before');
		INSERT INTO documents VALUES('${oldDocId}','dataset','Model.xlsx','model.xlsx','raw/Model.xlsx','hash',
			'completed_with_warnings',0,'openpyxl','3.1.5','Model','','','','','[]','{}',
			'meta/documents/Model.xlsx','meta/text/Model.xlsx.txt','','["missing formula cache"]','before','before',
			'xlsx','Model.xlsx',100,'meta/text/Model.xlsx.txt');
		INSERT INTO excel_workbooks VALUES('workbook','dataset','${oldDocId}','valuation',1,1,1,2,0.5,'{}');
		INSERT INTO excel_sheets(sheet_id,dataset_id,doc_id,sheet_index,sheet_name,sheet_role,used_range,row_count,col_count,non_empty_cell_count,formula_count,formula_density)
			VALUES('sheet','dataset','${oldDocId}',0,'DCF 中文','valuation','A1:B2',2,2,2,1,0.5);
		INSERT INTO excel_regions(region_id,dataset_id,doc_id,sheet_name,region_index,region_type,cell_range,row_count,col_count,non_empty_cell_count,formula_count,formula_density)
			VALUES('region','dataset','${oldDocId}','DCF 中文',0,'table','A1:B2',2,2,2,1,0.5);
		INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,formula,cached_value)
			VALUES('old-cell','dataset','${oldDocId}','DCF 中文','B2',2,2,'formula','=B1*2','100');
		INSERT INTO excel_defined_names(defined_name_id,dataset_id,doc_id,name,attr_text)
			VALUES('name','dataset','${oldDocId}','Output','DCF 中文!B2');
		INSERT INTO excel_formula_references(reference_id,dataset_id,doc_id,source_cell_id,source_sheet,source_cell_ref,reference_index,raw_reference,reference_kind,parse_status)
			VALUES('reference','dataset','${oldDocId}','old-cell','DCF 中文','B2',0,'B1','cell','parsed');
		INSERT INTO valuation_date_candidates(candidate_id,dataset_id,doc_id,normalized_date,raw_text,role,source_type,evidence_id,parse_method,date_precision,priority_score,confidence)
			VALUES('date','dataset','${oldDocId}','2026-09-07','2026-09-07','valuation_date','cell','${oldSourceId}','date','day',1,1);
		INSERT INTO metric_facts(fact_id,dataset_id,doc_id,metric_name,sheet_name,cell_ref,value_numeric)
			VALUES('old-fact','dataset','${oldDocId}','valuation','DCF 中文','B2',100);
		INSERT INTO document_cache VALUES('${oldDocId}','old-revision','before','meta/documents/Model.xlsx/manifest.json','meta/text/Model.xlsx.txt');
		INSERT INTO processing_jobs VALUES('job','${oldDocId}','old-revision','completed','owner',100,2,'','before','before');
		INSERT INTO ingest_jobs VALUES('upload','dataset','completed','done','[]','{}','[]','before','before','before','before',123,'before');
		CREATE TABLE research_saved_notes(note_id TEXT PRIMARY KEY,evidence_ids_json TEXT NOT NULL);
		INSERT INTO research_saved_notes VALUES('note','["${oldSourceId}","cell:old-cell","fact:old-fact"]');
	`);
	return { root, path, database };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("research v3 upgrade and durable citations", () => {
	it("preserves every uploaded row, cache, lease and stored reference while adding v4 identity", () => {
		const { root, path, database } = project();
		const tables = [
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
			"ingest_jobs",
			"research_saved_notes",
		];
		const snapshots = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
		const original = database.prepare("SELECT * FROM documents").get();
		database.close();
		initializePeCollectionDatabase(path);
		initializePeCollectionDatabase(path);
		const migrated = openPeCollectionDatabase(path);
		try {
			for (const [index, table] of tables.entries())
				expect(migrated.prepare(`SELECT * FROM ${table}`).all()).toEqual(snapshots[index]);
			expect(migrated.prepare("SELECT * FROM documents").get()).toMatchObject({
				...original,
				logical_doc_id: oldDocId,
				version_no: 1,
				is_current: 1,
				lifecycle_state: "active",
				stored_path: "raw/Model.xlsx",
				checksum: "hash",
				registration_kind: "catalog",
			});
			expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
			for (const id of [oldSourceId, "cell:old-cell", "fact:old-fact"]) {
				expect(resolvePeEvidenceRecord(migrated, "dataset", id)).toMatchObject({
					evidenceId: id,
					citation: "Model.xlsx DCF 中文!B2",
				});
				expect(resolvePeEvidenceRecord(migrated, "another-dataset", id)).toBeUndefined();
			}
		} finally {
			migrated.close();
		}
		for (const id of [oldSourceId, "cell:old-cell", "fact:old-fact"])
			expect(resolvePeEvidenceReference(root, id)).toEqual({
				docId: oldDocId,
				location: { kind: "excel", sheet: "DCF 中文", range: "B2" },
			});
		const rebuilt = openPeCollectionDatabase(path);
		rebuilt.exec("DELETE FROM excel_formula_references; DELETE FROM excel_cells; DELETE FROM metric_facts");
		rebuilt.close();
		for (const id of ["cell:old-cell", "fact:old-fact"])
			expect(resolvePeEvidenceReference(root, id).docId).toBe(oldDocId);
	});

	it("rolls back a corrupt research database without changing its schema or original data", () => {
		const { path, database } = project();
		database.exec("PRAGMA foreign_keys=OFF; UPDATE excel_formula_references SET source_cell_id='missing'");
		database.close();
		expect(() => initializePeCollectionDatabase(path)).toThrow("foreign key validation");
		const unchanged = new DatabaseSync(path);
		try {
			expect(
				unchanged.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get()?.value,
			).toBe("3");
			expect(
				unchanged
					.prepare("PRAGMA table_info(documents)")
					.all()
					.map((column) => column.name),
			).not.toContain("version_no");
			expect(unchanged.prepare("SELECT doc_id,raw_path FROM documents").get()).toEqual({
				doc_id: oldDocId,
				raw_path: "raw/Model.xlsx",
			});
		} finally {
			unchanged.close();
		}
	});

	it("accepts existing object citations and emits the shared array format with strict bounds", () => {
		const reference = { docId: oldDocId, location: { kind: "excel" as const, sheet: "DCF 中文", range: "B2" } };
		expect(parseSourceId(oldSourceId)).toEqual(reference);
		const modern = sourceId(reference);
		expect(sourceId({ docId: oldDocId, sheet: "DCF 中文", range: "B2" })).toBe(modern);
		expect(JSON.parse(Buffer.from(modern.slice(7), "base64url").toString("utf8"))).toEqual([
			oldDocId,
			"excel",
			"DCF 中文",
			"B2",
		]);
		expect(parseSourceId(modern)).toEqual(reference);
		for (const fields of [
			{ v: 2, doc_id: oldDocId, sheet: "DCF", range: "A1" },
			{ v: 1, doc_id: oldDocId, sheet: "DCF", range: "XFE1" },
			{ v: 1, doc_id: "../outside", sheet: "DCF", range: "A1" },
		])
			expect(parseSourceId(`source:${Buffer.from(JSON.stringify(fields)).toString("base64url")}`)).toBeUndefined();
	});
});
