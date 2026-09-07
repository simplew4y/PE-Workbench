import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { sourceId } from "../src/source.ts";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peResearchNoteSaveTool } from "../src/tools/research-note-save.ts";
import { type ResearchNotePresentationMode, savePeResearchNote } from "../src/tools/research-note-storage.ts";
import { createTextDocumentProject } from "./document-fixture.ts";

const temporaryDirectories: string[] = [];
const evidenceA = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 1, lineEnd: 1 } });
const evidenceB = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 2, lineEnd: 2 } });
const evidenceC = sourceId({ docId: "doc-1", location: { kind: "text", lineStart: 3, lineEnd: 3 } });

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createResearchNoteFixture(datasetId = "dataset-1"): string {
	const root = createTextDocumentProject("经营数据.txt", datasetId);
	temporaryDirectories.push(root);
	return root;
}

function completeHtml(body: string): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body { color: #123; }</style></head><body>${body}</body></html>`;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE Research Note tool", () => {
	it("registers the tool prompt and loads package Skills", async () => {
		expect(peResearchNoteSaveTool.name).toBe("pe_research_note_save");
		expect(buildPeSystemPrompt("/workspace")).not.toContain("- pe_research_note_save:");

		for (const name of ["pe_pdf_search", "pe_pdf_read", "pe_workbook_inspect", "pe_excel_range", "pe_source_detail"])
			expect(buildPeSystemPrompt("/workspace")).toContain(`- ${name}:`);

		const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
		const skill = readFileSync(join(packageDirectory, "skills", "pe-research-note", "SKILL.md"), "utf8");
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
		expect(result.skills.map((skill) => skill.name)).toEqual([
			"pe-generative-ui",
			"pe-memo",
			"pe-research-note",
			"pe-valuation-model-explainer",
		]);
		expect(result.skills.find((skill) => skill.name === "pe-research-note")?.description).toContain("Research Note");
		expect(result.skills.find((skill) => skill.name === "pe-valuation-model-explainer")?.description).toContain(
			"估值模型",
		);
	});

	it("saves all presentation modes as exact, independent HTML assets", async () => {
		const root = createResearchNoteFixture();
		const documents: Array<[ResearchNotePresentationMode, string]> = [
			["text", completeHtml("<article>文字分析</article>")],
			["metrics", completeHtml("<dl><dt>收入</dt><dd>120 百万元</dd></dl>")],
			["table", completeHtml("<table><tr><td>2025</td><td>120</td></tr></table>")],
			[
				"chart",
				`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>svg{max-width:100%}</style></head>
<body><svg viewBox="0 0 100 100"><rect x="10" y="20" width="20" height="70"></rect></svg><table><tr><td>收入</td><td>120</td></tr></table><script>document.querySelector("svg").dataset.ready="true";</script></body></html>
`,
			],
		];
		const ids = new Set<string>();
		for (const [mode, html] of documents) {
			const result = await savePeResearchNote(root, {
				title: "收入研究",
				summary: `${mode} 摘要`,
				presentationMode: mode,
				contentHtml: html,
				evidenceIds: [],
			});
			ids.add(result.research_note_id);
			expect(result).toMatchObject({
				dataset_id: "dataset-1",
				title: "收入研究",
				presentation_mode: mode,
				resolved_evidence_ids: [],
				unresolved_evidence_ids: [],
				message: "Research Note created successfully.",
			});
			expect(result.research_note_html_path).toMatch(/^generated\/research-notes\/rn_[a-f0-9]{24}\.html$/u);
			expect(readFileSync(join(root, result.research_note_html_path), "utf8")).toBe(html);
		}

		expect(ids.size).toBe(4);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		expect(database.prepare("SELECT count(*) AS count FROM research_notes").get()).toMatchObject({ count: 4 });
		expect(
			database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_node%'").all(),
		).toEqual([]);
		database.close();
	});

	it("registers valid citations and returns unresolved evidence without blocking the save", async () => {
		const root = createResearchNoteFixture();
		const result = await savePeResearchNote(root, {
			title: "证据登记",
			summary: "核验证据解析结果。",
			presentationMode: "metrics",
			contentHtml: completeHtml("<p>收入为120百万元。</p>"),
			evidenceIds: [evidenceA, evidenceB, evidenceC, "source:invalid", "invalid-evidence"],
		});

		expect(result.resolved_evidence_ids).toEqual([evidenceA, evidenceB, evidenceC]);
		expect(result.unresolved_evidence_ids).toEqual(["source:invalid", "invalid-evidence"]);
		expect(existsSync(join(root, result.research_note_html_path))).toBe(true);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		const evidence = database
			.prepare(
				"SELECT evidence_id, resolved, citation FROM research_note_evidence WHERE research_note_id=? ORDER BY evidence_id",
			)
			.all(result.research_note_id);
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ evidence_id: evidenceA, resolved: 1, citation: "经营数据.txt:1-1" }),
				expect.objectContaining({ evidence_id: evidenceB, resolved: 1, citation: "经营数据.txt:2-2" }),
				expect.objectContaining({ evidence_id: evidenceC, resolved: 1, citation: "经营数据.txt:3-3" }),
				expect.objectContaining({ evidence_id: "source:invalid", resolved: 0, citation: null }),
			]),
		);
		database.close();
	});

	it("rejects invalid workspaces, dataset mismatches, and symlink escapes", async () => {
		const missingRoot = join(temporaryDirectory("pe-boot-missing-parent-"), "missing");
		await expect(
			savePeResearchNote(missingRoot, {
				title: "缺失目录",
				summary: "缺失目录",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
			}),
		).rejects.toThrow("PE project workspace does not exist");

		const root = createResearchNoteFixture();
		await expect(
			savePeResearchNote(root, {
				title: "错误数据集",
				summary: "错误数据集",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
				datasetId: "another-dataset",
			}),
		).rejects.toThrow("does not match the current project dataset");

		const escapedRoot = createResearchNoteFixture();
		const outside = temporaryDirectory("pe-boot-research-note-outside-");
		symlinkSync(outside, join(escapedRoot, "generated"), "dir");
		await expect(
			savePeResearchNote(escapedRoot, {
				title: "越界",
				summary: "越界",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
			}),
		).rejects.toThrow("generated resolves outside");
		expect(readdirSync(outside)).toEqual([]);
	});

	it("rolls back metadata and removes the artifact when database persistence fails", async () => {
		const root = createResearchNoteFixture();
		const baseline = await savePeResearchNote(root, {
			title: "基准笔记",
			summary: "用于初始化表。",
			presentationMode: "text",
			contentHtml: completeHtml("<p>基准</p>"),
			evidenceIds: [],
		});
		const notesDirectory = join(root, "generated", "research-notes");
		const filesBeforeFailure = readdirSync(notesDirectory);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"));
		database.exec(`
			CREATE TRIGGER reject_research_note_evidence
			BEFORE INSERT ON research_note_evidence
			WHEN NEW.evidence_id = 'chunk:forced-failure'
			BEGIN
				SELECT RAISE(ABORT, 'forced evidence failure');
			END;
		`);
		database.close();

		await expect(
			savePeResearchNote(root, {
				title: "失败笔记",
				summary: "应完整回滚。",
				presentationMode: "table",
				contentHtml: completeHtml("<table><tr><td>失败</td></tr></table>"),
				evidenceIds: ["chunk:forced-failure"],
			}),
		).rejects.toThrow("forced evidence failure");
		expect(readdirSync(notesDirectory)).toEqual(filesBeforeFailure);
		expect(existsSync(join(root, baseline.research_note_html_path))).toBe(true);

		const inspection = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		expect(inspection.prepare("SELECT title FROM research_notes ORDER BY created_at").all()).toEqual([
			{ title: "基准笔记" },
		]);
		inspection.close();
	});

	it("rolls back metadata and leaves no artifact when the file write fails", async () => {
		const root = createResearchNoteFixture();
		const originalWriteFileSync = fs.writeFileSync;
		const failingWriteFileSync: typeof fs.writeFileSync = () => {
			throw new Error("forced file write failure");
		};
		Object.defineProperty(fs, "writeFileSync", { configurable: true, value: failingWriteFileSync });
		syncBuiltinESMExports();
		try {
			await expect(
				savePeResearchNote(root, {
					title: "写入失败",
					summary: "文件失败时回滚。",
					presentationMode: "text",
					contentHtml: completeHtml("<p>不会落盘</p>"),
					evidenceIds: [],
				}),
			).rejects.toThrow("forced file write failure");
		} finally {
			Object.defineProperty(fs, "writeFileSync", { configurable: true, value: originalWriteFileSync });
			syncBuiltinESMExports();
		}

		expect(readdirSync(join(root, "generated", "research-notes"))).toEqual([]);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		expect(database.prepare("SELECT count(*) AS count FROM research_notes").get()).toMatchObject({ count: 0 });
		database.close();
	});

	it("requires complete HTML and enforces the content size limit", async () => {
		const root = createResearchNoteFixture();
		await expect(
			savePeResearchNote(root, {
				title: "不完整",
				summary: "不完整",
				presentationMode: "text",
				contentHtml: "<p>fragment</p>",
				evidenceIds: [],
			}),
		).rejects.toThrow("complete HTML document");
		await expect(
			savePeResearchNote(root, {
				title: "过长",
				summary: "过长",
				presentationMode: "text",
				contentHtml: `<html><body>${"x".repeat(50_000)}</body></html>`,
				evidenceIds: [],
			}),
		).rejects.toThrow("must not exceed 50000 characters");
	});
});
