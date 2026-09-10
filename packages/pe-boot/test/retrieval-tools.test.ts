import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peDatasetSearchTool, searchPeDataset } from "../src/tools/dataset-search.ts";
import { getPeSourceDetail, peSourceDetailTool } from "../src/tools/source-detail.ts";

const temporaryDirectories: string[] = [];

function createDatasetFixture(datasetId = "dataset-1"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-boot-retrieval-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "meta"));
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	database.exec(`
		CREATE TABLE documents (
			doc_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			original_filename TEXT NOT NULL,
			source_relpath TEXT,
			file_type TEXT NOT NULL,
			doc_type TEXT,
			document_date TEXT,
			version_no INTEGER NOT NULL DEFAULT 1,
			is_current INTEGER NOT NULL DEFAULT 1,
			lifecycle_state TEXT NOT NULL DEFAULT 'active',
			deleted_at TEXT
		);
		CREATE TABLE chunks (
			chunk_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			content TEXT NOT NULL,
			content_type TEXT NOT NULL,
			title_path TEXT,
			summary TEXT,
			source_ref TEXT
		);
		CREATE TABLE chunk_locations (
			chunk_id TEXT NOT NULL,
			location_index INTEGER NOT NULL,
			page_start INTEGER,
			page_end INTEGER,
			sheet_name TEXT,
			cell_range TEXT,
			heading_path TEXT
		);
		CREATE TABLE pdf_pages (
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			page_number INTEGER NOT NULL,
			text TEXT NOT NULL
		);
		CREATE TABLE metric_facts (
			fact_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			metric_alias TEXT,
			period TEXT,
			value_text TEXT,
			value_numeric REAL,
			unit TEXT,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL,
			source_range TEXT,
			formula TEXT,
			confidence REAL
		);
		CREATE TABLE excel_cells (
			cell_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL,
			row_index INTEGER NOT NULL,
			col_index INTEGER NOT NULL,
			display_value TEXT,
			raw_value TEXT,
			numeric_value REAL,
			formula TEXT,
			row_label TEXT,
			col_label TEXT,
			period TEXT,
			unit TEXT,
			is_formula INTEGER NOT NULL DEFAULT 0
		);
	`);

	const insertDocument = database.prepare(
		"INSERT INTO documents (doc_id, dataset_id, original_filename, source_relpath, file_type, doc_type, document_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	insertDocument.run("doc-pdf", datasetId, "访谈.pdf", "访谈.pdf", "pdf", "expert_interview", "2026-08-01");
	insertDocument.run("doc-xlsx", datasetId, "模型.xlsx", "模型.xlsx", "xlsx", "valuation_model", "2026-08-02");
	database
		.prepare(
			"INSERT INTO chunks (chunk_id, dataset_id, doc_id, content, content_type, title_path, summary, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"chunk-storage",
			datasetId,
			"doc-pdf",
			"公司预计储能业务盈利修复，单位盈利提升。",
			"pdf_page",
			"访谈 > page 2",
			"储能盈利修复",
			"访谈.pdf p.2",
		);
	database
		.prepare(
			"INSERT INTO chunk_locations (chunk_id, location_index, page_start, page_end, heading_path) VALUES (?, 0, 2, 2, ?)",
		)
		.run("chunk-storage", "访谈 > page 2");
	const insertPage = database.prepare(
		"INSERT INTO pdf_pages (dataset_id, doc_id, page_number, text) VALUES (?, 'doc-pdf', ?, ?)",
	);
	insertPage.run(datasetId, 1, "第一页背景信息");
	insertPage.run(datasetId, 2, "第二页原文：公司预计储能业务盈利修复，单位盈利提升。");
	insertPage.run(datasetId, 3, "第三页风险信息");
	database
		.prepare(
			"INSERT INTO metric_facts (fact_id, dataset_id, doc_id, metric_name, metric_alias, period, value_text, value_numeric, unit, sheet_name, cell_ref, source_range, formula, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"fact-revenue",
			datasetId,
			"doc-xlsx",
			"Revenue",
			"sales",
			"2026E",
			"1200",
			1200,
			"CNYm",
			"Forecast",
			"C5",
			"Forecast!C5",
			"=SUM(C3:C4)",
			0.9,
		);
	const insertCell = database.prepare(
		"INSERT INTO excel_cells (cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index, display_value, raw_value, numeric_value, formula, row_label, col_label, period, unit, is_formula) VALUES (?, ?, 'doc-xlsx', 'Forecast', ?, 5, ?, ?, ?, ?, ?, 'Revenue', ?, '2026E', 'CNYm', ?)",
	);
	insertCell.run("cell-b5", datasetId, "B5", 2, "Revenue", "Revenue", null, null, "2025A", 0);
	insertCell.run("cell-c5", datasetId, "C5", 3, "1200", "=SUM(C3:C4)", 1200, "=SUM(C3:C4)", "2026E", 1);
	insertCell.run("cell-d5", datasetId, "D5", 4, "1400", "1400", 1400, null, "2027E", 0);
	database.close();
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE retrieval tools", () => {
	it("exposes pe-prefixed tool names", () => {
		expect(peDatasetSearchTool.name).toBe("pe_dataset_search");
		expect(peSourceDetailTool.name).toBe("pe_source_detail");
		expect(buildPeSystemPrompt("/workspace")).not.toContain("- pe_dataset_search:");
		expect(buildPeSystemPrompt("/workspace")).not.toContain("- pe_source_detail:");
	});

	it("searches PDF chunks and returns stable evidence IDs", () => {
		const root = createDatasetFixture();
		const result = searchPeDataset(root, { query: "储能盈利", topK: 3 });

		expect(result.dataset_id).toBe("dataset-1");
		expect(result.evidence[0]).toMatchObject({
			evidence_id: "chunk:chunk-storage",
			evidence_type: "chunk",
			citation: "访谈.pdf p.2",
			markdown_citation: "[访谈.pdf p.2](#pe-source?evidence_id=chunk%3Achunk-storage)",
			locator: { page_start: 2, page_end: 2 },
		});
		expect(result.answer_contract).toContain("Never show a bare evidence_id");
	});

	it("searches metric facts through Chinese keyword expansion", () => {
		const root = createDatasetFixture();
		const result = searchPeDataset(root, {
			query: "收入",
			includeMetricFacts: true,
			includeExpandedTerms: true,
		});

		expect(result.expanded_terms).toContain("revenue");
		expect(result.evidence).toContainEqual(
			expect.objectContaining({
				evidence_id: "fact:fact-revenue",
				citation: "模型.xlsx Forecast!C5",
				metric: expect.objectContaining({ name: "Revenue", value_numeric: 1200 }),
			}),
		);
	});

	it("returns PDF page context for chunk evidence", () => {
		const root = createDatasetFixture();
		const result = getPeSourceDetail(root, {
			evidenceId: "chunk:chunk-storage",
			contextRadius: 1,
		});

		expect(result).toMatchObject({
			evidence_id: "chunk:chunk-storage",
			mode: "text",
			citation: "访谈.pdf p.2",
			markdown_citation: "[访谈.pdf p.2](#pe-source?evidence_id=chunk%3Achunk-storage)",
			content: expect.stringContaining("储能业务盈利修复"),
			pdf_pages: [
				expect.objectContaining({ page_number: 1 }),
				expect.objectContaining({ page_number: 2, text: expect.stringContaining("第二页原文") }),
				expect.objectContaining({ page_number: 3 }),
			],
		});
	});

	it("returns Excel formulas and a bounded cell window", () => {
		const root = createDatasetFixture();
		const result = getPeSourceDetail(root, { evidenceId: "fact:fact-revenue" });

		expect(result).toMatchObject({
			evidence_id: "fact:fact-revenue",
			mode: "excel_window",
			citation: "模型.xlsx Forecast!C5",
			metric: { name: "Revenue", formula: "=SUM(C3:C4)" },
			excel_cells: expect.arrayContaining([
				expect.objectContaining({ cell_ref: "C5", numeric_value: 1200, formula: "=SUM(C3:C4)" }),
			]),
		});
	});

	it("rejects a dataset ID that does not match the current workspace", () => {
		const root = createDatasetFixture();
		expect(() => searchPeDataset(root, { query: "储能", datasetId: "another-dataset" })).toThrow(
			"does not match the current project dataset",
		);
	});
});
