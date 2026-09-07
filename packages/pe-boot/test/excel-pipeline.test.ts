import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase, openPeCollectionDatabase } from "../src/collection-schema.ts";
import { preparePeDocument, registerPeDocuments } from "../src/documents.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { excelPython } from "../src/excel-processing.ts";
import { parseSourceId } from "../src/source.ts";
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { tracePeFormula } from "../src/tools/formula-trace.ts";
import { validatePeModel } from "../src/tools/model-validate.ts";
import { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";

const roots: string[] = [];

function fixture(): { root: string; workbook: Uint8Array } {
	const root = mkdtempSync(join(tmpdir(), "pe-excel-pipeline-"));
	roots.push(root);
	for (const directory of ["raw", "meta", "generated"]) mkdirSync(join(root, directory));
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"), {
		datasetId: "dataset-excel",
		name: "Excel Test",
	});
	const workbookPath = join(root, "fixture.xlsx");
	const script = [
		"import sys",
		"from openpyxl import Workbook",
		"wb=Workbook()",
		"ws=wb.active",
		"ws.title='估值模型'",
		"ws['A1']='指标'",
		"ws['B1']='数值'",
		"ws['A2']='每股收益'",
		"ws['B2']=5",
		"ws['A3']='目标P/E'",
		"ws['B3']=20",
		"ws['A4']='目标价'",
		"ws['B4']='=B2*B3'",
		"ws['B4'].number_format='0.00'",
		"ws['D1']='估值日'",
		"ws['E1']='2026-09-07'",
		"hidden=wb.create_sheet('隐藏表')",
		"hidden.sheet_state='hidden'",
		"wb.save(sys.argv[1])",
	].join(";");
	const created = spawnSync(excelPython(), ["-c", script, workbookPath], { encoding: "utf8" });
	if (created.status !== 0) throw new Error(created.stderr || "Unable to create Excel fixture");
	return { root, workbook: readFileSync(workbookPath) };
}

