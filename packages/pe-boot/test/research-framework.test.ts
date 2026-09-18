import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import {
	createResearchDraft,
	getResearchFramework,
	listResearchContinuations,
	publishResearchDraft,
	restoreResearchVersion,
	updateResearchDraft,
} from "../src/research/framework.ts";
import type { FrameworkContent } from "../src/research/model.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import {
	cancelResearchJob,
	claimResearchJob,
	enqueueResearchJob,
	finishResearchJob,
	listResearchJobs,
	runNextResearchJob,
} from "../src/research/watch.ts";
import { sourceId } from "../src/source.ts";
import { peFrameworkTool } from "../src/tools/framework.ts";

const roots: string[] = [];
function project() {
	const cwd = mkdtempSync(join(tmpdir(), "pe-framework-test-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), {
		datasetId: "dataset_test",
		name: "Test",
	});
	return cwd;
}
const datasetId = "dataset_test";
const content: FrameworkContent = {
	title: "投资框架",
	objective: "验证盈利恢复",
	horizon: "未来四个季度",
	items: [
		{
			id: "margin",
			kind: "hypothesis",
			claim: "毛利率可能恢复",
			rationale: "用户假设，尚待验证",
			subject: "试点公司",
			verification: "季度毛利率改善",
			invalidation: "连续两季下滑",
			origin: "user",
			evidenceIds: [],
		},
	],
	coverageGaps: ["尚未提供财报"],
};
function publish(cwd: string, value = content, expected: string | null = null, key = "first") {
	const draft = createResearchDraft(cwd, datasetId, value, [], expected);
	return publishResearchDraft(cwd, datasetId, {
		draftId: draft.id,
		revision: draft.revision,
		expectedVersionId: expected,
		requestId: key,
	});
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("investment framework persistence", () => {
	it("publishes the version and continuation atomically and migrates the additive schema", () => {
		const cwd = project();
		withResearchDatabase(cwd, datasetId, (db) => {
			db.exec(
				"DROP TABLE research_continuations; UPDATE schema_metadata SET value='1' WHERE key='research_schema_version'",
			);
		});
		const candidate = createResearchDraft(cwd, datasetId, content, [], null);
		const input = {
			draftId: candidate.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "confirm",
			continuation: { sessionId: "session", toolCallId: "call" },
		};
		withResearchDatabase(cwd, datasetId, (db) =>
			db.exec(
				"CREATE TRIGGER fail_receipt BEFORE INSERT ON research_continuations BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END",
			),
		);
		expect(() => publishResearchDraft(cwd, datasetId, input)).toThrow("receipt unavailable");
		expect(getResearchFramework(cwd, datasetId).versions).toHaveLength(0);
		expect(getResearchFramework(cwd, datasetId).drafts[0].status).toBe("open");
		withResearchDatabase(cwd, datasetId, (db) => db.exec("DROP TRIGGER fail_receipt"));
		const version = publishResearchDraft(cwd, datasetId, input);
		expect(publishResearchDraft(cwd, datasetId, input)).toEqual(version);
		expect(listResearchContinuations(cwd, datasetId)).toEqual([
			{
				versionId: version.id,
				draftId: candidate.id,
				sessionId: "session",
				toolCallId: "call",
				status: "pending",
				error: null,
			},
		]);
	});
	it("agent proposals remain drafts until the user confirms; subsequent reads see confirmation", async () => {
		const cwd = project();
		const ctx = { cwd } as Parameters<typeof peFrameworkTool.execute>[4];
		const result = await peFrameworkTool.execute(
			"proposal",
			{ operation: "propose", content, docIds: [], expectedVersionId: null },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toMatchObject({ kind: "pe_framework_draft" });
		const state = getResearchFramework(cwd, datasetId);
		expect(state.currentVersionId).toBe(null);
		expect(state.drafts).toHaveLength(1);
		const candidate = state.drafts[0];
		const confirmed = publishResearchDraft(cwd, datasetId, {
			draftId: candidate.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "user-click",
		});
		const read = await peFrameworkTool.execute("read", { operation: "read" }, undefined, undefined, ctx);
		expect(read.details).toMatchObject({
			framework: { currentVersionId: confirmed.id },
		});
		await expect(
			peFrameworkTool.execute(
				"stale",
				{ operation: "propose", content, docIds: [], expectedVersionId: null },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("changed");
	});
	it("reads selected PDF and Excel versions, validates citations and detects changed preparation", () => {
		const cwd = project();
		withResearchDatabase(cwd, datasetId, (db) => {
			for (const [id, extension] of [
				["pdf", "pdf"],
				["excel", "xlsx"],
			]) {
				db.prepare(
					"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'completed','before','before')",
				).run(id, datasetId, `report.${extension}`, `report.${extension}`, id, extension);
			}
			db.exec(
				"INSERT INTO pdf_pages VALUES('page','pdf',1,'原始研报文本','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
			db.prepare(
				"INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,numeric_value,display_value) VALUES('cell',?,'excel','预测','B2',2,2,'number',42,'42')",
			).run(datasetId);
		});
		const job = enqueueResearchJob(cwd, datasetId, "分析", ["pdf", "excel"], "evidence", null);
		const pdfId = sourceId({
			docId: "pdf",
			location: { kind: "pdf", pageStart: 1, pageEnd: 1 },
		});
		const excelId = sourceId({
			docId: "excel",
			location: { kind: "excel", sheet: "预测", range: "B2" },
		});
		expect(readResearchInput(cwd, datasetId, job.input, { docId: "pdf", page: 1 })).toMatchObject({
			text: "原始研报文本",
			evidenceId: pdfId,
		});
		expect(
			readResearchInput(cwd, datasetId, job.input, {
				docId: "excel",
				sheet: "预测",
				range: "B2",
			}),
		).toMatchObject({ cells: [{ numeric_value: 42, evidence_id: excelId }] });
		const verified = {
			...content,
			items: [
				{
					...content.items[0],
					origin: "research" as const,
					evidenceIds: [pdfId, excelId],
				},
			],
		};
		const candidate = createResearchDraft(cwd, datasetId, verified, ["pdf", "excel"], null);
		expect(() => createResearchDraft(cwd, datasetId, verified, ["pdf"], null)).toThrow("outside");
		withResearchDatabase(cwd, datasetId, (db) =>
			db.exec("UPDATE documents SET updated_at='after' WHERE doc_id='pdf'"),
		);
		expect(() => readResearchInput(cwd, datasetId, job.input, { docId: "pdf", page: 1 })).toThrow("changed");
		expect(() =>
			publishResearchDraft(cwd, datasetId, {
				draftId: candidate.id,
				revision: 1,
				expectedVersionId: null,
				requestId: "changed",
			}),
		).toThrow("changed");
	});
	it("normalizes PDF tool page citations before saving while rejecting unselected or missing evidence", async () => {
		const cwd = project();
		withResearchDatabase(cwd, datasetId, (db) => {
			db.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('pdf',?,'report.pdf','report.pdf','pdf','pdf','completed','before','before')",
			).run(datasetId);
			db.exec(
				"INSERT INTO pdf_pages VALUES('page','pdf',1,'原始研报文本','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
		});
		const canonical = sourceId({
			docId: "pdf",
			location: { kind: "pdf", pageStart: 1, pageEnd: 1 },
		});
		const verified: FrameworkContent = {
			...content,
			items: [
				{
					...content.items[0],
					origin: "research",
					evidenceIds: ["page:page", canonical],
				},
			],
		};
		const ctx = { cwd } as Parameters<typeof peFrameworkTool.execute>[4];
		await peFrameworkTool.execute(
			"pdf-proposal",
			{
				operation: "propose",
				content: verified,
				docIds: ["pdf"],
				expectedVersionId: null,
			},
			undefined,
			undefined,
			ctx,
		);
		const state = getResearchFramework(cwd, datasetId);
		expect(state.drafts[0].content.items[0].evidenceIds).toEqual([canonical]);
		expect(state.currentVersionId).toBeNull();
		await expect(
			peFrameworkTool.execute(
				"unselected",
				{
					operation: "propose",
					content: verified,
					docIds: [],
					expectedVersionId: null,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("outside");
		await expect(
			peFrameworkTool.execute(
				"missing",
				{
					operation: "propose",
					content: {
						...verified,
						items: [{ ...verified.items[0], evidenceIds: ["page:missing"] }],
					},
					docIds: ["pdf"],
					expectedVersionId: null,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow();
		expect(getResearchFramework(cwd, datasetId).drafts).toHaveLength(1);
	});
	it("creates additive tables without changing parser schema or existing research notes", () => {
		const cwd = project();
		withResearchDatabase(cwd, datasetId, (database) => {
			database.exec(
				"CREATE TABLE research_saved_notes(note_id TEXT); INSERT INTO research_saved_notes VALUES('existing')",
			);
		});
		getResearchFramework(cwd, datasetId);
		withResearchDatabase(cwd, datasetId, (database) => {
			expect(database.prepare("SELECT * FROM research_saved_notes").all()).toEqual([{ note_id: "existing" }]);
			expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		});
	});
	it("preserves a competing draft and retries publication idempotently", () => {
		const cwd = project();
		const a = createResearchDraft(cwd, datasetId, content, [], null);
		const b = createResearchDraft(cwd, datasetId, content, [], null);
		const request = {
			draftId: a.id,
			revision: 1,
			expectedVersionId: null,
			requestId: "publish",
		};
		const first = publishResearchDraft(cwd, datasetId, request);
		expect(publishResearchDraft(cwd, datasetId, request)).toEqual(first);
		expect(() => publishResearchDraft(cwd, datasetId, { ...request, draftId: b.id })).toThrow("different input");
		expect(() =>
			publishResearchDraft(cwd, datasetId, {
				...request,
				draftId: b.id,
				requestId: "other",
			}),
		).toThrow("preserved");
		expect(getResearchFramework(cwd, datasetId).drafts.find((entry) => entry.id === b.id)?.status).toBe("open");
		withResearchDatabase(cwd, datasetId, (db) => {
			expect(() => db.prepare("UPDATE research_versions SET content_json='{}'").run()).toThrow("immutable");
			expect(() => db.prepare("DELETE FROM research_versions").run()).toThrow("immutable");
		});
	});
	it("rejects stale saves, invalid evidence, malformed and cross-project inputs", () => {
		const cwd = project();
		const value = createResearchDraft(cwd, datasetId, content, [], null);
		updateResearchDraft(cwd, datasetId, value.id, 1, {
			...content,
			title: "Edited",
		});
		expect(() => updateResearchDraft(cwd, datasetId, value.id, 1, content)).toThrow("changed");
		expect(() => createResearchDraft(cwd, "other", content, [], null)).toThrow("does not match");
		expect(() =>
			createResearchDraft(cwd, datasetId, { ...content, items: [content.items[0], content.items[0]] }, [], null),
		).toThrow("unique");
		expect(() =>
			createResearchDraft(
				cwd,
				datasetId,
				{ ...content, items: [{ ...content.items[0], origin: "research" }] },
				[],
				null,
			),
		).toThrow("require evidence");
		expect(() => createResearchDraft(cwd, datasetId, content, ["missing"], null)).toThrow("not ready");
		expect(() =>
			readResearchInput(cwd, datasetId, { objective: "test", inputs: [], asOf: "now" }, { docId: "outside" }),
		).toThrow("outside");
	});
	it("accepts only selected items and restores old content as a new version", () => {
		const cwd = project();
		const base = {
			...content,
			items: [...content.items, { ...content.items[0], id: "demand", claim: "需求待验证" }],
		};
		const v1 = publish(cwd, base);
		const changed = {
			...base,
			title: "New title",
			items: base.items.map((item) => ({
				...item,
				claim: `${item.claim}已修改`,
			})),
		};
		const proposed = createResearchDraft(cwd, datasetId, changed, [], v1.id);
		const v2 = publishResearchDraft(cwd, datasetId, {
			draftId: proposed.id,
			revision: 1,
			expectedVersionId: v1.id,
			requestId: "partial",
			selectedItemIds: ["margin"],
		});
		expect(v2.content.title).toBe(base.title);
		expect(v2.content.items.find((item) => item.id === "demand")?.claim).toBe("需求待验证");
		expect(v2.content.items.find((item) => item.id === "margin")?.claim).toContain("已修改");
		expect(
			getResearchFramework(cwd, datasetId).drafts.some(
				(entry) => entry.status === "open" && entry.baseVersionId === v1.id,
			),
		).toBe(true);
		const restored = restoreResearchVersion(cwd, datasetId, v1.id, v2.id);
		const v3 = publishResearchDraft(cwd, datasetId, {
			draftId: restored.id,
			revision: 1,
			expectedVersionId: v2.id,
			requestId: "restore",
		});
		expect(v3.version).toBe(3);
		expect(v3.content).toEqual(v1.content);
		expect(v3.parentVersionId).toBe(v2.id);
	});
});

describe("durable research jobs", () => {
	it("deduplicates requests, reclaims expired leases, rejects late and cancelled results", () => {
		const cwd = project();
		const queued = enqueueResearchJob(cwd, datasetId, "验证假设", [], "job", null);
		expect(enqueueResearchJob(cwd, datasetId, "验证假设", [], "job", null).id).toBe(queued.id);
		expect(() => enqueueResearchJob(cwd, datasetId, "other", [], "job", null)).toThrow("different");
		const start = queued.nextRunAt;
		const a = claimResearchJob(cwd, datasetId, start)!;
		expect(claimResearchJob(cwd, datasetId, start + 1)).toBe(null);
		const b = claimResearchJob(cwd, datasetId, start + 60_000)!;
		expect(b.attempt).toBe(2);
		expect(() => finishResearchJob(cwd, datasetId, a, content, start + 60_001)).toThrow("expired");
		cancelResearchJob(cwd, datasetId, b.id);
		expect(() => finishResearchJob(cwd, datasetId, b, content, start + 60_002)).toThrow("cancelled");
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});
	it("retains the original version basis when a newer version is published during research", () => {
		const cwd = project();
		const v1 = publish(cwd);
		const queued = enqueueResearchJob(cwd, datasetId, "review", [], "review", v1.id);
		const claim = claimResearchJob(cwd, datasetId, queued.nextRunAt)!;
		const v2 = publish(cwd, { ...content, title: "second" }, v1.id, "second");
		const draftId = finishResearchJob(cwd, datasetId, claim, content, queued.nextRunAt + 10);
		const state = getResearchFramework(cwd, datasetId);
		expect(state.currentVersionId).toBe(v2.id);
		expect(state.drafts.find((entry) => entry.id === draftId)?.baseVersionId).toBe(v1.id);
		expect(() =>
			publishResearchDraft(cwd, datasetId, {
				draftId,
				revision: 1,
				expectedVersionId: v2.id,
				requestId: "late",
			}),
		).toThrow("preserved");
	});
	it("runs a replaceable engine without holding a transaction and persists failures for retry", async () => {
		const cwd = project();
		enqueueResearchJob(cwd, datasetId, "generate", [], "first", null);
		await runNextResearchJob(
			cwd,
			datasetId,
			{
				async generate() {
					expect(getResearchFramework(cwd, datasetId).currentVersionId).toBe(null);
					return content;
				},
			},
			new AbortController().signal,
		);
		expect(listResearchJobs(cwd, datasetId)[0].status).toBe("succeeded");
		enqueueResearchJob(cwd, datasetId, "fail", [], "second", null);
		await runNextResearchJob(
			cwd,
			datasetId,
			{
				async generate() {
					throw new Error("Provider unavailable");
				},
			},
			new AbortController().signal,
		);
		expect(listResearchJobs(cwd, datasetId).find((entry) => entry.input.objective === "fail")).toMatchObject({
			status: "retry_wait",
			attempt: 1,
			error: "Provider unavailable",
		});
	});
});
