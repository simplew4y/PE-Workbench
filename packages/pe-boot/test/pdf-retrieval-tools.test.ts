import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { sourceId } from "../src/source.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { registerPeTools } from "../src/tools/index.ts";
import { savePeMemo } from "../src/tools/memo-storage.ts";
import { pePdfReadTool, readPePdfPages } from "../src/tools/pdf-read.ts";
import { pePdfSearchTool, searchPePdfPages } from "../src/tools/pdf-search.ts";
import { savePeResearchNote } from "../src/tools/research-note-storage.ts";

const temporaryDirectories: string[] = [];

function createPageDatasetFixture(datasetId = "dataset-new"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-boot-pdf-retrieval-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta", "text"), { recursive: true });
	mkdirSync(join(root, "meta", "documents"));
	mkdirSync(join(root, "generated"));
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	database.exec(`
		CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE project_metadata (
			id INTEGER PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE documents (
			doc_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			original_filename TEXT NOT NULL,
			filename_key TEXT NOT NULL,
			raw_path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			status TEXT NOT NULL,
			page_count INTEGER NOT NULL,
			parser_name TEXT NOT NULL,
			parser_version TEXT NOT NULL,
			title TEXT NOT NULL,
			brokerage TEXT NOT NULL,
			document_date TEXT NOT NULL,
			rating TEXT NOT NULL,
			target_price TEXT NOT NULL,
			exhibits_json TEXT NOT NULL,
			pdf_metadata_json TEXT NOT NULL,
			artifact_directory TEXT NOT NULL,
			document_markdown_path TEXT NOT NULL,
			layout_json_path TEXT NOT NULL,
			warnings_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE pdf_pages (
			page_id TEXT PRIMARY KEY,
			doc_id TEXT NOT NULL,
			page_number INTEGER NOT NULL,
			page_text TEXT NOT NULL,
			page_header TEXT NOT NULL,
			role TEXT NOT NULL,
			role_signals_json TEXT NOT NULL,
			text_quality TEXT NOT NULL,
			quality_signals_json TEXT NOT NULL,
			width REAL NOT NULL,
			height REAL NOT NULL,
			rotation INTEGER NOT NULL,
			image_paths_json TEXT NOT NULL,
			embedded_image_count INTEGER NOT NULL,
			large_embedded_image_count INTEGER NOT NULL,
			drawing_operator_count INTEGER NOT NULL
		);
		CREATE VIRTUAL TABLE pdf_pages_fts USING fts5(
			page_id UNINDEXED,
			doc_id UNINDEXED,
			page_text,
			tokenize='trigram'
		);
	`);
	const now = "2026-09-07T00:00:00.000Z";
	database.prepare("INSERT INTO schema_metadata VALUES ('pipeline_schema_version', '2', ?)").run(now);
	database.prepare("INSERT INTO project_metadata VALUES (1, ?, '阳光', ?, ?)").run(datasetId, now, now);
	database
		.prepare(`
		INSERT INTO documents VALUES (
			'doc-sungrow', ?, '阳光电源调研.pdf', '阳光电源调研.pdf', 'raw/阳光电源调研.pdf', 'hash',
			'completed', 3, 'pdfjs-dist', '6.3.289', '阳光电源调研', '', '2026-06-15', '', '',
			'[]', '{}', 'meta/documents/阳光电源调研', 'meta/text/阳光电源调研.md',
			'meta/documents/阳光电源调研/layout.json', '[]', ?, ?
		)
	`)
		.run(datasetId, now, now);
	const insertPage = database.prepare(`
		INSERT INTO pdf_pages VALUES (?, 'doc-sungrow', ?, ?, ?, ?, '{}', ?, '{}', 595, 842, 0, ?, 0, 0, 0)
	`);
	const insertFts = database.prepare("INSERT INTO pdf_pages_fts VALUES (?, 'doc-sungrow', ?)");
	const pages = [
		{
			id: "page-cover",
			number: 1,
			text: "公司重点布局 AIDC 储能与电源业务。",
			header: "阳光电源调研.pdf · p.1/3",
			role: "cover",
			quality: "passed",
		},
		{
			id: "page-profit",
			number: 2,
			text: "储能单位盈利预计达到每瓦时0.3至0.4元。\n这一判断主要来自北美数据中心客户对品牌和交付能力的重视。",
			header: "阳光电源调研.pdf · p.2/3",
			role: "body",
			quality: "passed",
		},
		{
			id: "page-risk",
			number: 3,
			text: "风险包括碳酸锂价格上涨以及海外关税变化。",
			header: "阳光电源调研.pdf · p.3/3",
			role: "body",
			quality: "needs_ocr",
		},
	];
	for (const page of pages) {
		const imagePaths = JSON.stringify([
			`meta/documents/阳光电源调研/pages/page-${String(page.number).padStart(4, "0")}@110.png`,
		]);
		insertPage.run(page.id, page.number, page.text, page.header, page.role, page.quality, imagePaths);
		insertFts.run(page.id, page.text);
	}
	const original = Buffer.from("%PDF-1.7\noriginal fixture");
	writeFileSync(join(root, "raw", "阳光电源调研.pdf"), original);
	database
		.prepare("UPDATE documents SET sha256=? WHERE doc_id='doc-sungrow'")
		.run(createHash("sha256").update(original).digest("hex"));
	database.close();
	return root;
}

