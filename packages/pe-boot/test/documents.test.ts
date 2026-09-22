import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { preparePeDocument, registerPeDocuments, resolvePeEvidenceSource } from "../src/documents.ts";
import { parseSourceId, sourceId } from "../src/source.ts";
import { getPeExcelRange } from "../src/tools/excel-range.ts";
import { tracePeFormula } from "../src/tools/formula-trace.ts";
import { resolvePeValuationDate } from "../src/tools/valuation-date.ts";
import { locatePeValuationOutputs } from "../src/tools/valuation-output.ts";
import { inspectPeWorkbooks } from "../src/tools/workbook-inspect.ts";
import { createDocumentProject } from "./document-fixture.ts";

const roots: string[] = [];
const assets = mkdtempSync(join(tmpdir(), "pe-document-assets-"));
beforeAll(async () => {
	const python =
		process.env.PE_DOCUMENT_PYTHON || fileURLToPath(new URL("../python/.venv/bin/python", import.meta.url));
	execFileSync(python, [fileURLToPath(new URL("./fixtures/create_documents.py", import.meta.url)), assets]);
	const pdf = new PDFDocument({ autoFirstPage: false });
	const chunks: Buffer[] = [];
	const finished = new Promise<void>((resolve, reject) => {
		pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
		pdf.on("error", reject);
		pdf.on("end", () => {
			writeFileSync(join(assets, "report.pdf"), Buffer.concat(chunks));
			resolve();
		});
	});
	for (const text of ["Revenue: 100 million", "Gross margin: 20%", ""]) {
		pdf.addPage();
		if (text) pdf.text(text);
	}
	pdf.end();
	await finished;
});
afterAll(() => rmSync(assets, { recursive: true, force: true }));
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = createDocumentProject();
	roots.push(root);
	return root;
}

function upload(root: string, filename: string, text?: string): string {
	const bytes = text === undefined ? readFileSync(join(assets, filename)) : Buffer.from(text);
	return String(registerPeDocuments(root, "dataset-1", [{ name: filename, bytes }]).documents[0].doc_id);
}

