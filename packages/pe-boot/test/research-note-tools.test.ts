import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildPeSystemPrompt } from "../src/system-prompt.ts";
import { peResearchNoteSaveTool } from "../src/tools/research-note-save.ts";
import { type ResearchNotePresentationMode, savePeResearchNote } from "../src/tools/research-note-storage.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createResearchNoteFixture(datasetId = "dataset-1"): string {
	const root = temporaryDirectory("pe-boot-research-note-");
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
		.run("doc-1", datasetId, "经营数据.pdf", "raw/经营数据.pdf", "pdf", "financial", "2026-08-01");
	database
		.prepare(
			"INSERT INTO chunks (chunk_id, dataset_id, doc_id, content, content_type, title_path, summary, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("chunk-a", datasetId, "doc-1", "收入增长20%。", "pdf_page", "经营表现", "收入增长", "经营数据.pdf p.2");
	database
		.prepare(
			"INSERT INTO chunk_locations (chunk_id, location_index, page_start, page_end, heading_path) VALUES (?, 0, ?, ?, ?)",
		)
		.run("chunk-a", 2, 2, "经营表现");
	database
		.prepare(
			"INSERT INTO metric_facts (fact_id, dataset_id, doc_id, metric_name, period, value_text, value_numeric, unit, sheet_name, cell_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("fact-a", datasetId, "doc-1", "收入", "2025", "120", 120, "百万元", "数据", "B2");
	database
		.prepare("INSERT INTO excel_cells (cell_id, dataset_id, doc_id, sheet_name, cell_ref) VALUES (?, ?, ?, ?, ?) ")
		.run("cell-a", datasetId, "doc-1", "数据", "C3");
	database.close();
	return root;
}

function completeHtml(body: string): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body { color: #123; }</style></head><body>${body}</body></html>`;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PE Research Note tool", () => {
	it("registers the tool prompt and loads pe-research-note", () => {
		expect(peResearchNoteSaveTool.name).toBe("pe_research_note_save");
		expect(buildPeSystemPrompt("/workspace")).toContain("- pe_research_note_save:");

		const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
		const result = loadSkillsFromDir({ dir: join(packageDirectory, "skills"), source: "test" });
		expect(result.diagnostics).toEqual([]);
		expect(result.skills.map((skill) => skill.name)).toEqual(["pe-memo", "pe-research-note"]);
		expect(result.skills[1]?.description).toContain("Research Note");
	});

	it("saves all presentation modes as exact, independent HTML assets", () => {
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
			const result = savePeResearchNote(root, {
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

	it("registers valid citations and returns unresolved evidence without blocking the save", () => {
		const root = createResearchNoteFixture();
		const result = savePeResearchNote(root, {
			title: "证据登记",
			summary: "核验证据解析结果。",
			presentationMode: "metrics",
			contentHtml: completeHtml("<p>收入为120百万元。</p>"),
			evidenceIds: ["chunk:chunk-a", "fact:fact-a", "cell:cell-a", "chunk:missing", "invalid-evidence"],
		});

		expect(result.resolved_evidence_ids).toEqual(["chunk:chunk-a", "fact:fact-a", "cell:cell-a"]);
		expect(result.unresolved_evidence_ids).toEqual(["chunk:missing", "invalid-evidence"]);
		expect(existsSync(join(root, result.research_note_html_path))).toBe(true);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		const evidence = database
			.prepare(
				"SELECT evidence_id, resolved, citation FROM research_note_evidence WHERE research_note_id=? ORDER BY evidence_id",
			)
			.all(result.research_note_id);
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ evidence_id: "chunk:chunk-a", resolved: 1, citation: "raw/经营数据.pdf p.2" }),
				expect.objectContaining({ evidence_id: "fact:fact-a", resolved: 1, citation: "raw/经营数据.pdf 数据!B2" }),
				expect.objectContaining({ evidence_id: "cell:cell-a", resolved: 1, citation: "raw/经营数据.pdf 数据!C3" }),
				expect.objectContaining({ evidence_id: "chunk:missing", resolved: 0, citation: null }),
			]),
		);
		database.close();
	});

	it("rejects invalid workspaces, dataset mismatches, and symlink escapes", () => {
		const missingRoot = join(temporaryDirectory("pe-boot-missing-parent-"), "missing");
		expect(() =>
			savePeResearchNote(missingRoot, {
				title: "缺失目录",
				summary: "缺失目录",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
			}),
		).toThrow("PE project workspace does not exist");

		const root = createResearchNoteFixture();
		expect(() =>
			savePeResearchNote(root, {
				title: "错误数据集",
				summary: "错误数据集",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
				datasetId: "another-dataset",
			}),
		).toThrow("does not match the current project dataset");

		const escapedRoot = createResearchNoteFixture();
		const outside = temporaryDirectory("pe-boot-research-note-outside-");
		symlinkSync(outside, join(escapedRoot, "generated"), "dir");
		expect(() =>
			savePeResearchNote(escapedRoot, {
				title: "越界",
				summary: "越界",
				presentationMode: "text",
				contentHtml: completeHtml("<p>内容</p>"),
				evidenceIds: [],
			}),
		).toThrow("generated resolves outside");
		expect(readdirSync(outside)).toEqual([]);
	});

	it("rolls back metadata and removes the artifact when database persistence fails", () => {
		const root = createResearchNoteFixture();
		const baseline = savePeResearchNote(root, {
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

		expect(() =>
			savePeResearchNote(root, {
				title: "失败笔记",
				summary: "应完整回滚。",
				presentationMode: "table",
				contentHtml: completeHtml("<table><tr><td>失败</td></tr></table>"),
				evidenceIds: ["chunk:forced-failure"],
			}),
		).toThrow("forced evidence failure");
		expect(readdirSync(notesDirectory)).toEqual(filesBeforeFailure);
		expect(existsSync(join(root, baseline.research_note_html_path))).toBe(true);

		const inspection = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		expect(inspection.prepare("SELECT title FROM research_notes ORDER BY created_at").all()).toEqual([
			{ title: "基准笔记" },
		]);
		inspection.close();
	});

	it("rolls back metadata and leaves no artifact when the file write fails", () => {
		const root = createResearchNoteFixture();
		const originalWriteFileSync = fs.writeFileSync;
		const failingWriteFileSync: typeof fs.writeFileSync = () => {
			throw new Error("forced file write failure");
		};
		Object.defineProperty(fs, "writeFileSync", { configurable: true, value: failingWriteFileSync });
		syncBuiltinESMExports();
		try {
			expect(() =>
				savePeResearchNote(root, {
					title: "写入失败",
					summary: "文件失败时回滚。",
					presentationMode: "text",
					contentHtml: completeHtml("<p>不会落盘</p>"),
					evidenceIds: [],
				}),
			).toThrow("forced file write failure");
		} finally {
			Object.defineProperty(fs, "writeFileSync", { configurable: true, value: originalWriteFileSync });
			syncBuiltinESMExports();
		}

		expect(readdirSync(join(root, "generated", "research-notes"))).toEqual([]);
		const database = new DatabaseSync(join(root, "meta", "collection.sqlite3"), { readOnly: true });
		expect(database.prepare("SELECT count(*) AS count FROM research_notes").get()).toMatchObject({ count: 0 });
		database.close();
	});

	it("requires complete HTML and enforces the content size limit", () => {
		const root = createResearchNoteFixture();
		expect(() =>
			savePeResearchNote(root, {
				title: "不完整",
				summary: "不完整",
				presentationMode: "text",
				contentHtml: "<p>fragment</p>",
				evidenceIds: [],
			}),
		).toThrow("complete HTML document");
		expect(() =>
			savePeResearchNote(root, {
				title: "过长",
				summary: "过长",
				presentationMode: "text",
				contentHtml: `<html><body>${"x".repeat(50_000)}</body></html>`,
				evidenceIds: [],
			}),
		).toThrow("must not exceed 50000 characters");
	});
});