function addCatalogPdf(
	root: string,
	options: {
		docId: string;
		filename: string;
		versionNo?: number;
		status?: string;
		lifecycleState?: string;
		deletedAt?: string;
	},
): void {
	const bytes = Buffer.from(`%PDF-1.7\n${options.docId}`);
	const rawPath = `raw/${options.docId}.pdf`;
	writeFileSync(join(root, rawPath), bytes);
	const hash = createHash("sha256").update(bytes).digest("hex");
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	try {
		database
			.prepare(`INSERT INTO documents
			(doc_id,dataset_id,original_filename,filename_key,raw_path,stored_path,source_relpath,sha256,checksum,
			file_type,registration_kind,logical_doc_id,version_no,status,page_count,lifecycle_state,deleted_at,created_at,updated_at)
			VALUES (?,'dataset-new',?,?,?,?,?,?,?,'pdf','catalog',?,?,?,1,?,?,'now','now')`)
			.run(
				options.docId,
				options.filename,
				options.filename.toLowerCase(),
				rawPath,
				rawPath,
				options.filename,
				hash,
				hash,
				options.docId,
				options.versionNo ?? 1,
				options.status ?? "completed",
				options.lifecycleState ?? "active",
				options.deletedAt ?? null,
			);
		database
			.prepare(
				`INSERT INTO pdf_pages VALUES (?, ?, 1, ?, 'p.1', 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0)`,
			)
			.run(`page-${options.docId}`, options.docId, `AIDC ${options.docId}`);
		database
			.prepare("INSERT INTO pdf_pages_fts VALUES (?, ?, ?)")
			.run(`page-${options.docId}`, options.docId, `AIDC ${options.docId}`);
	} finally {
		database.close();
	}
}

