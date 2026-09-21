import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import {
	buildResearchCardContext,
	type CreateResearchCard,
	createResearchCard,
	listResearchCards,
	updateResearchCard,
} from "../src/research/cards.ts";
import { createResearchDraft, publishResearchDraft } from "../src/research/framework.ts";
import type { FrameworkContent } from "../src/research/model.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";

const roots: string[] = [];
function project(datasetId = "cards") {
	const cwd = mkdtempSync(join(tmpdir(), "pe-cards-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "研究积累测试" });
	return cwd;
}
const input: CreateResearchCard = {
	requestId: "save-one",
	kind: "note",
	title: "需求恢复假设",
	content: "需求恢复尚待核实",
	evidenceIds: [],
	relatedCardIds: [],
	origin: { sessionId: "first-session", entryId: "answer", excerpt: "需求恢复尚待核实", messageTimestamp: 123 },
};
const framework: FrameworkContent = {
	title: "投资框架",
	objective: "验证需求恢复与盈利质量",
	horizon: "未来三年",
	items: [
		{
			id: "demand-recovery",
			kind: "hypothesis",
			claim: "需求可能恢复",
			rationale: "用户提出的待验证假设",
			subject: "需求恢复",
			verification: "核对销量与订单",
			invalidation: "销量持续下降",
			origin: "user",
			evidenceIds: [],
		},
	],
	coverageGaps: [],
};
function publishFramework(cwd: string, content = framework, expectedVersionId: string | null = null) {
	const draft = createResearchDraft(cwd, "cards", content, [], expectedVersionId);
	return publishResearchDraft(cwd, "cards", {
		draftId: draft.id,
		revision: draft.revision,
		expectedVersionId,
		requestId: `publish-${draft.id}`,
	});
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project research cards", () => {
	it("persists origins across connections, deduplicates retries and rejects changed request content", () => {
		const cwd = project();
		const card = createResearchCard(cwd, "cards", input);
		expect(card.status).toBe("unverified");
		expect(listResearchCards(cwd, "cards")).toEqual([card]);
		expect(createResearchCard(cwd, "cards", input).id).toBe(card.id);
		expect(() => createResearchCard(cwd, "cards", { ...input, title: "different" })).toThrow("其他内容");
		expect(listResearchCards(cwd, "cards")).toHaveLength(1);
	});
	it("links cards to current framework items and preserves stale links after framework changes", () => {
		const cwd = project();
		const firstVersion = publishFramework(cwd);
		const card = createResearchCard(cwd, "cards", { ...input, frameworkItemIds: ["demand-recovery"] });
		expect(card.frameworkItems).toEqual([
			{
				id: "demand-recovery",
				available: true,
				kind: "hypothesis",
				subject: "需求恢复",
			},
		]);
		expect(() =>
			createResearchCard(cwd, "cards", { ...input, requestId: "bad-link", frameworkItemIds: ["missing"] }),
		).toThrow("框架条目已变化");
		const current = publishFramework(
			cwd,
			{ ...framework, items: [{ ...framework.items[0], id: "replacement" }] },
			firstVersion.id,
		);
		expect(current.version).toBe(2);
		const stale = listResearchCards(cwd, "cards")[0];
		expect(stale.frameworkItems).toEqual([{ id: "demand-recovery", available: false, kind: null, subject: null }]);
		const confirmed = updateResearchCard(cwd, "cards", stale.id, stale.revision, { ...stale, status: "confirmed" });
		expect(confirmed.frameworkItemIds).toEqual(["demand-recovery"]);
		expect(() =>
			updateResearchCard(cwd, "cards", confirmed.id, confirmed.revision, {
				...confirmed,
				frameworkItemIds: ["missing"],
			}),
		).toThrow("框架条目已变化");
	});
	it("keeps original excerpts and previous revisions while rejecting stale edits and invalid status", () => {
		const cwd = project();
		const card = createResearchCard(cwd, "cards", input);
		const revised = updateResearchCard(cwd, "cards", card.id, 1, {
			...card,
			content: "用户修订的判断",
			status: "confirmed",
		});
		expect(revised.origin?.excerpt).toBe(input.content);
		expect(revised.revision).toBe(2);
		expect(() => updateResearchCard(cwd, "cards", card.id, 1, card)).toThrow("已被更新");
		expect(() => updateResearchCard(cwd, "cards", card.id, 2, { ...revised, status: "resolved" })).toThrow(
			"确认状态",
		);
		withResearchDatabase(cwd, "cards", (db) => {
			const original = db
				.prepare("SELECT card_json FROM research_card_revisions WHERE card_id=? AND revision=1")
				.get(card.id);
			expect(JSON.parse(String(original?.card_json)).content).toBe(input.content);
		});
	});
	it("resolves original PDF evidence, inherits question references and retains missing-evidence warnings", () => {
		const cwd = project();
		withResearchDatabase(cwd, "cards", (db) => {
			db.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('pdf','cards','report.pdf','report.pdf','hash','pdf','completed','before','before')",
			).run();
			db.exec(
				"INSERT INTO pdf_pages VALUES('page','pdf',1,'原始研报文本','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
		});
		const evidence = sourceId({ docId: "pdf", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		const card = createResearchCard(cwd, "cards", { ...input, evidenceIds: [evidence, "page:missing"] });
		expect(card.evidence.map((entry) => entry.available)).toEqual([true, false]);
		const question = createResearchCard(cwd, "cards", {
			...input,
			requestId: "question",
			kind: "question",
			title: "现金流是否改善？",
			origin: null,
			relatedCardIds: [card.id],
		});
		expect(question.status).toBe("open");
		expect(question.evidenceIds).toEqual(card.evidenceIds);
		const context = buildResearchCardContext(cwd, "cards", [{ id: question.id, revision: 1 }]);
		expect(context).toContain(encodeURIComponent(evidence));
		expect(context).toContain("暂不可定位");
		withResearchDatabase(cwd, "cards", (db) =>
			db.exec("UPDATE documents SET deleted_at='removed' WHERE doc_id='pdf'"),
		);
		expect(
			listResearchCards(cwd, "cards").every((entry) => entry.evidence.every((record) => !record.available)),
		).toBe(true);
	});
	it("rejects cross-project reads, links and continuation selection", () => {
		const cwd = project();
		const other = project("other");
		const card = createResearchCard(cwd, "cards", input);
		expect(listResearchCards(other, "other")).toEqual([]);
		expect(() => listResearchCards(cwd, "other")).toThrow();
		expect(() => buildResearchCardContext(other, "other", [{ id: card.id, revision: 1 }])).toThrow("不存在");
		expect(() => createResearchCard(other, "other", { ...input, relatedCardIds: [card.id] })).toThrow("不存在");
	});
	it("freezes selected context and requires re-selection after edit or archive", () => {
		const cwd = project();
		const first = createResearchCard(cwd, "cards", input);
		createResearchCard(cwd, "cards", { ...input, requestId: "unselected", title: "不应进入本轮的内容" });
		const selection = [{ id: first.id, revision: 1 }];
		const context = buildResearchCardContext(cwd, "cards", selection);
		expect(context).toContain("待核实");
		expect(context).not.toContain("不应进入本轮");
		const confirmed = updateResearchCard(cwd, "cards", first.id, 1, { ...first, status: "confirmed" });
		expect(() => buildResearchCardContext(cwd, "cards", selection)).toThrow("已修改");
		expect(context).toContain("状态：待核实");
		expect(buildResearchCardContext(cwd, "cards", [{ id: first.id, revision: 2 }])).toContain("状态：已人工确认");
		const archived = updateResearchCard(cwd, "cards", first.id, 2, { ...confirmed, archived: true });
		expect(() => buildResearchCardContext(cwd, "cards", [{ id: first.id, revision: 3 }])).toThrow("归档");
		updateResearchCard(cwd, "cards", first.id, 3, { ...archived, archived: false });
		expect(buildResearchCardContext(cwd, "cards", [{ id: first.id, revision: 4 }])).toContain(first.content);
	});
	it("bounds selection and content without silently truncating research", () => {
		const cwd = project();
		expect(() => createResearchCard(cwd, "cards", { ...input, content: "x".repeat(20001) })).toThrow("20000");
		expect(() => buildResearchCardContext(cwd, "cards", [])).toThrow("1 至 20");
		const cards = [0, 1].map((index) =>
			createResearchCard(cwd, "cards", {
				...input,
				requestId: `long-${index}`,
				content: "x".repeat(20000),
				origin: { ...input.origin!, excerpt: "x".repeat(20000) },
			}),
		);
		expect(() =>
			buildResearchCardContext(
				cwd,
				"cards",
				cards.map((card) => ({ id: card.id, revision: 1 })),
			),
		).toThrow("过长");
	});
});