function macroWorkbook(root: string): Uint8Array {
	const sourcePath = join(root, "fixture.xlsx");
	const targetPath = join(root, "fixture.xlsm");
	const script = [
		"import sys,zipfile",
		"source,target=sys.argv[1:3]",
		"old=b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'",
		"new=b'application/vnd.ms-excel.sheet.macroEnabled.main+xml'",
		"reader=zipfile.ZipFile(source,'r')",
		"writer=zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED)",
		"[(writer.writestr(item,reader.read(item.filename).replace(old,new) if item.filename=='[Content_Types].xml' else reader.read(item.filename))) for item in reader.infolist()]",
		"writer.close()",
		"reader.close()",
	].join(";");
	const converted = spawnSync(excelPython(), ["-c", script, sourcePath, targetPath], { encoding: "utf8" });
	if (converted.status !== 0) throw new Error(converted.stderr || "Unable to create XLSM fixture");
	return readFileSync(targetPath);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Excel preparation and tools", () => {
	it("parses once into human-readable artifacts without chunks", async () => {
		const { root, workbook } = fixture();
		const registered = registerPeDocuments(root, "dataset-excel", [{ name: "估值模型.xlsx", bytes: workbook }]);
		const docId = String(registered.documents[0].doc_id);
		const [prepared, concurrent] = await Promise.all([
			preparePeDocument(root, { docId, datasetId: "dataset-excel" }),
			preparePeDocument(root, { docId, datasetId: "dataset-excel" }),
		]);
		expect(prepared.cachePath).toBe(join(root, "meta", "documents", "估值模型.xlsx", "manifest.json"));
		expect(concurrent.cachePath).toBe(prepared.cachePath);
		expect(prepared.readablePath).toBe(join(root, "meta", "text", "估值模型.xlsx.txt"));
		expect(readFileSync(prepared.readablePath, "utf8")).toContain("估值模型!B4");

		const database = openPeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
		try {
			expect(database.prepare("SELECT COUNT(*) AS count FROM excel_sheets WHERE doc_id=?").get(docId)).toEqual({
				count: 2,
			});
			expect(
				database.prepare("SELECT COUNT(*) AS count FROM excel_formula_references WHERE doc_id=?").get(docId),
			).toEqual({ count: 2 });
			expect(database.prepare("SELECT attempt,status FROM processing_jobs WHERE doc_id=?").get(docId)).toEqual({
				attempt: 1,
				status: "completed",
			});
			const dateEvidence = database
				.prepare("SELECT evidence_id FROM valuation_date_candidates WHERE doc_id=? AND evidence_id IS NOT NULL")
				.all(docId) as Array<{ evidence_id: string }>;
			expect(dateEvidence.length).toBeGreaterThan(0);
			expect(dateEvidence.every((row) => parseSourceId(row.evidence_id) !== undefined)).toBe(true);
			expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name='chunks'").get()).toBeUndefined();
		} finally {
			database.close();
		}

		const inspected = inspectPeWorkbooks(root) as {
			workbook_count: number;
			workbooks: Array<Record<string, unknown>>;
		};
		expect(inspected.workbook_count).toBe(1);
		expect(inspected.workbooks[0]).toMatchObject({ doc_id: docId, sheet_count: 2, formula_count: 1 });

		const range = getPeExcelRange(root, { docId, sheetName: "估值模型", cellRange: "A2:B4" }) as {
			cells: Array<{ cell_ref: string; formula?: string; evidence_id: string }>;
		};
		const output = range.cells.find((cell) => cell.cell_ref === "B4");
		expect(output?.formula).toBe("=B2*B3");
		expect(parseSourceId(output?.evidence_id ?? "")).toEqual({ docId, sheet: "估值模型", range: "B4" });
		const source = await resolvePeEvidenceSource(root, output?.evidence_id ?? "");
		expect(source.payload).toMatchObject({ kind: "excel", doc_id: docId, sheet_name: "估值模型", cell_range: "B4" });
		const trace = tracePeFormula(root, { docId, sheetName: "估值模型", cellRef: "B4" });
		expect(trace.nodes.map((node) => node.cell_ref)).toEqual(expect.arrayContaining(["B2", "B3", "B4"]));
		expect(trace.edges).toHaveLength(2);

		const valuation = locatePeValuationOutputs(root, { docId });
		const targetPrice = valuation.candidates.find((candidate) => candidate.cell_ref === "B4");
		expect(targetPrice).toMatchObject({
			semantic_role: "target_price",
			sheet_name: "估值模型",
			formula: "=B2*B3",
		});
		expect(parseSourceId(targetPrice?.evidence_ids[0] ?? "")).toEqual({ docId, sheet: "估值模型", range: "B4" });

		const valuationDate = resolvePeValuationDate(root, { docId });
		expect(valuationDate).toMatchObject({
			valuation_date: "2026-09-07",
			selected_role: "valuation_date",
		});
		const validation = validatePeModel(root, { docId });
		expect(validation).toMatchObject({
			dataset_id: "dataset-excel",
			document: { doc_id: docId, filename: "估值模型.xlsx" },
			valuation_output_validation: { status: "not_run" },
			valuation_date_validation: { status: "not_run" },
			calculation_validation: { status: "not_run", cached_values_recalculated: false },
		});
	});

	it("rejects duplicate filename, duplicate content, and dataset mismatch", async () => {
		const { root, workbook } = fixture();
		const registered = registerPeDocuments(root, "dataset-excel", [{ name: "模型.xlsx", bytes: workbook }]);
		expect(() => registerPeDocuments(root, "dataset-excel", [{ name: "模型.xlsx", bytes: workbook }])).toThrow(
			/already exists/u,
		);
		expect(() => registerPeDocuments(root, "dataset-excel", [{ name: "副本.xlsx", bytes: workbook }])).toThrow(
			/already exists/u,
		);
		await expect(
			preparePeDocument(root, { docId: String(registered.documents[0].doc_id), datasetId: "other" }),
		).rejects.toThrow("does not match");
	});

	it("validates XLSM content types without executing macros", async () => {
		const { root, workbook } = fixture();
		expect(() => registerPeDocuments(root, "dataset-excel", [{ name: "错误.xlsm", bytes: workbook }])).toThrow(
			/content type/u,
		);
		const registered = registerPeDocuments(root, "dataset-excel", [
			{
				name: "宏模型.xlsm",
				bytes: macroWorkbook(root),
			},
		]);
		const docId = String(registered.documents[0].doc_id);
		const prepared = await preparePeDocument(root, { docId });
		expect(prepared.cachePath).toBe(join(root, "meta", "documents", "宏模型.xlsm", "manifest.json"));
	});

	it("rejects a changed original without publishing partial artifacts", async () => {
		const { root, workbook } = fixture();
		const registered = registerPeDocuments(root, "dataset-excel", [{ name: "被修改.xlsx", bytes: workbook }]);
		const docId = String(registered.documents[0].doc_id);
		writeFileSync(join(root, "raw", "被修改.xlsx"), Buffer.from("changed"));
		await expect(preparePeDocument(root, { docId })).rejects.toThrow("changed");
		expect(existsSync(join(root, "meta", "documents", "被修改.xlsx"))).toBe(false);
		expect(existsSync(join(root, "meta", "text", "被修改.xlsx.txt"))).toBe(false);
		const database = openPeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
		try {
			expect(database.prepare("SELECT status FROM documents WHERE doc_id=?").get(docId)).toEqual({
				status: "failed",
			});
		} finally {
			database.close();
		}
	});
});
