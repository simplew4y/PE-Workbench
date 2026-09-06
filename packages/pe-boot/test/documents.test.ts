import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { preparePeDocument, registerPeDocuments, resolvePeEvidenceSource } from "../src/documents.ts";
import { parseSourceId, sourceId, sourceUrl } from "../src/source.ts";
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

	it("keeps full workbook values, formulas, date evidence, and native-searchable source links", async () => {
		const root = project();
		const docId = upload(root, "model.xlsx");
		expect(inspectPeWorkbooks(root)).toMatchObject({ workbooks: [expect.objectContaining({ prepared: false })] });
		const prepared = await preparePeDocument(root, { docId });
		const id = sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B7" } });
		const { payload } = await resolvePeEvidenceSource(root, id);
		expect(payload).toMatchObject({
			kind: "excel",
			cells: expect.arrayContaining([
				expect.objectContaining({ cell_ref: "B7", formula: "=B5/10", cached_value: "120" }),
			]),
		});
		expect(readFileSync(prepared.readablePath, "utf8")).toContain(sourceUrl(id));
		expect(readFileSync(prepared.readablePath, "utf8")).toContain("x".repeat(5100));
		expect(getPeExcelRange(root, { docId, sheetName: "Valuation", cellRange: "B5:B7" })).toMatchObject({
			matching_cell_count: 3,
		});
		expect(tracePeFormula(root, { docId, sheetName: "Valuation", cellRef: "B7" })).toMatchObject({
			complete: true,
			node_count: 4,
		});
		const output = locatePeValuationOutputs(root, { docId });
		expect(output.selected_output).toMatchObject({ cell_ref: "B7", evidence_id: id });
		expect(
			resolvePeValuationDate(root, {
				docId,
				outputSheet: "Valuation",
				outputCellRef: "B7",
				outputCandidateId: output.selected_candidate_id,
			}),
		).toMatchObject({ status: "verified", valuation_date: "2026-08-31" });
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
