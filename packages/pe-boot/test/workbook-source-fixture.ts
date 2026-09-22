import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { preparePeDocument, registerPeDocuments } from "../src/documents.ts";
import { excelPython } from "../src/excel-processing.ts";
import { createDocumentProject } from "./document-fixture.ts";

export interface WorkbookFixtureCell {
	sheet: string;
	cell: string;
	value: string | number | null;
	comment?: { author: string; text: string };
	format?: string;
	cached?: number;
}

/** Fixture changes create source bytes and update their catalog identity, never a production SQL fallback. */
export function writeWorkbookFixture(root: string, docId: string, cells: WorkbookFixtureCell[]): void {
	mkdirSync(join(root, "raw"), { recursive: true });
	const path = join(root, "raw", `${docId}.xlsx`);
	const script = join(root, "make-workbook.py");
	writeFileSync(
		script,
		`import io, json, sys, zipfile
from xml.etree import ElementTree as ET
from openpyxl import Workbook
from openpyxl.comments import Comment
cells=json.load(sys.stdin)
book=Workbook()
book.remove(book.active)
for item in cells:
    sheet=book[item['sheet']] if item['sheet'] in book.sheetnames else book.create_sheet(item['sheet'])
    sheet[item['cell']]=item['value']
    sheet[item['cell']].number_format=item.get('format', 'General')
    if 'comment' in item:
        sheet[item['cell']].comment=Comment(item['comment']['text'], item['comment']['author'])
buffer=io.BytesIO()
book.save(buffer)
ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
with zipfile.ZipFile(buffer) as source, zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as target:
    for entry in source.infolist():
        content=source.read(entry.filename)
        for index, name in enumerate(book.sheetnames, 1):
            if entry.filename == f'xl/worksheets/sheet{index}.xml':
                tree=ET.fromstring(content)
                for item in cells:
                    if item['sheet'] == name and 'cached' in item:
                        cell=tree.find(f".//{ns}c[@r='{item['cell']}']")
                        value=cell.find(ns+'v')
                        if value is None: value=ET.SubElement(cell, ns+'v')
                        value.text=str(item['cached'])
                content=ET.tostring(tree)
        target.writestr(entry, content)
`,
	);
	const generated = spawnSync(excelPython(), [script, path], { input: JSON.stringify(cells), encoding: "utf8" });
	if (generated.status !== 0) throw new Error(generated.stderr || String(generated.error));
	const checksum = createHash("sha256").update(readFileSync(path)).digest("hex");
	const db = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		db.prepare(
			"UPDATE documents SET stored_path=?,raw_path=?,checksum=?,sha256=?,status='completed' WHERE doc_id=?",
		).run(`raw/${docId}.xlsx`, `raw/${docId}.xlsx`, checksum, checksum, docId);
	} finally {
		db.close();
	}
}

/** Real OOXML values and formula caches; no semantic or cell-table fixtures. */
export async function workbookSourceFixture() {
	const datasetId = "reader-business-test";
	const root = createDocumentProject(datasetId);
	const document = registerPeDocuments(root, datasetId, [
		{
			name: "Model.xlsx",
			bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)),
		},
	]).documents[0];
	const docId = String(document.doc_id);
	await preparePeDocument(root, { docId });
	const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
	try {
		for (const table of ["excel_formula_references", "metric_facts", "valuation_date_candidates", "excel_cells"])
			database.exec(`DROP TABLE ${table}`);
	} finally {
		database.close();
	}
	return { root, datasetId, docId };
}
