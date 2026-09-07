import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { sourceId } from "../src/source.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peDatasetMemoTool } from "../src/tools/dataset-memo.ts";
import { peHistoryCompareTool } from "../src/tools/history-compare.ts";
import { comparePeMemoVersions, getPeMemoVersion, listPeMemoHistory, savePeMemo } from "../src/tools/memo-storage.ts";

const temporaryDirectories: string[] = [];

function createMemoFixture(datasetId = "dataset-1"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-boot-memo-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	mkdirSync(join(root, "generated"));
	initializePeCollectionDatabase(join(root, "meta", "collection.sqlite3"), {
		datasetId,
		name: "Memo Test",
	});
	const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
	const insertDocument = database.prepare(
		`INSERT INTO documents (
				doc_id,dataset_id,original_filename,filename_key,raw_path,sha256,status,page_count,
				parser_name,parser_version,title,brokerage,document_date,rating,target_price,
				exhibits_json,pdf_metadata_json,artifact_directory,document_markdown_path,
				layout_json_path,warnings_json,created_at,updated_at,file_type,source_relpath,
				file_size,readable_text_path
			) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	insertDocument.run(
		"doc-1",
		datasetId,
		"访谈.pdf",
		"访谈.pdf",
		"raw/访谈.pdf",
		"a".repeat(64),
		"completed",
		3,
		"pdfjs-dist",
		"6.3.289",
		"访谈",
		"",
		"2026-08-01",
		"",
		"",
		"[]",
		"{}",
		"meta/documents/访谈",
		"meta/text/访谈.md",
		"meta/documents/访谈/layout.json",
		"[]",
		"2026-08-01T00:00:00.000Z",
		"2026-08-01T00:00:00.000Z",
		"pdf",
		"访谈.pdf",
		0,
		"meta/text/访谈.md",
	);
	insertDocument.run(
		"doc-excel",
		datasetId,
		"经营模型.xlsx",
		"经营模型.xlsx",
		"raw/经营模型.xlsx",
		"b".repeat(64),
		"completed",
		0,
		"openpyxl",
		"3.1.5",
		"经营模型",
		"",
		"2026-08-01",
		"",
		"",
		"[]",
		"{}",
		"meta/documents/经营模型.xlsx",
		"",
		"",
		"[]",
		"2026-08-01T00:00:00.000Z",
		"2026-08-01T00:00:00.000Z",
		"xlsx",
		"经营模型.xlsx",
		0,
		"meta/text/经营模型.xlsx.txt",
	);
	const insertPage = database.prepare(
		`INSERT INTO pdf_pages (
			page_id,doc_id,page_number,page_text,page_header,role,role_signals_json,text_quality,
			quality_signals_json,width,height,rotation,image_paths_json,embedded_image_count,
			large_embedded_image_count,drawing_operator_count
		) VALUES (?, 'doc-1', ?, ?, ?, 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0)`,
	);
	insertPage.run("page-a", 2, "收入增长20%。", "访谈.pdf · p.2/4");
	insertPage.run("page-b", 3, "毛利率改善。", "访谈.pdf · p.3/4");
	insertPage.run("page-c", 4, "新增订单。", "访谈.pdf · p.4/4");
	database
		.prepare(`INSERT INTO excel_cells (
		cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,display_value,
		raw_value,numeric_value,formula,cached_value,number_format,row_label,col_label,period,unit,
		is_formula,formula_type,formula_cache_status,metadata_json
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			"cell-b2",
			datasetId,
			"doc-excel",
			"数据",
			"B2",
			2,
			2,
			"number",
			"120",
			"120",
			120,
			null,
			null,
			"0",
			"收入",
			"2025",
			"2025",
			"百万元",
			0,
			null,
			"not_applicable",
			"{}",
		);
	database.close();
	return root;
}

function supported(section: string, text: string, evidenceId: string) {
	return { section, text, status: "supported" as const, evidenceIds: [evidenceId] };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE Memo tools", () => {
	it("exposes Memo tools and loads the package Skill", () => {
		expect(peDatasetMemoTool.name).toBe("pe_dataset_memo");
		expect(peHistoryCompareTool.name).toBe("pe_history_compare");
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).not.toContain("- pe_dataset_memo:");
		expect(prompt).not.toContain("- pe_history_compare:");
		expect(prompt).toContain("- pe_pdf_search:");
		expect(prompt).toContain("- pe_pdf_read:");

		const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
		const result = loadSkillsFromDir({ dir: join(packageDirectory, "skills"), source: "test" });
		expect(result.diagnostics).toEqual([]);
		expect(result.skills).toEqual([
			expect.objectContaining({
				name: "pe-generative-ui",
				description: expect.stringContaining("pre-registered native UI surfaces"),
			}),
			expect.objectContaining({
				name: "pe-memo",
				description: expect.stringContaining("persistent, evidence-backed PE Memo"),
			}),
			expect.objectContaining({ name: "pe-research-note" }),
			expect.objectContaining({ name: "pe-valuation-model-explainer" }),
		]);
	});

	it("creates Markdown, safe HTML, and PDF, then downgrades invalid citations", async () => {
		const root = createMemoFixture();
		const result = await savePeMemo(root, {
			operation: "create",
			topic: "收入与盈利",
			title: "收入与盈利 Memo",
			claims: [
				supported("核心结论", "收入增长20%。", "page:page-a"),
				supported("风险", "<script>alert('x')</script> 需要核验。", "page:missing"),
				{ section: "待跟踪", text: "海外订单资料不足。", status: "not_covered", evidenceIds: [] },
			],
		});

		expect(result).toMatchObject({
			dataset_id: "dataset-1",
			memo_version_no: 1,
			idempotent_replay: false,
			citation_gate: {
				status: "needs_review",
				needs_review: true,
				invalid_evidence_ids: ["page:missing"],
			},
		});
		expect(result.memo_markdown_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.md$/u);
		expect(result.memo_html_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.html$/u);
		expect(result.memo_pdf_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.pdf$/u);
		const markdown = readFileSync(join(root, result.memo_markdown_path ?? ""), "utf8");
		const html = readFileSync(join(root, result.memo_html_path ?? ""), "utf8");
		const pdf = readFileSync(join(root, result.memo_pdf_path ?? ""));
		const citationGate = JSON.parse(readFileSync(join(root, result.citation_gate_audit_path ?? ""), "utf8")) as {
			claims: Array<{ claim_id: string; text: string; evidence_ids: string[] }>;
		};
		expect(markdown).toContain("访谈.pdf p.2");
		expect(markdown).toContain("内容：收入增长20%。");
		expect(markdown).not.toContain("page:page-a");
		expect(markdown).toContain("待复核");
		expect(html).toContain("访谈.pdf p.2");
		expect(html).toContain("收入增长20%。");
		expect(html).not.toContain("page:page-a");
		expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(citationGate.claims[0]).toMatchObject({
			claim_id: "claim-1",
			text: "收入增长20%。",
			evidence_ids: ["page:page-a"],
		});
		expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		expect(pdf.byteLength).toBeGreaterThan(5_000);
		expect(pdf.toString("latin1").match(/\/Type \/Page\b/gu)).toHaveLength(1);

		const version = getPeMemoVersion(root, result.memo_version_id);
		expect(version.sections).toHaveLength(3);
		expect(version.sections[0]).toMatchObject({ evidence_ids: ["page:page-a"], needs_review: false });
		expect(version.markdown_path).toBe(result.memo_markdown_path);
		expect(version.pdf_path).toBe(result.memo_pdf_path);
	});

	it("returns the current version for duplicate create and requires explicit revise", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "收入增长20%。", "page:page-a")],
		});
		const duplicate = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "另一版本。", "page:page-b")],
		});

		expect(duplicate).toMatchObject({
			memo_version_id: first.memo_version_id,
			memo_version_no: 1,
			idempotent_replay: true,
		});
		const history = listPeMemoHistory(root, { topic: "稳定" });
		expect(history.series).toHaveLength(1);
		expect(history.versions).toHaveLength(1);
		await expect(
			savePeMemo(root, {
				operation: "revise",
				topic: "稳定主题",
				claims: [supported("结论", "修订。", "page:page-b")],
			}),
		).rejects.toThrow("revision_of is required");
	});

	it("accepts verified Excel source citations in the Citation Gate", async () => {
		const root = createMemoFixture();
		const evidenceId = sourceId({ docId: "doc-excel", sheet: "数据", range: "B2" });
		const result = await savePeMemo(root, {
			operation: "create",
			topic: "Excel 证据",
			claims: [supported("经营指标", "2025 年收入为 120 百万元。", evidenceId)],
		});

		expect(result.citation_gate).toMatchObject({
			passed: true,
			valid_evidence_ids: [evidenceId],
		});
		const markdown = readFileSync(join(root, result.memo_markdown_path ?? ""), "utf8");
		expect(markdown).toContain("经营模型.xlsx 数据!B2");
		expect(markdown).not.toContain(evidenceId);
	});

	it("creates an immutable revision and compares section states", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "版本测试",
			claims: [
				supported("保持", "收入增长20%。", "page:page-a"),
				{ section: "旧章节", text: "暂缺资料。", status: "not_covered", evidenceIds: [] },
				supported("变化", "毛利率改善。", "page:page-b"),
			],
		});
		const firstMarkdown = readFileSync(join(root, first.memo_markdown_path ?? ""), "utf8");
		const second = await savePeMemo(root, {
			operation: "revise",
			topic: "不应创建新主题",
			revisionOf: first.memo_version_id,
			claims: [
				supported("保持", "收入增长20%。", "page:page-a"),
				supported("变化", "毛利率显著改善。", "page:page-b"),
				supported("新增", "新增订单。", "page:page-c"),
			],
		});

		expect(second).toMatchObject({
			topic: "版本测试",
			memo_series_id: first.memo_series_id,
			memo_version_no: 2,
			revision_of_version_id: first.memo_version_id,
		});
		expect(readFileSync(join(root, first.memo_markdown_path ?? ""), "utf8")).toBe(firstMarkdown);
		const comparison = comparePeMemoVersions(root, first.memo_version_id, second.memo_version_id);
		expect(comparison.counts).toEqual({ added: 1, changed: 1, unchanged: 1, not_mentioned: 1 });
		expect(comparison.section_changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ title: "旧章节", change_type: "not_mentioned" }),
				expect.objectContaining({ title: "新增", change_type: "added" }),
			]),
		);
	});

	it("rolls back database rows and new artifacts when persistence fails", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "事务测试",
			claims: [supported("结论", "收入增长20%。", "page:page-a")],
		});
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			CREATE TRIGGER reject_new_memo_sections
			BEFORE INSERT ON research_memo_sections
			WHEN NEW.memo_version_id <> '${first.memo_version_id}'
			BEGIN
				SELECT RAISE(ABORT, 'forced section failure');
			END;
		`);
		database.close();

		await expect(
			savePeMemo(root, {
				operation: "revise",
				topic: "事务测试",
				revisionOf: first.memo_version_id,
				claims: [supported("结论", "毛利率改善。", "page:page-b")],
			}),
		).rejects.toThrow("forced section failure");
		expect(existsSync(join(root, "generated", "memo", first.memo_series_id, "v2"))).toBe(false);
		expect(listPeMemoHistory(root).versions).toHaveLength(1);
	});
});