describe("on-demand documents and file citations", () => {
	it.each(["model.xlsx", "report.pdf"])("preserves Unicode punctuation when registering %s", (asset) => {
		const root = project();
		const extension = asset.split(".").at(-1);
		const name = `研究报告（LULU.US）：Product issue or brand.${extension}`;
		const bytes = readFileSync(join(assets, asset));
		const first = registerPeDocuments(root, "dataset-1", [{ name, bytes }]).documents[0];
		expect(first.original_filename).toBe(name);
		expect(first.raw_path).toBe(`raw/${name}`);
		expect(readFileSync(join(root, "raw", name))).toEqual(bytes);
		expect(registerPeDocuments(root, "dataset-1", [{ name, bytes }]).documents[0].doc_id).toBe(first.doc_id);
	});

	it("keeps version identity when a previously normalized filename uses full-width parentheses", () => {
		const root = project();
		const bytes = readFileSync(join(assets, "model.xlsx"));
		const first = registerPeDocuments(root, "dataset-1", [{ name: "Model(1).xlsx", bytes }]).documents[0];
		const name = "Model（1）.xlsx";
		expect(registerPeDocuments(root, "dataset-1", [{ name, bytes }]).documents[0].doc_id).toBe(first.doc_id);
		const changed = Buffer.concat([bytes, Buffer.from("next version")]);
		const next = registerPeDocuments(root, "dataset-1", [{ name, bytes: changed }]).documents[0];
		expect(next).toMatchObject({ logical_doc_id: first.logical_doc_id, version_no: 2, original_filename: name });
		expect(readFileSync(join(root, "raw", "Model(1).xlsx"))).toEqual(bytes);
	});

	it("extends an existing research workbook with immutable versions and opens its old object/cell/fact links", async () => {
		const root = mkdtempSync(join(tmpdir(), "pe-research-document-"));
		roots.push(root);
		for (const directory of ["raw", "meta"]) mkdirSync(join(root, directory));
		const bytes = readFileSync(join(assets, "model.xlsx"));
		const checksum = createHash("sha256").update(bytes).digest("hex");
		const oldId = "doc_0123456789abcdef01234567";
		writeFileSync(join(root, "raw/model.xlsx"), bytes);
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		database.exec(readFileSync(new URL("./fixtures/research-schema-v3.sql", import.meta.url), "utf8"));
		database.exec(`INSERT INTO schema_metadata VALUES('pipeline_schema_version','3','before');
			INSERT INTO project_metadata VALUES(1,'dataset-1','Research','before','before');
			INSERT INTO documents VALUES('${oldId}','dataset-1','model.xlsx','model.xlsx','raw/model.xlsx','${checksum}',
				'completed',0,'openpyxl','3.1.5','Model','','','','','[]','{}','meta/documents/model.xlsx',
				'meta/text/model.xlsx.txt','','[]','before','before','xlsx','model.xlsx',${bytes.length},'meta/text/model.xlsx.txt');
			INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type)
				VALUES('research-cell','dataset-1','${oldId}','Valuation','B7',7,2,'formula');
			INSERT INTO metric_facts(fact_id,dataset_id,doc_id,metric_name,sheet_name,cell_ref)
				VALUES('research-fact','dataset-1','${oldId}','Target Price','Valuation','B7');`);
		database.close();
		expect(upload(root, "model.xlsx")).toBe(oldId);
		expect(registerPeDocuments(root, "dataset-1", [{ name: "MODEL.xlsx", bytes }]).documents[0].doc_id).toBe(oldId);
		const oldLink = `source:${Buffer.from(JSON.stringify({ v: 1, doc_id: oldId, sheet: "Valuation", range: "B7" })).toString("base64url")}`;
		const first = await resolvePeEvidenceSource(root, oldLink);
		expect(first.payload).toMatchObject({
			doc_id: oldId,
			version_no: 1,
			kind: "excel",
			cells: expect.arrayContaining([expect.objectContaining({ cell_ref: "B7", cached_value: "120" })]),
		});
		// ZIP readers permit a trailing comment, giving a different immutable original
		// while leaving workbook values unchanged for this versioning regression.
		const changed = Buffer.concat([bytes, Buffer.from("second version")]);
		const second = registerPeDocuments(root, "dataset-1", [{ name: "model.xlsx", bytes: changed }]).documents[0];
		expect(second).toMatchObject({ logical_doc_id: oldId, version_no: 2, supersedes_doc_id: oldId, is_current: 1 });
		expect(readFileSync(join(root, "raw/model.xlsx"))).toEqual(bytes);
		expect((await preparePeDocument(root, { path: "model.xlsx" })).document.doc_id).toBe(second.doc_id);
		const thirdId = upload(root, "model.xlsx");
		expect(thirdId).not.toBe(oldId);
		expect(upload(root, "model.xlsx")).toBe(thirdId);
		const other = registerPeDocuments(root, "dataset-1", [{ name: "other.xlsx", bytes }]);
		expect(other.documents[0]).toMatchObject({ version_no: 1, is_current: 1 });
		expect(other.fileCount).toBe(2);
		const oldPrepared = await preparePeDocument(root, { docId: oldId });
		rmSync(dirname(oldPrepared.cachePath), { recursive: true });
		for (const id of [oldLink, "cell:research-cell", "fact:research-fact"]) {
			const source = await resolvePeEvidenceSource(root, id);
			expect(source.filePath).toBe(first.filePath);
			expect(source.payload).toMatchObject({ doc_id: oldId, version_no: 1, cell_range: "B7" });
		}
		const check = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		try {
			expect(
				check
					.prepare("SELECT version_no,is_current FROM documents WHERE logical_doc_id=? ORDER BY version_no")
					.all(oldId),
			).toEqual([
				{ version_no: 1, is_current: 0 },
				{ version_no: 2, is_current: 0 },
				{ version_no: 3, is_current: 1 },
			]);
			expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			check.close();
		}
	});

	it("registers originals before parsing or publishing derived data", () => {
		const root = project();
		upload(root, "broken.pdf", "not a PDF");
		expect(readdirSync(join(root, "raw"))).toEqual(["broken.pdf"]);
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		try {
			for (const table of ["document_cache", "pdf_pages", "excel_cells", "processing_jobs"])
				expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
			expect(database.prepare("SELECT status,parser_name FROM documents").get()).toMatchObject({
				status: "queued",
				parser_name: null,
			});
		} finally {
			database.close();
		}
	});

	it("reuses unchanged uploads and pins citations across replacements and cache deletion", async () => {
		const root = project();
		const oldId = upload(root, "notes.txt", "original\nrevenue 100");
		expect(upload(root, "notes.txt", "original\nrevenue 100")).toBe(oldId);
		const citation = sourceId({ docId: oldId, location: { kind: "text", lineStart: 2, lineEnd: 2 } });
		const first = await resolvePeEvidenceSource(root, citation);
		expect(first.payload).toMatchObject({ kind: "text", content: "revenue 100", version_no: 1 });
		const newId = upload(root, "notes.txt", "replacement\nrevenue 200");
		expect(newId).not.toBe(oldId);
		const current = await preparePeDocument(root, { path: "raw/notes.txt" });
		expect(current.document.doc_id).toBe(newId);
		rmSync(join(root, "meta/read-cache"), { recursive: true });
		const restored = await resolvePeEvidenceSource(root, citation);
		expect(restored.payload).toEqual(first.payload);
		expect(restored.filePath).toBe(first.filePath);
	});

	it("rebuilds a damaged cache and shares concurrent preparation", async () => {
		const root = project();
		const docId = upload(root, "notes.txt", "Revenue 100");
		const [first, second] = await Promise.all([
			preparePeDocument(root, { docId }),
			preparePeDocument(root, { docId }),
		]);
		expect(first.readablePath).toBe(second.readablePath);
		writeFileSync(first.cachePath, "corrupt");
		const rebuilt = await preparePeDocument(root, { docId });
		expect(readFileSync(rebuilt.readablePath, "utf8")).toContain("Revenue 100");
		expect(JSON.parse(readFileSync(rebuilt.cachePath, "utf8")).doc_id).toBe(docId);
		const damaged = JSON.parse(readFileSync(rebuilt.cachePath, "utf8")) as Record<string, unknown>;
		damaged.text = 42;
		writeFileSync(rebuilt.cachePath, JSON.stringify(damaged));
		const restored = await preparePeDocument(root, { docId });
		expect(JSON.parse(readFileSync(restored.cachePath, "utf8")).text).toBe("Revenue 100");
	});

	it("reads published Node PDF pages and exposes warnings for pages without text", async () => {
		const root = project();
		const docId = upload(root, "report.pdf");
		await expect(preparePeDocument(root, { docId })).rejects.toMatchObject({ status: 409 });
		// Parsing is covered by the Web Node pipeline tests; this suite consumes its published contract.
		const database = new DatabaseSync(join(root, "meta/collection.sqlite3"));
		const page = database.prepare(
			"INSERT INTO pdf_pages VALUES (?,?,?,?,'','body','{}','passed','{}',612,792,0,'[]',0,0,0)",
		);
		for (const [index, text] of ["Revenue: 100 million", "Gross margin: 20%", ""].entries())
			page.run(`${docId}-${index + 1}`, docId, index + 1, text);
		database
			.prepare("UPDATE documents SET status='completed_with_warnings',page_count=3,warnings_json=? WHERE doc_id=?")
			.run(JSON.stringify(["Pages without extractable text: [3]"]), docId);
		database.close();
		const id = sourceId({ docId, location: { kind: "pdf", pageStart: 2, pageEnd: 2 } });
		const { payload } = await resolvePeEvidenceSource(root, id);
		expect(payload).toMatchObject({
			kind: "pdf",
			page_start: 2,
			content: "Gross margin: 20%",
			citation: "report.pdf p.2",
		});
		expect(payload.warnings).toHaveLength(1);
		await expect(
			resolvePeEvidenceSource(root, sourceId({ docId, location: { kind: "pdf", pageStart: 4, pageEnd: 4 } })),
		).rejects.toMatchObject({ status: 404 });
	});

	it("keeps workbook navigation compact and reads full source values, formulas and selected date context", async () => {
		const root = project();
		const docId = upload(root, "model.xlsx");
		expect(inspectPeWorkbooks(root)).toMatchObject({
			workbooks: [
				expect.objectContaining({
					prepared: true,
					sheets: expect.arrayContaining([
						expect.objectContaining({ name: "Valuation", state: "visible" }),
						expect.objectContaining({ name: "Hidden assumptions", state: "hidden" }),
					]),
				}),
			],
		});
		const prepared = await preparePeDocument(root, { docId });
		const id = sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B7" } });
		const { payload } = await resolvePeEvidenceSource(root, id);
		expect(payload).toMatchObject({
			kind: "excel",
			cells: expect.arrayContaining([
				expect.objectContaining({ cell_ref: "B7", formula: "=B5/10", cached_value: "120" }),
			]),
		});
		const navigation = readFileSync(prepared.readablePath, "utf8");
		expect(navigation).toContain("Valuation");
		expect(navigation).not.toContain("x".repeat(5100));
		expect(getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "A10" })).toMatchObject({
			cells: [expect.objectContaining({ raw_value: `Long original note: ${"x".repeat(5100)}` })],
		});
		expect(getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "B5:B7" })).toMatchObject({
			matching_cell_count: 3,
		});
		expect(tracePeFormula(root, { docId, sheetName: "Valuation", cellRef: "B7" })).toMatchObject({
			complete: true,
			node_count: 4,
		});
		const output = locatePeValuationOutputs(root, { docId, query: "Target Price" });
		expect(output).toMatchObject({
			status: "search_results",
			matches: [expect.objectContaining({ cell_ref: "A7", raw_value: "Target Price" })],
		});
		expect(output).not.toHaveProperty("selected_output");
		expect(
			resolvePeValuationDate(root, {
				docId,
				dateSource: { sheet: "Valuation", cell: "B1", text: "2026-08-31T00:00:00" },
				labelSource: { sheet: "Valuation", cell: "A1", text: "Valuation Date" },
				valuationDate: "2026-08-31",
			}),
		).toMatchObject({ status: "inferred", valuation_date: "2026-08-31" });
	});

	it.each([
		["notes.docx", 3, "Revenue"],
		["slides.pptx", 1, "Slide one revenue"],
	] as const)("locates original blocks in %s", async (filename, blockIndex, expected) => {
		const root = project();
		const docId = upload(root, filename);
		const { payload } = await resolvePeEvidenceSource(
			root,
			sourceId({ docId, location: { kind: "block", blockIndex } }),
		);
		expect(payload).toMatchObject({ kind: "text", content: expect.stringContaining(expected) });
	});

	it("bounds source output and rejects nonexistent text locations", async () => {
		const root = project();
		const docId = upload(root, "large.txt", "x".repeat(20_000));
		const { payload } = await resolvePeEvidenceSource(
			root,
			sourceId({ docId, location: { kind: "text", lineStart: 1, lineEnd: 1 } }),
		);
		expect(payload).toMatchObject({ truncated: true, content: "x".repeat(12_000) });
		await expect(
			resolvePeEvidenceSource(root, sourceId({ docId, location: { kind: "text", lineStart: 2, lineEnd: 2 } })),
		).rejects.toThrow("does not exist");
	});

	it("rejects changed originals, escaping paths, and cross-project references", async () => {
		const root = project();
		const docId = upload(root, "notes.txt", "original");
		const citation = sourceId({ docId, location: { kind: "text", lineStart: 1, lineEnd: 1 } });
		await preparePeDocument(root, { docId });
		writeFileSync(join(root, "raw/notes.txt"), "changed");
		await expect(resolvePeEvidenceSource(root, citation)).rejects.toThrow("Original file changed");
		await expect(preparePeDocument(root, { path: "../outside.txt" })).rejects.toThrow("outside");
		await expect(preparePeDocument(root, { docId, datasetId: "another" })).rejects.toThrow("does not match");
		await expect(resolvePeEvidenceSource(project(), citation)).rejects.toThrow("not found");
		rmSync(join(root, "raw/notes.txt"));
		symlinkSync(join(assets, "report.pdf"), join(root, "raw/notes.txt"));
		await expect(resolvePeEvidenceSource(root, citation)).rejects.toThrow("inside raw/");
	});

	it("rolls back a failed multi-file upload and leaves failed parsing retryable", async () => {
		const root = project();
		expect(() =>
			registerPeDocuments(root, "dataset-1", [
				{ name: "ok.txt", bytes: Buffer.from("ok") },
				{ name: "../escape.txt", bytes: Buffer.from("bad") },
			]),
		).toThrow("filename");
		expect(readdirSync(join(root, "raw"))).toEqual([]);
		expect(() => upload(root, "bad.xlsx", "not Excel")).toThrow();
		expect(existsSync(join(root, "raw/bad.xlsx"))).toBe(false);
		const docId = upload(root, "model.xlsx");
		const timeout = process.env.PE_EXCEL_TIMEOUT_MS;
		process.env.PE_EXCEL_TIMEOUT_MS = "1";
		try {
			await expect(preparePeDocument(root, { docId })).rejects.toThrow("exceeded");
		} finally {
			if (timeout === undefined) delete process.env.PE_EXCEL_TIMEOUT_MS;
			else process.env.PE_EXCEL_TIMEOUT_MS = timeout;
		}
		expect((await preparePeDocument(root, { docId })).document.doc_id).toBe(docId);
		const controller = new AbortController();
		controller.abort();
		await expect(preparePeDocument(root, { docId }, controller.signal)).rejects.toThrow();
	});

	it("validates citation syntax and Excel bounds independently of a database", () => {
		const reference = {
			docId: "version_1",
			location: { kind: "excel" as const, sheet: "预测 中文", range: "$XFD$1048576" },
		};
		expect(parseSourceId(sourceId(reference))).toEqual(reference);
		for (const range of ["A0", "XFE1", "A1048577", "A1:B2:C3"])
			expect(() => sourceId({ ...reference, location: { ...reference.location, range } })).toThrow();
		for (const id of ["chunk:old", "source:broken", "source:", "../outside"])
			expect(parseSourceId(id)).toBeUndefined();
	});
});
