import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peDatasetMemoTool } from "../src/tools/dataset-memo.ts";
import { peHistoryCompareTool } from "../src/tools/history-compare.ts";
import { comparePeMemoVersions, getPeMemoVersion, listPeMemoHistory, savePeMemo } from "../src/tools/memo-storage.ts";

const temporaryDirectories: string[] = [];

function createMemoFixture(datasetId = "dataset-1"): string {
	const root = mkdtempSync(join(tmpdir(), "pe-boot-memo-"));
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
		CREATE TABLE metric_facts (
			fact_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			period TEXT,
			value_text TEXT,
			value_numeric REAL,
			unit TEXT,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL
		);
		CREATE TABLE excel_cells (
			cell_id TEXT PRIMARY KEY,
			dataset_id TEXT NOT NULL,
			doc_id TEXT NOT NULL,
			sheet_name TEXT NOT NULL,
			cell_ref TEXT NOT NULL
		);
	`);
	database
		.prepare(
			"INSERT INTO documents (doc_id, dataset_id, original_filename, source_relpath, file_type, doc_type, document_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run("doc-1", datasetId, "访谈.pdf", "raw/访谈.pdf", "pdf", "expert_interview", "2026-08-01");
	const insertChunk = database.prepare(
		"INSERT INTO chunks (chunk_id, dataset_id, doc_id, content, content_type, title_path, summary, source_ref) VALUES (?, ?, 'doc-1', ?, 'pdf_page', ?, ?, ?)",
	);
	insertChunk.run("chunk-a", datasetId, "收入增长20%。", "访谈 > page 2", "收入增长", "访谈.pdf p.2");
	insertChunk.run("chunk-b", datasetId, "毛利率改善。", "访谈 > page 3", "毛利率改善", "访谈.pdf p.3");
	insertChunk.run("chunk-c", datasetId, "新增订单。", "访谈 > page 4", "新增订单", "访谈.pdf p.4");
	const insertLocation = database.prepare(
		"INSERT INTO chunk_locations (chunk_id, location_index, page_start, page_end, heading_path) VALUES (?, 0, ?, ?, ?)",
	);
	insertLocation.run("chunk-a", 2, 2, "访谈 > page 2");
	insertLocation.run("chunk-b", 3, 3, "访谈 > page 3");
	insertLocation.run("chunk-c", 4, 4, "访谈 > page 4");
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
		expect(prompt).toContain("- pe_dataset_search:");
		expect(prompt).toContain("- pe_source_detail:");

		const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
		const result = loadSkillsFromDir({ dir: join(packageDirectory, "skills"), source: "test" });
		expect(result.diagnostics).toEqual([]);
		expect(result.skills).toEqual([
				expect.objectContaining({
					name: "pe-memo",
					description: expect.stringContaining("persistent, evidence-backed PE Memo"),
				}),
			expect.objectContaining({ name: "pe-research-note" }),
		]);
	});

	it("creates Markdown, safe HTML, and PDF, then downgrades invalid citations", async () => {
		const root = createMemoFixture();
		const result = await savePeMemo(root, {
			operation: "create",
			topic: "收入与盈利",
			title: "收入与盈利 Memo",
			claims: [
				supported("核心结论", "收入增长20%。", "chunk:chunk-a"),
				supported("风险", "<script>alert('x')</script> 需要核验。", "chunk:missing"),
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
				invalid_evidence_ids: ["chunk:missing"],
			},
		});
		expect(result.memo_markdown_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.md$/u);
		expect(result.memo_html_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.html$/u);
		expect(result.memo_pdf_path).toMatch(/^generated\/memo\/ms_[a-f0-9]+\/v1\/memo\.pdf$/u);
		const markdown = readFileSync(join(root, result.memo_markdown_path ?? ""), "utf8");
		const html = readFileSync(join(root, result.memo_html_path ?? ""), "utf8");
		const pdf = readFileSync(join(root, result.memo_pdf_path ?? ""));
		const citationGate = JSON.parse(
			readFileSync(join(root, result.citation_gate_audit_path ?? ""), "utf8"),
		) as { claims: Array<{ claim_id: string; text: string; evidence_ids: string[] }> };
		expect(markdown).toContain("访谈.pdf p.2");
		expect(markdown).toContain("内容：收入增长20%。");
		expect(markdown).not.toContain("chunk:chunk-a");
		expect(markdown).toContain("待复核");
		expect(html).toContain("访谈.pdf p.2");
		expect(html).toContain("收入增长20%。");
		expect(html).not.toContain("chunk:chunk-a");
		expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(citationGate.claims[0]).toMatchObject({
			claim_id: "claim-1",
			text: "收入增长20%。",
			evidence_ids: ["chunk:chunk-a"],
		});
		expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		expect(pdf.byteLength).toBeGreaterThan(5_000);
		expect(pdf.toString("latin1").match(/\/Type \/Page\b/gu)).toHaveLength(1);

		const version = getPeMemoVersion(root, result.memo_version_id);
		expect(version.sections).toHaveLength(3);
		expect(version.sections[0]).toMatchObject({ evidence_ids: ["chunk:chunk-a"], needs_review: false });
		expect(version.markdown_path).toBe(result.memo_markdown_path);
		expect(version.pdf_path).toBe(result.memo_pdf_path);
	});

	it("returns the current version for duplicate create and requires explicit revise", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "收入增长20%。", "chunk:chunk-a")],
		});
		const duplicate = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "另一版本。", "chunk:chunk-b")],
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
				claims: [supported("结论", "修订。", "chunk:chunk-b")],
			}),
		).rejects.toThrow("revision_of is required");
	});

	it("creates an immutable revision and compares section states", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "版本测试",
			claims: [
				supported("保持", "收入增长20%。", "chunk:chunk-a"),
				{ section: "旧章节", text: "暂缺资料。", status: "not_covered", evidenceIds: [] },
				supported("变化", "毛利率改善。", "chunk:chunk-b"),
			],
		});
		const firstMarkdown = readFileSync(join(root, first.memo_markdown_path ?? ""), "utf8");
		const second = await savePeMemo(root, {
			operation: "revise",
			topic: "不应创建新主题",
			revisionOf: first.memo_version_id,
			claims: [
				supported("保持", "收入增长20%。", "chunk:chunk-a"),
				supported("变化", "毛利率显著改善。", "chunk:chunk-b"),
				supported("新增", "新增订单。", "chunk:chunk-c"),
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
			claims: [supported("结论", "收入增长20%。", "chunk:chunk-a")],
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
				claims: [supported("结论", "毛利率改善。", "chunk:chunk-b")],
			}),
		).rejects.toThrow("forced section failure");
		expect(existsSync(join(root, "generated", "memo", first.memo_series_id, "v2"))).toBe(false);
		expect(listPeMemoHistory(root).versions).toHaveLength(1);
	});
});
