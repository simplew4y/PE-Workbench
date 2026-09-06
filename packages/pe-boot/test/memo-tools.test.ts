import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerPeDocuments } from "../src/documents.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { sourceId } from "../src/source.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peDatasetMemoTool } from "../src/tools/dataset-memo.ts";
import { peHistoryCompareTool } from "../src/tools/history-compare.ts";
import { comparePeMemoVersions, getPeMemoVersion, listPeMemoHistory, savePeMemo } from "../src/tools/memo-storage.ts";
import { savePeResearchNote } from "../src/tools/research-note-storage.ts";
import { createTextDocumentProject } from "./document-fixture.ts";

const temporaryDirectories: string[] = [];
const evidenceA = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 1, lineEnd: 1 } });
const evidenceB = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 2, lineEnd: 2 } });
const evidenceC = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 3, lineEnd: 3 } });

function createMemoFixture(datasetId = "dataset-1"): string {
	const root = createTextDocumentProject("访谈.txt", datasetId);
	temporaryDirectories.push(root);
	return root;
}

function supported(section: string, text: string, evidenceId: string) {
	return { section, text, status: "supported" as const, evidenceIds: [evidenceId] };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE Memo tools", () => {
	it("rejects cached PDF page evidence after the managed original changes", async () => {
		const root = createMemoFixture();
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			UPDATE documents SET file_type='pdf' WHERE doc_id='doc-1';
			INSERT INTO pdf_pages VALUES ('page-1', 'doc-1', 1, '收入增长20%。', 'p.1', 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0);
		`);
		database.close();
		const evidenceId = "page:page-1";
		const valid = await savePeMemo(root, {
			operation: "create",
			topic: "已核验PDF",
			claims: [supported("结论", "收入增长20%。", evidenceId)],
		});
		expect(valid.citation_gate).toMatchObject({ passed: true, valid_evidence_ids: [evidenceId] });
		expect(getPeMemoVersion(root, valid.memo_version_id).document_versions).toEqual([
			expect.objectContaining({ doc_id: "doc-1", version_no: 1 }),
		]);
		const rebuilding = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		rebuilding.exec("UPDATE documents SET status='queued'; DELETE FROM pdf_pages;");
		rebuilding.close();
		await expect(resolvePeEvidenceSource(root, evidenceId)).rejects.toMatchObject({ status: 404 });
		const locationId = sourceId({ docId: "doc-1", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		await expect(resolvePeEvidenceSource(root, locationId)).rejects.toMatchObject({ status: 409 });
		const restored = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		const columns = new Set(
			restored
				.prepare("PRAGMA table_info(documents)")
				.all()
				.map((column) => column.name),
		);
		if (!columns.has("registration_kind")) restored.exec("ALTER TABLE documents ADD COLUMN registration_kind TEXT");
		if (!columns.has("page_count")) restored.exec("ALTER TABLE documents ADD COLUMN page_count INTEGER");
		restored.exec("UPDATE documents SET registration_kind='catalog', status='failed', page_count=1;");
		await expect(resolvePeEvidenceSource(root, locationId)).rejects.toMatchObject({ status: 409 });
		await expect(
			resolvePeEvidenceSource(
				root,
				sourceId({ docId: "doc-1", location: { kind: "pdf", pageStart: 2, pageEnd: 2 } }),
			),
		).rejects.toMatchObject({ status: 404 });
		restored.exec(
			"UPDATE documents SET status='completed'; INSERT INTO pdf_pages VALUES ('page-1', 'doc-1', 1, '收入增长20%。', 'p.1', 'body', '{}', 'passed', '{}', 595, 842, 0, '[]', 0, 0, 0);",
		);
		restored.close();
		writeFileSync(join(root, "raw", "访谈.txt"), "原件已被改变");
		const invalid = await savePeMemo(root, {
			operation: "create",
			topic: "失效PDF",
			claims: [supported("结论", "收入增长20%。", evidenceId)],
		});
		expect(invalid.citation_gate).toMatchObject({ passed: false, invalid_evidence_ids: [evidenceId] });
		const note = await savePeResearchNote(root, {
			title: "失效PDF",
			summary: "引用核验",
			presentationMode: "text",
			contentHtml: "<html><body>收入增长20%。</body></html>",
			evidenceIds: [evidenceId],
		});
		expect(note.unresolved_evidence_ids).toEqual([evidenceId]);
	});

	it("records the referenced original version after a newer upload", async () => {
		const root = createMemoFixture();
		registerPeDocuments(root, "dataset-1", [{ name: "访谈.txt", bytes: Buffer.from("新版本收入增长30%。") }]);
		const result = await savePeMemo(root, {
			operation: "create",
			topic: "历史版本",
			claims: [supported("结论", "原版本收入增长20%。", evidenceA)],
		});
		expect(result.citation_gate).toMatchObject({ passed: true });
		expect(getPeMemoVersion(root, result.memo_version_id).document_versions).toEqual([
			expect.objectContaining({ doc_id: "doc-1", version_no: 1 }),
		]);
	});
	it("exposes Memo tools and loads the package Skill", () => {
		expect(peDatasetMemoTool.name).toBe("pe_dataset_memo");
		expect(peHistoryCompareTool.name).toBe("pe_history_compare");
		const prompt = buildPeSystemPrompt("/workspace");
		expect(prompt).not.toContain("- pe_dataset_memo:");
		expect(prompt).not.toContain("- pe_history_compare:");
		expect(prompt).toContain("pe_document_open");
		expect(prompt).toContain("pe_source_detail");

		for (const name of ["pe_pdf_search", "pe_pdf_read", "pe_workbook_inspect", "pe_excel_range", "pe_source_detail"])
			expect(buildPeSystemPrompt("/workspace")).toContain(`- ${name}:`);

		const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
		const skill = readFileSync(join(packageDirectory, "skills", "pe-memo", "SKILL.md"), "utf8");
		for (const keyword of [
			"pe_pdf_search",
			"pe_pdf_read",
			"pe_workbook_inspect",
			"pe_excel_range",
			"`page:`",
			"`source:`",
			"`cell:`",
			"`fact:`",
		])
			expect(skill).toContain(keyword);
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
			expect.objectContaining({ name: "valuation-model-explainer" }),
		]);
	});

	it("creates Markdown, safe HTML, and PDF, then downgrades invalid citations", async () => {
		const root = createMemoFixture();
		const result = await savePeMemo(root, {
			operation: "create",
			topic: "收入与盈利",
			title: "收入与盈利 Memo",
			claims: [
				supported("核心结论", "收入增长20%。", evidenceA),
				supported("风险", "<script>alert('x')</script> 需要核验。", "source:invalid"),
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
				invalid_evidence_ids: ["source:invalid"],
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
		expect(markdown).toContain("访谈.txt:1-1");
		expect(markdown).toContain("内容：收入增长20%。");
		expect(markdown).not.toContain(evidenceA);
		expect(markdown).toContain("待复核");
		expect(html).toContain("访谈.txt:1-1");
		expect(html).toContain("收入增长20%。");
		expect(html).not.toContain(evidenceA);
		expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(citationGate.claims[0]).toMatchObject({
			claim_id: "claim-1",
			text: "收入增长20%。",
			evidence_ids: [evidenceA],
		});
		expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		expect(pdf.byteLength).toBeGreaterThan(5_000);
		expect(pdf.toString("latin1").match(/\/Type \/Page\b/gu)).toHaveLength(1);

		const version = getPeMemoVersion(root, result.memo_version_id);
		expect(version.sections).toHaveLength(3);
		expect(version.sections[0]).toMatchObject({ evidence_ids: [evidenceA], needs_review: false });
		expect(version.markdown_path).toBe(result.memo_markdown_path);
		expect(version.pdf_path).toBe(result.memo_pdf_path);
	});

	it("returns the current version for duplicate create and requires explicit revise", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "收入增长20%。", evidenceA)],
		});
		const duplicate = await savePeMemo(root, {
			operation: "create",
			topic: "稳定主题",
			claims: [supported("结论", "另一版本。", evidenceB)],
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
				claims: [supported("结论", "修订。", evidenceB)],
			}),
		).rejects.toThrow("revision_of is required");
	});

	it("creates an immutable revision and compares section states", async () => {
		const root = createMemoFixture();
		const first = await savePeMemo(root, {
			operation: "create",
			topic: "版本测试",
			claims: [
				supported("保持", "收入增长20%。", evidenceA),
				{ section: "旧章节", text: "暂缺资料。", status: "not_covered", evidenceIds: [] },
				supported("变化", "毛利率改善。", evidenceB),
			],
		});
		const firstMarkdown = readFileSync(join(root, first.memo_markdown_path ?? ""), "utf8");
		const second = await savePeMemo(root, {
			operation: "revise",
			topic: "不应创建新主题",
			revisionOf: first.memo_version_id,
			claims: [
				supported("保持", "收入增长20%。", evidenceA),
				supported("变化", "毛利率显著改善。", evidenceB),
				supported("新增", "新增订单。", evidenceC),
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
			claims: [supported("结论", "收入增长20%。", evidenceA)],
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
				claims: [supported("结论", "毛利率改善。", evidenceB)],
			}),
		).rejects.toThrow("forced section failure");
		expect(existsSync(join(root, "generated", "memo", first.memo_series_id, "v2"))).toBe(false);
		expect(listPeMemoHistory(root).versions).toHaveLength(1);
	});
});
