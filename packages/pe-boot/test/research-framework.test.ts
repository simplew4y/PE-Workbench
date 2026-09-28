import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { collectFrameworkEvidenceIds, type FrameworkContent } from "../src/research/model.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { renderInvestmentFrameworkMarkdown } from "../src/research/report.ts";
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
import { frameworkFixture, withFrameworkItems } from "./fixtures/framework.ts";

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
const content = frameworkFixture({
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
});
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
	it("retains change records for retired judgments while rejecting invented and cross-project history", () => {
		const cwd = project();
		const first = publish(cwd);
		const retired = withFrameworkItems(content, []);
		retired.sections.evidenceAndChanges.changes = [
			{
				judgmentIds: ["margin"],
				before: "毛利率可能恢复",
				after: "移除该判断",
				reason: "不再作为本次研究的投资依据",
				evidenceIds: [],
			},
		];
		const deletion = createResearchDraft(cwd, datasetId, retired, [], first.id);
		const revised = updateResearchDraft(cwd, datasetId, deletion.id, 1, { ...retired, title: "删除判断后的框架" });
		const second = publishResearchDraft(cwd, datasetId, {
			draftId: revised.id,
			revision: revised.revision,
			expectedVersionId: first.id,
			requestId: "retired",
		});
		expect(second.content).toEqual(revised.content);
		const third = publish(cwd, { ...retired, title: "保留先前版本变化" }, second.id, "retained-history");
		expect(restoreResearchVersion(cwd, datasetId, second.id, third.id).content).toEqual(second.content);
		withResearchDatabase(cwd, datasetId, (db) => {
			db.prepare("INSERT INTO research_frameworks VALUES('foreign-project',NULL)").run();
			const foreign = withFrameworkItems(content, [
				{ ...content.sections.investmentJudgments.items[0], id: "foreign-judgment" },
			]);
			db.prepare(
				"INSERT INTO research_versions VALUES('foreign-version','foreign-project',1,NULL,?,'[]','before','foreign-request','{}')",
			).run(JSON.stringify(foreign));
		});
		for (const id of ["invented", "foreign-judgment"]) {
			const invalid = structuredClone(retired);
			invalid.sections.evidenceAndChanges.changes[0].judgmentIds = [id];
			expect(() => createResearchDraft(cwd, datasetId, invalid, [], third.id)).toThrow("unknown judgment");
		}
		expect(getResearchFramework(cwd, datasetId).currentVersionId).toBe(third.id);
	});
	it("rejects every incomplete document and preserves every section when saving and publishing", () => {
		const cwd = project();
		for (const section of Object.keys(content.sections)) {
			const incomplete = structuredClone(content) as { sections: Record<string, unknown> };
			delete incomplete.sections[section];
			expect(() => createResearchDraft(cwd, datasetId, incomplete, [], null)).toThrow("seven sections");
		}
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
		const candidate = createResearchDraft(cwd, datasetId, content, [], null);
		expect(getResearchFramework(cwd, datasetId).drafts[0].content).toEqual(content);
		const updated = structuredClone(content);
		updated.sections.researchSetup.preferences = "保守估值";
		updated.sections.currentAssessment.summary = "需要更多证据才能调整判断";
		updated.sections.businessModel.drivers[0].mechanism = "订单交付和回款决定经营现金流";
		updated.sections.investmentJudgments.items[0].confidence.reason = "资料仍不足";
		updated.sections.valuation.forecastComparisons[0].ownForecast = "待最新财报";
		updated.sections.monitoring.rules[0].frequency = "每月";
		updated.sections.evidenceAndChanges.openQuestions[0].evidenceNeeded = "季度订单与回款资料";
		const saved = updateResearchDraft(cwd, datasetId, candidate.id, 1, updated);
		expect(saved.content).toEqual(updated);
		const confirmed = publishResearchDraft(cwd, datasetId, {
			draftId: saved.id,
			revision: 2,
			expectedVersionId: null,
			requestId: "all-sections",
		});
		expect(confirmed.content).toEqual(updated);
		expect(getResearchFramework(cwd, datasetId).versions[0].content).toEqual(updated);
	});
	it("reads legacy records unchanged, rejects legacy publication and permits dismissing an old draft", () => {
		const cwd = project();
		const legacy = {
			title: "旧框架",
			objective: "原研究目标",
			horizon: "一年",
			items: [
				{
					id: "legacy",
					kind: "hypothesis",
					claim: "旧判断",
					rationale: "用户假设",
					subject: "公司",
					verification: "季度数据",
					invalidation: "订单下滑",
					origin: "user",
					evidenceIds: [],
				},
			],
			coverageGaps: ["原资料缺口"],
		};
		withResearchDatabase(cwd, datasetId, (db) => {
			db.prepare("INSERT INTO research_versions VALUES(?,?,1,NULL,?,'[]','before','legacy-request','{}')").run(
				"legacy-version",
				datasetId,
				JSON.stringify(legacy),
			);
			db.prepare("UPDATE research_frameworks SET current_version_id='legacy-version' WHERE dataset_id=?").run(
				datasetId,
			);
			db.prepare("INSERT INTO research_drafts VALUES(?,?,'legacy-version',1,'open',?,'[]','before')").run(
				"legacy-draft",
				datasetId,
				JSON.stringify(legacy),
			);
		});
		expect(getResearchFramework(cwd, datasetId).versions[0].content).toEqual(legacy);
		expect(getResearchFramework(cwd, datasetId).drafts[0].content).toEqual(legacy);
		expect(() => createResearchDraft(cwd, datasetId, legacy, [], "legacy-version")).toThrow("schemaVersion 2");
		expect(() => updateResearchDraft(cwd, datasetId, "legacy-draft", 1, content)).toThrow("read-only");
		expect(() =>
			publishResearchDraft(cwd, datasetId, {
				draftId: "legacy-draft",
				revision: 1,
				expectedVersionId: "legacy-version",
				requestId: "legacy-publish",
			}),
		).toThrow("read-only");
		expect(() => restoreResearchVersion(cwd, datasetId, "legacy-version", "legacy-version")).toThrow("read-only");
		const rejected = updateResearchDraft(cwd, datasetId, "legacy-draft", 1, content, true);
		expect(rejected).toMatchObject({ status: "rejected", revision: 2, content: legacy });
		const replacement = publish(cwd, content, "legacy-version", "new-document");
		expect(replacement.version).toBe(2);
		expect(
			getResearchFramework(cwd, datasetId).versions.find((entry) => entry.id === "legacy-version")?.content,
		).toEqual(legacy);
	});
	it("checks citations in every evidence-bearing section and rejects dangling judgment references", () => {
		const cwd = project();
		const invalidId = sourceId({ docId: "outside", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		const addInvalidEvidence: Array<(value: FrameworkContent) => void> = [
			(value) => {
				value.sections.currentAssessment.evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.businessModel.evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.businessModel.drivers[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.businessModel.kpis[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.investmentJudgments.items[0].counterEvidenceIds = [invalidId];
			},
			(value) => {
				value.sections.valuation.evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.valuation.forecastComparisons[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.valuation.scenarios[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.valuation.catalysts[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.monitoring.rules[0].evidenceIds = [invalidId];
			},
			(value) => {
				value.sections.evidenceAndChanges.sources = [
					{ evidenceId: invalidId, description: "引用", quality: "待核实", limitations: "未获得资料" },
				];
			},
			(value) => {
				value.sections.evidenceAndChanges.changes = [
					{ judgmentIds: [], before: "原判断", after: "新判断", reason: "新资料", evidenceIds: [invalidId] },
				];
			},
		];
		for (const add of addInvalidEvidence) {
			const invalid = structuredClone(content);
			add(invalid);
			expect(() => createResearchDraft(cwd, datasetId, invalid, [], null)).toThrow("outside");
		}
		const addInvalidReference: Array<(value: FrameworkContent) => void> = [
			(value) => {
				value.sections.valuation.scenarios[0].judgmentIds = ["missing"];
			},
			(value) => {
				value.sections.valuation.catalysts[0].judgmentIds = ["missing"];
			},
			(value) => {
				value.sections.monitoring.rules[0].judgmentIds = ["missing"];
			},
			(value) => {
				value.sections.evidenceAndChanges.openQuestions[0].judgmentIds = ["missing"];
			},
			(value) => {
				value.sections.evidenceAndChanges.changes = [
					{ judgmentIds: ["missing"], before: "旧", after: "新", reason: "变化", evidenceIds: [] },
				];
			},
		];
		for (const add of addInvalidReference) {
			const invalid = structuredClone(content);
			add(invalid);
			expect(() => createResearchDraft(cwd, datasetId, invalid, [], null)).toThrow("unknown judgment");
		}
		expect(getResearchFramework(cwd, datasetId).drafts).toEqual([]);
	});
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
		expect(result.details).toMatchObject({ rendered_report: renderInvestmentFrameworkMarkdown(candidate.content) });
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
		const workbookBytes = readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url));
		mkdirSync(join(cwd, "raw"));
		writeFileSync(join(cwd, "raw/report.xlsx"), workbookBytes);
		withResearchDatabase(cwd, datasetId, (db) => {
			for (const [id, extension] of [
				["pdf", "pdf"],
				["excel", "xlsx"],
			]) {
				db.prepare(
					"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,raw_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'completed','before','before')",
				).run(
					id,
					datasetId,
					`report.${extension}`,
					`report.${extension}`,
					id === "excel" ? createHash("sha256").update(workbookBytes).digest("hex") : id,
					extension,
					`raw/report.${extension}`,
				);
			}
			db.exec(
				"INSERT INTO pdf_pages VALUES('page','pdf',1,'原始研报文本','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
		});
		const job = enqueueResearchJob(cwd, datasetId, "分析", ["pdf", "excel"], "evidence", null);
		const pdfId = sourceId({ docId: "pdf", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		const excelId = sourceId({ docId: "excel", location: { kind: "excel", sheet: "Valuation", range: "B7" } });
		expect(readResearchInput(cwd, datasetId, job.input, { docId: "pdf", page: 1 })).toMatchObject({
			text: "原始研报文本",
			evidenceId: pdfId,
		});
		expect(
			readResearchInput(cwd, datasetId, job.input, { docId: "excel", sheet: "Valuation", range: "B7" }),
		).toMatchObject({ cells: [{ numeric_value: 120, formula: "=B5/10", evidence_id: excelId }] });
		for (const status of ["processing", "failed"]) {
			withResearchDatabase(cwd, datasetId, (db) =>
				db
					.prepare(
						"UPDATE documents SET updated_at='cache-rebuilt',parser_version='new-cache',status=? WHERE doc_id='excel'",
					)
					.run(status),
			);
			expect(
				readResearchInput(cwd, datasetId, job.input, {
					docId: "excel",
					action: "read",
					sheet: "Valuation",
					range: "B7",
				}),
			).toMatchObject({ cells: [{ numeric_value: 120, evidence_id: excelId }] });
		}
		withResearchDatabase(cwd, datasetId, (db) =>
			db.exec("UPDATE documents SET version_no=version_no+1 WHERE doc_id='excel'"),
		);
		expect(() => readResearchInput(cwd, datasetId, job.input, { docId: "excel" })).toThrow("changed");
		withResearchDatabase(cwd, datasetId, (db) =>
			db.exec("UPDATE documents SET version_no=version_no-1,sha256='different-source' WHERE doc_id='excel'"),
		);
		expect(() => readResearchInput(cwd, datasetId, job.input, { docId: "excel" })).toThrow("changed");
		withResearchDatabase(cwd, datasetId, (db) =>
			db
				.prepare("UPDATE documents SET sha256=? WHERE doc_id='excel'")
				.run(createHash("sha256").update(workbookBytes).digest("hex")),
		);
		writeFileSync(join(cwd, "raw/report.xlsx"), Buffer.concat([workbookBytes, Buffer.from("changed")]));
		expect(() => readResearchInput(cwd, datasetId, job.input, { docId: "excel" })).toThrow("changed");
		writeFileSync(join(cwd, "raw/report.xlsx"), workbookBytes);
		const verified = withFrameworkItems(content, [
			{
				...content.sections.investmentJudgments.items[0],
				origin: "research" as const,
				evidenceIds: [pdfId, excelId],
			},
		]);
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
		const verified = withFrameworkItems(content, [
			{
				...content.sections.investmentJudgments.items[0],
				origin: "research",
				evidenceIds: ["page:page", canonical],
			},
		]);
		verified.sections.currentAssessment.evidenceIds = ["page:page", canonical];
		verified.sections.businessModel.drivers[0].evidenceIds = ["page:page", canonical];
		verified.sections.investmentJudgments.items[0].counterEvidenceIds = ["page:page", canonical];
		verified.sections.valuation.scenarios[0].evidenceIds = ["page:page", canonical];
		verified.sections.monitoring.rules[0].evidenceIds = ["page:page", canonical];
		verified.sections.evidenceAndChanges.sources = [
			{ evidenceId: "page:page", description: "研报原页", quality: "原始资料", limitations: "仅一页" },
		];
		verified.sections.evidenceAndChanges.changes = [
			{
				judgmentIds: ["margin"],
				before: "待核实",
				after: "已阅读",
				reason: "新增资料",
				evidenceIds: ["page:page", canonical],
			},
		];
		const ctx = { cwd } as Parameters<typeof peFrameworkTool.execute>[4];
		const proposal = await peFrameworkTool.execute(
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
		expect(collectFrameworkEvidenceIds(state.drafts[0].content)).toEqual([canonical]);
		expect(JSON.stringify(state.drafts[0].content)).not.toContain("page:page");
		expect(proposal.details).toMatchObject({
			rendered_report: renderInvestmentFrameworkMarkdown(state.drafts[0].content),
		});
		expect(state.drafts[0].content).toMatchObject({
			sections: { investmentJudgments: { items: [{ evidenceIds: [canonical] }] } },
		});
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
					content: withFrameworkItems(verified, [
						{ ...verified.sections.investmentJudgments.items[0], evidenceIds: ["page:missing"] },
					]),
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
			createResearchDraft(
				cwd,
				datasetId,
				withFrameworkItems(content, [
					content.sections.investmentJudgments.items[0],
					content.sections.investmentJudgments.items[0],
				]),
				[],
				null,
			),
		).toThrow("unique");
		expect(() =>
			createResearchDraft(
				cwd,
				datasetId,
				withFrameworkItems(content, [{ ...content.sections.investmentJudgments.items[0], origin: "research" }]),
				[],
				null,
			),
		).toThrow("require evidence");
		expect(() => createResearchDraft(cwd, datasetId, content, ["missing"], null)).toThrow("not ready");
		expect(() =>
			readResearchInput(cwd, datasetId, { objective: "test", inputs: [], asOf: "now" }, { docId: "outside" }),
		).toThrow("outside");
	});
	it("requires whole-document confirmation and restores all seven sections as a new version", () => {
		const cwd = project();
		const base = withFrameworkItems(content, [
			...content.sections.investmentJudgments.items,
			{ ...content.sections.investmentJudgments.items[0], id: "demand", claim: "需求待验证" },
		]);
		const v1 = publish(cwd, base);
		const changed = {
			...withFrameworkItems(
				base,
				base.sections.investmentJudgments.items.map((item) => ({
					...item,
					claim: `${item.claim}已修改`,
				})),
			),
			title: "New title",
		};
		const proposed = createResearchDraft(cwd, datasetId, changed, [], v1.id);
		const publication = {
			draftId: proposed.id,
			revision: 1,
			expectedVersionId: v1.id,
			requestId: "complete",
		};
		expect(() => publishResearchDraft(cwd, datasetId, { ...publication, selectedItemIds: ["margin"] })).toThrow(
			"complete seven-section",
		);
		const unchanged = getResearchFramework(cwd, datasetId);
		expect(unchanged.currentVersionId).toBe(v1.id);
		expect(unchanged.versions).toHaveLength(1);
		expect(unchanged.drafts.find((entry) => entry.id === proposed.id)).toMatchObject({
			status: "open",
			revision: 1,
			content: changed,
		});
		const v2 = publishResearchDraft(cwd, datasetId, publication);
		expect(v2.content).toEqual(changed);
		expect(getResearchFramework(cwd, datasetId).versions[0].content).toEqual(changed);
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