function createVersionedPageFixture(): string {
	const root = createPageDatasetFixture();
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"));
	const oldBytes = Buffer.from("%PDF-1.7\noriginal version");
	writeFileSync(join(root, "raw", "阳光电源调研.pdf"), oldBytes);
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	try {
		database
			.prepare(
				"UPDATE documents SET registration_kind='catalog', logical_doc_id='logical-pdf', is_current=0, sha256=?,checksum=? WHERE doc_id='doc-sungrow'",
			)
			.run(createHash("sha256").update(oldBytes).digest("hex"), createHash("sha256").update(oldBytes).digest("hex"));
	} finally {
		database.close();
	}
	addCatalogPdf(root, { docId: "doc-v2", filename: "阳光电源调研.pdf", versionNo: 2 });
	const version = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	try {
		version.exec(
			"UPDATE documents SET logical_doc_id='logical-pdf',supersedes_doc_id='doc-sungrow' WHERE doc_id='doc-v2'",
		);
	} finally {
		version.close();
	}
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE page-level PDF retrieval", () => {
	it("discovers only current active PDFs and reads an explicit historical version without changing its citations", async () => {
		const root = createVersionedPageFixture();
		addCatalogPdf(root, { docId: "archived", filename: "Archived.pdf", lifecycleState: "archived" });
		addCatalogPdf(root, { docId: "deleted", filename: "Deleted.pdf", deletedAt: "2026-09-07" });
		for (const query of ["AIDC", "AI"]) {
			const result = searchPePdfPages(root, { queries: [query] });
			expect(result.results.map((hit) => hit.doc_id)).toEqual(["doc-v2"]);
			expect(result.results[0]).toMatchObject({ version_no: 2, evidence_id: "page:page-doc-v2" });
		}
		expect(readPePdfPages(root, { documentName: "阳光电源调研", pageStart: 1 }).document).toMatchObject({
			doc_id: "doc-v2",
			version_no: 2,
		});
		const historical = readPePdfPages(root, { docId: "doc-sungrow", pageStart: 1 });
		expect(historical.document).toMatchObject({ doc_id: "doc-sungrow", version_no: 1 });
		expect(historical.pages[0].evidence_id).toBe("page:page-cover");
		for (const evidenceId of [
			"page:page-cover",
			sourceId({ docId: "doc-sungrow", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } }),
		]) {
			const source = await resolvePeEvidenceSource(root, evidenceId);
			expect(source.payload).toMatchObject({ doc_id: "doc-sungrow", version_no: 1, evidence_id: evidenceId });
			expect(source.payload.kind === "pdf" && source.payload.content).toContain("AIDC");
		}
		expect(() => readPePdfPages(root, { documentName: "Archived.pdf", pageStart: 1 })).toThrow("not indexed");
		expect(() => readPePdfPages(root, { docId: "deleted", pageStart: 1 })).toThrow("not indexed");
		expect(() => readPePdfPages(root, { docId: "doc-v2", documentName: "Other.pdf", pageStart: 1 })).toThrow(
			"does not match",
		);
	});

	it("does not fall back to a superseded PDF when the current version is pending", () => {
		const root = createVersionedPageFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("UPDATE documents SET status='queued' WHERE doc_id='doc-v2'");
		database.close();
		expect(searchPePdfPages(root, { queries: ["AIDC", "AI"] }).results).toEqual([]);
		expect(() => readPePdfPages(root, { documentName: "阳光电源调研.pdf", pageStart: 1 })).toThrow("not indexed");
		expect(readPePdfPages(root, { docId: "doc-sungrow", pageStart: 1 }).document.doc_id).toBe("doc-sungrow");
	});

	it("rejects ambiguous current filenames and incomplete page indexes", () => {
		const root = createVersionedPageFixture();
		addCatalogPdf(root, { docId: "same-name", filename: "阳光电源调研.pdf" });
		expect(() => readPePdfPages(root, { documentName: "阳光电源调研.pdf", pageStart: 1 })).toThrow(
			"Ambiguous PDF filename",
		);
		expect(readPePdfPages(root, { docId: "same-name", pageStart: 1 }).document.doc_id).toBe("same-name");
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("DELETE FROM pdf_pages WHERE doc_id='doc-v2'");
		database.close();
		expect(() => readPePdfPages(root, { docId: "doc-v2", pageStart: 1 })).toThrow("index is incomplete");
	});

	it("keeps PDF retrieval registered alongside the complete Excel tool chain", () => {
		expect(pePdfSearchTool.name).toBe("pe_pdf_search");
		expect(pePdfReadTool.name).toBe("pe_pdf_read");
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("- pe_pdf_search:");
		expect(prompt).toContain("- pe_pdf_read:");
		expect(prompt).not.toContain("- pe_dataset_search:");
		expect(prompt).toContain("- pe_source_detail:");
		const registered: string[] = [];
		const extension = {
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
			on() {},
		} as unknown as ExtensionAPI;
		registerPeTools(extension);
		expect(registered).toContain("pe_pdf_search");
		expect(registered).toContain("pe_pdf_read");
		expect(registered).not.toContain("pe_dataset_search");
		expect(registered).toContain("pe_source_detail");
		expect(new Set(registered).size).toBe(registered.length);
		expect(registered).toEqual(
			expect.arrayContaining([
				"pe_document_open",
				"pe_workbook_inspect",
				"pe_excel_range",
				"pe_formula_trace",
				"pe_valuation_output_locate",
				"pe_valuation_date_resolve",
				"pe_model_validate",
			]),
		);
		expect(prompt).toContain("Preserve their page: citations");
		expect(prompt).toContain("Historical citations".toLowerCase());
	});

	it("searches complete pages without hardcoded synonym expansion", () => {
		const root = createPageDatasetFixture();
		const result = searchPePdfPages(root, { queries: ["储能单位盈利", "AIDC"], topK: 5 });

		expect(result.dataset_id).toBe("dataset-new");
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					evidence_id: "page:page-profit",
					filename: "阳光电源调研.pdf",
					page_number: 2,
					citation: "阳光电源调研.pdf p.2",
					markdown_citation: "[阳光电源调研.pdf p.2](#pe-source?evidence_id=page%3Apage-profit)",
					excerpt: expect.stringContaining("每瓦时0.3至0.4元"),
				}),
			]),
		);
		expect(result.hint).toContain("does not inject domain synonyms");
	});

	it("supports short literal terms and an exact human-readable document filter", () => {
		const root = createPageDatasetFixture();
		const result = searchPePdfPages(root, {
			queries: ["风险"],
			documentName: "阳光电源调研",
		});

		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			evidence_id: "page:page-risk",
			page_number: 3,
			text_quality: "needs_ocr",
		});
	});

	it("reads complete page ranges by source filename", () => {
		const root = createPageDatasetFixture();
		const result = readPePdfPages(root, {
			documentName: "阳光电源调研",
			pageStart: 1,
			pageEnd: 2,
		});

		expect(result.document).toMatchObject({
			filename: "阳光电源调研.pdf",
			page_count: 3,
			document_markdown_path: "meta/text/阳光电源调研.md",
		});
		expect(result.pages).toHaveLength(2);
		expect(result.pages[1]).toMatchObject({
			evidence_id: "page:page-profit",
			content: expect.stringContaining("品牌和交付能力"),
			page_image_paths: ["meta/documents/阳光电源调研/pages/page-0002@110.png"],
		});
	});

	it("validates dataset identity", () => {
		const root = createPageDatasetFixture();
		expect(() => searchPePdfPages(root, { queries: ["储能"], datasetId: "wrong" })).toThrow(
			"does not match the current project dataset",
		);
	});

	it("resolves an empty project identity from project metadata", () => {
		const root = createPageDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("DELETE FROM pdf_pages_fts; DELETE FROM pdf_pages; DELETE FROM documents;");
		database.close();

		const result = searchPePdfPages(root, { queries: ["储能"] });
		expect(result.dataset_id).toBe("dataset-new");
		expect(result.results).toEqual([]);
	});

	it("accepts page evidence in Research Notes and Memo Citation Gate", async () => {
		const root = createPageDatasetFixture();
		const note = await savePeResearchNote(root, {
			title: "储能盈利研究笔记",
			summary: "核验储能单位盈利。",
			presentationMode: "text",
			contentHtml: "<!doctype html><html><body>储能单位盈利研究</body></html>",
			evidenceIds: ["page:page-profit"],
		});
		expect(note.resolved_evidence_ids).toEqual(["page:page-profit"]);
		expect(note.unresolved_evidence_ids).toEqual([]);

		const memo = await savePeMemo(root, {
			operation: "create",
			topic: "储能单位盈利",
			claims: [
				{
					section: "核心判断",
					text: "储能单位盈利预计达到每瓦时0.3至0.4元。",
					status: "supported",
					evidenceIds: ["page:page-profit"],
				},
			],
		});
		expect(memo.citation_gate).toMatchObject({
			passed: true,
			valid_evidence_ids: ["page:page-profit"],
		});
	});
});
