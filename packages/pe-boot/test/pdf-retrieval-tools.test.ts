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
import { listPePdfDocuments, pePdfListTool } from "../src/tools/pdf-list.ts";
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
			expect(result.documents.map((document) => document.doc_id)).toEqual(["doc-v2"]);
			expect(result.documents[0]).toMatchObject({ version_no: 2 });
			expect(result.documents[0].pages[0]).toMatchObject({ evidence_id: "page:page-doc-v2" });
		}
		const listing = listPePdfDocuments(root);
		expect(listing.documents.map((document) => document.doc_id)).toEqual(["doc-v2"]);
		expect(
			listPePdfDocuments(root, { includeHistorical: true }).documents.map((document) => document.doc_id),
		).toEqual(expect.arrayContaining(["doc-v2", "doc-sungrow", "archived"]));
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
		// A doc_id plus a fragment that names a different document must still be rejected.
		expect(() => readPePdfPages(root, { docId: "doc-v2", documentName: "Archived", pageStart: 1 })).toThrow(
			"does not match",
		);
		expect(readPePdfPages(root, { docId: "doc-v2", documentName: "阳光电源", pageStart: 1 }).document.doc_id).toBe(
			"doc-v2",
		);
	});

	it("does not fall back to a superseded PDF when the current version is pending", () => {
		const root = createVersionedPageFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("UPDATE documents SET status='queued' WHERE doc_id='doc-v2'");
		database.close();
		expect(searchPePdfPages(root, { queries: ["AIDC", "AI"] }).documents).toEqual([]);
		expect(listPePdfDocuments(root).documents.map((document) => [document.doc_id, document.status])).toEqual([
			["doc-v2", "queued"],
		]);
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
		expect(pePdfListTool.name).toBe("pe_pdf_list");
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).toContain("- pe_pdf_list:");
		expect(prompt).toContain("- pe_pdf_search:");
		expect(prompt).toContain("call pe_pdf_list first");
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
		expect(registered).toContain("pe_pdf_list");
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

	it("lists documents with cover metadata and page-role counts", () => {
		const root = createPageDatasetFixture();
		const result = listPePdfDocuments(root);
		expect(result.document_count).toBe(1);
		expect(result.documents[0]).toMatchObject({
			doc_id: "doc-sungrow",
			filename: "阳光电源调研.pdf",
			title: "阳光电源调研",
			document_date: "2026-06-15",
			page_count: 3,
			status: "completed",
			needs_ocr_page_count: 1,
			page_roles: { cover: 1, body: 2 },
			document_markdown_path: "meta/text/阳光电源调研.md",
		});
		expect(result.documents[0]).not.toHaveProperty("brokerage");
		expect(result.hint).toContain("cover-page rules");
	});

	it("returns every matched page in document order with matched lines and no ranking", () => {
		const root = createPageDatasetFixture();
		const result = searchPePdfPages(root, { queries: ["储能单位盈利", "AIDC"] });

		expect(result.dataset_id).toBe("dataset-new");
		expect(result).toMatchObject({
			matched_document_count: 1,
			matched_page_count: 2,
			shown_page_count: 2,
			truncated: false,
		});
		expect(result.documents[0]).toMatchObject({
			doc_id: "doc-sungrow",
			filename: "阳光电源调研.pdf",
			matched_page_count: 2,
		});
		expect(result.documents[0].pages.map((page) => page.page_number)).toEqual([1, 2]);
		expect(result.documents[0].pages[1]).toMatchObject({
			evidence_id: "page:page-profit",
			page_role: "body",
			citation: "阳光电源调研.pdf p.2",
			markdown_citation: "[阳光电源调研.pdf p.2](#pe-source?evidence_id=page%3Apage-profit)",
			matched_queries: ["储能单位盈利"],
			matched_line_count: 1,
			lines: [{ line_number: 1, text: "储能单位盈利预计达到每瓦时0.3至0.4元。", matched_queries: ["储能单位盈利"] }],
		});
		expect(result.documents[0].pages[0]).not.toHaveProperty("score");
		expect(result.hint).toContain("does not inject domain synonyms");
		expect(result.hint).toContain("without ranking");
	});

	it("folds disclosure pages unless asked for them and honors role filters", () => {
		const root = createPageDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		const disclosureText = `${"储能 AIDC 阳光电源 ".repeat(20)}免责声明：本报告仅供参考。`;
		database
			.prepare(
				"INSERT INTO pdf_pages VALUES (?, 'doc-sungrow', 4, ?, ?, ?, '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0)",
			)
			.run(
				"page-disclosure",
				disclosureText,
				"阳光电源调研.pdf · p.4/4 · disclosure_boilerplate",
				"disclosure_boilerplate",
			);
		database.prepare("INSERT INTO pdf_pages_fts VALUES ('page-disclosure', 'doc-sungrow', ?)").run(disclosureText);
		database.exec("UPDATE documents SET page_count=4 WHERE doc_id='doc-sungrow'");
		database.close();

		const folded = searchPePdfPages(root, { queries: ["储能", "AIDC"] });
		expect(folded.documents[0].pages.map((page) => page.page_number)).toEqual([1, 2]);
		expect(folded.documents[0]).toMatchObject({
			matched_page_count: 3,
			shown_page_count: 2,
			folded_disclosure_pages: [4],
		});

		const expanded = searchPePdfPages(root, { queries: ["储能", "AIDC"], includeDisclosure: true });
		expect(expanded.documents[0].pages.map((page) => page.page_number)).toEqual([1, 2, 4]);
		expect(expanded.documents[0].pages[2]).toMatchObject({
			page_role: "disclosure_boilerplate",
			matched_queries: ["储能", "AIDC"],
		});

		const onlyDisclosure = searchPePdfPages(root, { queries: ["储能"], roles: ["disclosure_boilerplate"] });
		expect(onlyDisclosure.documents[0].pages.map((page) => page.page_number)).toEqual([4]);
		expect(
			searchPePdfPages(root, { queries: ["储能"], roles: ["cover"] }).documents[0].pages.map(
				(page) => page.page_number,
			),
		).toEqual([1]);
	});

	it("truncates by page budget and limits lines per page while reporting full counts", () => {
		const root = createPageDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		const longText = Array.from({ length: 6 }, (_, index) => `第${index + 1}行提到储能业务`).join("\n");
		database
			.prepare(
				"INSERT INTO pdf_pages VALUES (?, 'doc-sungrow', 4, ?, 'p.4', 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0)",
			)
			.run("page-long", longText);
		database.prepare("INSERT INTO pdf_pages_fts VALUES ('page-long', 'doc-sungrow', ?)").run(longText);
		database.exec("UPDATE documents SET page_count=4 WHERE doc_id='doc-sungrow'");
		database.close();

		const result = searchPePdfPages(root, { queries: ["储能"], maxPages: 1, maxLinesPerPage: 2 });
		expect(result).toMatchObject({ matched_page_count: 3, shown_page_count: 1, truncated: true });
		expect(result.documents[0].pages).toHaveLength(1);
		const full = searchPePdfPages(root, { queries: ["储能"], maxLinesPerPage: 2 });
		const longPage = full.documents[0].pages.find((page) => page.page_number === 4);
		expect(longPage).toMatchObject({ matched_line_count: 6 });
		expect(longPage?.lines.map((line) => line.line_number)).toEqual([1, 2]);
	});

	it("keeps the matched term inside a truncated excerpt of a very long line", () => {
		const root = createPageDatasetFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		// Leading whitespace used to shift the excerpt window and cut the match out of it.
		const longLine = `${" ".repeat(200)}储能单位盈利${"补充说明".repeat(200)}`;
		database
			.prepare(
				"INSERT INTO pdf_pages VALUES ('page-long-line', 'doc-sungrow', 4, ?, 'p.4', 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0)",
			)
			.run(longLine);
		database.prepare("INSERT INTO pdf_pages_fts VALUES ('page-long-line', 'doc-sungrow', ?)").run(longLine);
		database.exec("UPDATE documents SET page_count=4 WHERE doc_id='doc-sungrow'");
		database.close();

		const page = searchPePdfPages(root, { queries: ["储能单位盈利"] }).documents[0].pages.find(
			(candidate) => candidate.page_number === 4,
		);
		expect(page?.lines[0].text).toContain("储能单位盈利");
		expect(page?.lines[0].text.startsWith(" ")).toBe(false);
	});

	it("supports short literal terms and an exact human-readable document filter", () => {
		const root = createPageDatasetFixture();
		const result = searchPePdfPages(root, {
			queries: ["风险"],
			documentName: "阳光电源调研",
		});

		expect(result.documents).toHaveLength(1);
		expect(result.documents[0].pages).toHaveLength(1);
		expect(result.documents[0].pages[0]).toMatchObject({
			evidence_id: "page:page-risk",
			page_number: 3,
			text_quality: "needs_ocr",
		});
	});

	it("matches stored file names that keep full-width punctuation from the upload pipeline", () => {
		const root = createVersionedPageFixture();
		const stored = "Bernstein-Hermes International(RMS.FP)Hermès： Stretching upwards.pdf";
		addCatalogPdf(root, { docId: "doc-fullwidth", filename: stored });
		for (const requested of [stored, stored.replace("：", ":"), stored.replace("：", ":").replace(/\.pdf$/u, "")]) {
			expect(readPePdfPages(root, { documentName: requested, pageStart: 1 }).document.doc_id).toBe("doc-fullwidth");
			const search = searchPePdfPages(root, { queries: ["AIDC"], documentName: requested });
			expect(search.documents.map((document) => document.doc_id)).toEqual(["doc-fullwidth"]);
		}
	});

	it("resolves distinctive filename fragments and attaches images for chart, screenshot, and OCR pages", () => {
		const root = createPageDatasetFixture();
		mkdirSync(join(root, "meta", "documents", "阳光电源调研", "pages"), { recursive: true });
		const png = Buffer.from("89504e470d0a1a0a", "hex");
		for (const page of [1, 2, 3]) {
			writeFileSync(join(root, "meta", "documents", "阳光电源调研", "pages", `page-000${page}@110.png`), png);
		}
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec("UPDATE pdf_pages SET role='exhibit_chart' WHERE page_id='page-profit'");
		database.close();

		const byFragment = readPePdfPages(root, { documentName: "阳光电源", pageStart: 1, pageEnd: 3 });
		expect(byFragment.document.doc_id).toBe("doc-sungrow");
		expect(byFragment.attached_page_images.map((image) => [image.page_number, image.page_role])).toEqual([
			[2, "exhibit_chart"],
			[3, "body"],
		]);
		expect(
			readPePdfPages(root, { documentName: "阳光电源", pageStart: 1, includeImages: "never" }).attached_page_images,
		).toEqual([]);
		expect(
			readPePdfPages(root, { documentName: "阳光电源", pageStart: 1, includeImages: "always" }).attached_page_images,
		).toHaveLength(1);
		const fourth = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		fourth
			.prepare(
				"INSERT INTO pdf_pages VALUES ('page-four', 'doc-sungrow', 4, '第四页储能内容', 'p.4', 'exhibit_chart', '{}', 'passed', '{}', 595, 842, 0, ?, 0, 0, 0)",
			)
			.run(JSON.stringify(["meta/documents/阳光电源调研/pages/page-0004@110.png"]));
		fourth.exec("UPDATE documents SET page_count=4 WHERE doc_id='doc-sungrow'");
		fourth.close();
		writeFileSync(join(root, "meta", "documents", "阳光电源调研", "pages", "page-0004@110.png"), png);

		const capped = readPePdfPages(root, {
			documentName: "阳光电源",
			pageStart: 1,
			pageEnd: 4,
			includeImages: "always",
		});
		expect(capped.attached_page_images.map((image) => image.page_number)).toEqual([1, 2, 3]);
		expect(capped.omitted_page_images).toEqual([
			{
				page_number: 4,
				page_role: "exhibit_chart",
				path: "meta/documents/阳光电源调研/pages/page-0004@110.png",
				reason: "attachment_limit",
			},
		]);
		expect(() => readPePdfPages(root, { documentName: "不存在", pageStart: 1 })).toThrow("not indexed");
		expect(searchPePdfPages(root, { queries: ["储能"], documentName: "阳光电源" }).documents[0]?.doc_id).toBe(
			"doc-sungrow",
		);
		expect(searchPePdfPages(root, { queries: ["储能"], documentName: "不存在" }).documents).toEqual([]);
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
		expect(result.documents).toEqual([]);
		expect(listPePdfDocuments(root).documents).toEqual([]);
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
