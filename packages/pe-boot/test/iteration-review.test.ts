import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import {
	createResearchDraft,
	getResearchFramework,
	publishResearchDraft,
	updateResearchDraft,
} from "../src/research/framework.ts";
import {
	cancelFrameworkIteration,
	createFrameworkIteration,
	decideFrameworkIteration,
	getFrameworkIteration,
	type IterationEngine,
	type IterationImpacts,
	type IterationObservations,
	runFrameworkIteration,
	setIterationTestProject,
} from "../src/research/iteration.ts";
import {
	assembleIterationReview,
	buildIterationChanges,
	getIterationChangeReview,
	type IterationChange,
	listIterationChangeReviewHistory,
	publishIterationChangeReview,
	saveIterationChangeDecisions,
} from "../src/research/iteration-review.ts";
import { isFrameworkDocument } from "../src/research/model.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const roots: string[] = [];
const dataset = "dataset_review";
const evidence = sourceId({ docId: "new", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
const facts: IterationObservations = {
	observations: [
		{
			id: "revenue",
			docId: "new",
			subject: "公司",
			metric: "收入",
			value: 9,
			period: "二季度",
			unit: "亿元",
			role: "fact",
			quote: "二季度收入9亿元",
			evidenceIds: [evidence],
			gaps: ["销量、毛利率未披露"],
			context: {
				periodKind: "single",
				asOf: null,
				scope: "公司",
				basisQuote: "二季度收入9亿元",
				eventKind: "none",
				reviewReasons: [],
			},
		},
	],
	coverage: [{ docId: "new", readLocations: ["page 1"], gaps: [] }],
};
const impacts: IterationImpacts = {
	substantive: true,
	summary: "收入低于假设，利润原因待核实",
	gaps: ["缺少毛利率"],
	impacts: [
		{
			judgmentIds: ["demand"],
			sections: ["investmentJudgments", "monitoring"],
			observationIds: ["revenue"],
			relation: "weakens",
			comparable: true,
			comparisonBasis: { period: "二季度", periodKind: "single", scope: "公司" },
			reason: "季度收入弱于假设，不能反推销量",
			proposedChange: "需求判断待核验",
			evidenceIds: [evidence],
		},
		{
			judgmentIds: ["margin"],
			sections: ["investmentJudgments", "valuation"],
			observationIds: ["revenue"],
			relation: "unresolved",
			comparable: false,
			comparisonBasis: null,
			reason: "收入不足以判断盈利改善",
			proposedChange: "保留盈利缺口",
			evidenceIds: [evidence],
		},
	],
};
function setup(reviewMode = true) {
	const cwd = mkdtempSync(join(tmpdir(), "pe-iteration-review-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId: dataset, name: "Review" });
	const original = frameworkFixture();
	original.sections.investmentJudgments.items.push({
		...structuredClone(original.sections.investmentJudgments.items[0]),
		id: "margin",
		claim: "盈利可能改善",
	});
	original.sections.monitoring.rules[0].judgmentIds = ["demand"];
	original.sections.valuation.scenarios[0].judgmentIds = ["margin"];
	const first = createResearchDraft(cwd, dataset, original, [], null);
	const basis = publishResearchDraft(cwd, dataset, {
		draftId: first.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "baseline",
	});
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new',?,'new.pdf','new.pdf','new','pdf','completed','before','before')",
		).run(dataset);
		db.exec(
			"INSERT INTO pdf_pages VALUES('page','new',1,'二季度收入9亿元','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
		);
	});
	setIterationTestProject(cwd, dataset, reviewMode);
	const request = {
		requestId: "review-run",
		basisVersionId: basis.id,
		modelId: "platform-test",
		uploadIdentity: "sha256",
		changeReview: reviewMode,
	};
	const run = createFrameworkIteration(cwd, dataset, request);
	const candidate = structuredClone(original);
	candidate.sections.researchSetup.informationCutoff = null;
	candidate.sections.currentAssessment.summary = "需求弱于假设，盈利仍待核查";
	candidate.sections.investmentJudgments.items[0].claim = "收入弱于假设，需求仍待核查";
	candidate.sections.investmentJudgments.items[1].claim = "无法从收入确定盈利改善";
	for (const item of candidate.sections.investmentJudgments.items) item.evidenceIds = [evidence];
	candidate.sections.monitoring.rules[0].action = "先核查订单和价格，再评估需求";
	candidate.sections.monitoring.rules[0].evidenceIds = [evidence];
	candidate.sections.valuation.scenarios[0].assumptions = "毛利率缺失，保留基线估值，不生成目标价";
	candidate.sections.valuation.scenarios[0].evidenceIds = [evidence];
	candidate.sections.evidenceAndChanges.sources.push({
		evidenceId: evidence,
		description: "季度收入",
		quality: "official",
		limitations: "未披露销量和毛利率",
	});
	candidate.sections.evidenceAndChanges.changes = candidate.sections.investmentJudgments.items.map((item, index) => ({
		judgmentIds: [item.id],
		before: original.sections.investmentJudgments.items[index].claim,
		after: item.claim,
		reason: impacts.impacts[index].reason,
		evidenceIds: [evidence],
	}));
	const engine: IterationEngine = {
		async extract() {
			return facts;
		},
		async impact() {
			return impacts;
		},
		async revise() {
			return candidate;
		},
	};
	return { cwd, run, request, engine, basis, original, candidate };
}
async function ready(reviewMode = true) {
	const value = setup(reviewMode);
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(value.run.status).toBe("review_required");
	return value;
}
function decideAll(value: Awaited<ReturnType<typeof ready>>, decision: "accepted" | "rejected") {
	const review = getIterationChangeReview(value.cwd, dataset, value.run)!;
	return saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{
			planId: review.plan.id,
			revision: review.revision,
			changeIds: review.plan.changes.map((change) => change.id),
			decision,
			note: "核查原文后决定",
		},
		"reviewer",
	);
}
function acceptChanges(value: ReturnType<typeof setup>, select: (change: IterationChange) => boolean) {
	const review = getIterationChangeReview(value.cwd, dataset, value.run)!;
	return saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{
			planId: review.plan.id,
			revision: review.revision,
			changeIds: review.plan.changes.filter(select).map((change) => change.id),
			decision: "accepted",
			note: "只采用明确选择的字段",
		},
		"reviewer",
	);
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("holds registered test projects for point review, with stable locations and provenance", async () => {
	const value = await ready();
	expect(value.run.automatic).toBe(false);
	expect(getResearchFramework(value.cwd, dataset).versions).toHaveLength(1);
	const review = getIterationChangeReview(value.cwd, dataset, value.run)!;
	const claim = review.plan.changes.find((change) => change.path.at(-1) === "claim")!;
	expect(claim.path).toContain("@id:demand");
	expect(claim.evidenceIds).toContain(evidence);
	expect(claim.observationIds).toEqual(["revenue"]);
	expect(claim.reasons).toEqual([impacts.impacts[0].reason]);
	expect(review.events).toHaveLength(0);
	expect(review.errors.join(" ")).toContain("尚未决定");
	expect(buildIterationChanges(value.original, value.candidate, impacts).map((change) => change.id)).toEqual(
		review.plan.changes.map((change) => change.id),
	);
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: 0, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("尚未决定");
});
it("decides only the selected field and retains separate notes and stale-edit guards", async () => {
	const value = await ready();
	const review = getIterationChangeReview(value.cwd, dataset, value.run)!;
	const demand = review.plan.changes.find((change) => change.path.includes("@id:demand"))!;
	const input = {
		planId: review.plan.id,
		revision: 0,
		changeIds: [demand.id],
		decision: "accepted" as const,
		note: "不能反推销量",
	};
	const saved = saveIterationChangeDecisions(value.cwd, dataset, value.run, input, "reviewer");
	expect(saved.events[0].changeIds).toEqual([demand.id]);
	expect(
		saved.plan.changes
			.filter((change) => change.section === "monitoring")
			.every((change) => saved.decisions[change.id].decision === "pending"),
	).toBe(true);
	expect(() => saveIterationChangeDecisions(value.cwd, dataset, value.run, input, "other")).toThrow("已变化");
	expect(() =>
		saveIterationChangeDecisions(
			value.cwd,
			dataset,
			value.run,
			{ ...input, revision: 1, changeIds: ["invented"] },
			"reviewer",
		),
	).toThrow("未知修改");
	const restored = getIterationChangeReview(
		value.cwd,
		dataset,
		getFrameworkIteration(value.cwd, dataset, value.run.id),
	)!;
	expect(restored.events).toEqual(saved.events);
	const undone = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{ ...input, revision: 1, decision: "pending", note: "继续核查" },
		"reviewer",
	);
	expect(undone.revision).toBe(2);
	expect(undone.events).toHaveLength(2);
	expect(undone.decisions[demand.id].decision).toBe("pending");
	const evidenceChange = saved.plan.changes.find(
		(change) => change.path.includes("@id:demand") && change.path.at(-1) === "evidenceIds",
	)!;
	const independentlySaved = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{ ...input, revision: 2, changeIds: [evidenceChange.id], note: "仅接受来源" },
		"reviewer",
	);
	expect(independentlySaved.decisions[demand.id].decision).toBe("pending");
	expect(independentlySaved.decisions[demand.id].note).toBe("继续核查");
	expect(independentlySaved.decisions[evidenceChange.id].note).toBe("仅接受来源");
});
it("publishes all accepted patches once and retains the original candidate and immutable receipt", async () => {
	const value = await ready();
	const review = decideAll(value, "accepted");
	expect(review.preview).toEqual(value.candidate);
	expect(review.errors).toEqual([]);
	const input = { planId: review.plan.id, revision: review.revision, acknowledgeWarnings: false };
	const ids = await Promise.all([
		publishIterationChangeReview(value.cwd, dataset, value.run, input, AbortSignal.timeout(5000)),
		publishIterationChangeReview(value.cwd, dataset, value.run, input, AbortSignal.timeout(5000)),
	]);
	expect(ids[0]).toBe(ids[1]);
	expect(getResearchFramework(value.cwd, dataset).versions).toHaveLength(2);
	const published = getFrameworkIteration(value.cwd, dataset, value.run.id);
	expect(published.status).toBe("published");
	expect(published.artifacts.find((artifact) => artifact.stage === "revise")?.value).toEqual(value.candidate);
	expect(getIterationChangeReview(value.cwd, dataset, published)?.publication?.revision).toBe(1);
	expect(listIterationChangeReviewHistory(value.cwd, dataset, value.run.id)[0].events[0].actorId).toBe("reviewer");
	expect(() =>
		withResearchDatabase(value.cwd, dataset, (db) => db.exec("DELETE FROM framework_iteration_review_events")),
	).toThrow("immutable");
	expect(() =>
		withResearchDatabase(value.cwd, dataset, (db) =>
			db.exec("UPDATE framework_iteration_review_publications SET revision=9"),
		),
	).toThrow("immutable");
});
it("keeps rejected fields intact and records only the actual partial changes", async () => {
	const value = await ready();
	let review = decideAll(value, "accepted");
	const ids = review.plan.changes
		.filter((change) => change.judgmentIds.includes("margin") || change.section === "currentAssessment")
		.map((change) => change.id);
	review = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{
			planId: review.plan.id,
			revision: review.revision,
			changeIds: ids,
			decision: "rejected",
			note: "盈利口径证据不足",
		},
		"reviewer",
	);
	expect(review.errors).toEqual([]);
	expect(review.warnings.join(" ")).toContain("部分采纳");
	expect(review.preview?.sections.investmentJudgments.items[1]).toEqual(
		value.original.sections.investmentJudgments.items[1],
	);
	expect(review.preview?.sections.valuation).toEqual(value.original.sections.valuation);
	expect(review.preview?.sections.currentAssessment).toEqual(value.original.sections.currentAssessment);
	expect(review.preview?.sections.evidenceAndChanges.changes.map((entry) => entry.judgmentIds)).toEqual([["demand"]]);
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("确认部分采纳");
	await publishIterationChangeReview(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: true },
		AbortSignal.timeout(5000),
	);
	const result = getResearchFramework(value.cwd, dataset).versions[0].content;
	expect(isFrameworkDocument(result) && result.sections.monitoring.rules[0].action).toBe(
		value.candidate.sections.monitoring.rules[0].action,
	);
	const next = createFrameworkIteration(value.cwd, dataset, {
		...value.request,
		requestId: "next-round",
		basisVersionId: getResearchFramework(value.cwd, dataset).currentVersionId!,
	});
	expect(next.basisVersionId).not.toBe(value.run.basisVersionId);
});
it("warns about partial summary support and requires explicit verification before publication", async () => {
	const value = await ready();
	let review = decideAll(value, "accepted");
	const marginIds = review.plan.changes
		.filter((change) => change.judgmentIds.includes("margin"))
		.map((change) => change.id);
	review = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: 1, changeIds: marginIds, decision: "rejected", note: "缺少利润数据" },
		"reviewer",
	);
	expect(review.errors).toEqual([]);
	expect(review.warnings.join(" ")).toContain("关联建议");
	expect(review.preview?.sections.investmentJudgments.items[1]).toEqual(
		value.original.sections.investmentJudgments.items[1],
	);
	expect(review.preview?.sections.currentAssessment.summary).toBe(value.candidate.sections.currentAssessment.summary);
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: 2, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("确认部分采纳");
});
it("does not silently apply a rejected information-cutoff change", async () => {
	const value = await ready();
	let review = decideAll(value, "accepted");
	const cutoff = review.plan.changes.find((change) => change.path.at(-1) === "informationCutoff")!;
	review = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: 1, changeIds: [cutoff.id], decision: "rejected", note: "保留旧日期" },
		"reviewer",
	);
	expect(review.errors.join(" ")).toContain("截止日");
	expect(review.preview).toBeNull();
});
it("ends an all-rejected round without a new version", async () => {
	const value = await ready();
	const review = decideAll(value, "rejected");
	expect(review.preview).toBeNull();
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: 1, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("没有可发布");
	expect(
		(await decideFrameworkIteration(value.cwd, dataset, value.run.id, false, AbortSignal.timeout(5000))).status,
	).toBe("rejected");
	expect(getResearchFramework(value.cwd, dataset).versions).toHaveLength(1);
	expect(listIterationChangeReviewHistory(value.cwd, dataset, value.run.id)[0].events).toHaveLength(1);
});
it("fences legacy confirmation, generic draft publication and cancelled runs", async () => {
	const value = await ready();
	await expect(
		decideFrameworkIteration(value.cwd, dataset, value.run.id, true, AbortSignal.timeout(5000)),
	).rejects.toThrow("逐项审查");
	expect(() =>
		publishResearchDraft(value.cwd, dataset, {
			draftId: value.run.draftId!,
			revision: 1,
			expectedVersionId: value.basis.id,
			requestId: "bypass",
		}),
	).toThrow("逐项审查");
	const review = decideAll(value, "accepted");
	cancelFrameworkIteration(value.cwd, dataset, value.run.id);
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: 1, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("没有可发布");
	expect(() =>
		saveIterationChangeDecisions(
			value.cwd,
			dataset,
			value.run,
			{
				planId: review.plan.id,
				revision: 1,
				changeIds: review.plan.changes.map((entry) => entry.id),
				decision: "pending",
				note: "late",
			},
			"reviewer",
		),
	).toThrow("不允许");
	expect(() => listIterationChangeReviewHistory(value.cwd, "other", value.run.id)).toThrow();
});
it("enrolls a legacy pending draft and fences its former acceptance action", async () => {
	const value = await ready(false);
	decideAll(value, "accepted");
	expect(getFrameworkIteration(value.cwd, dataset, value.run.id).changeReview).toBe(true);
	await expect(
		decideFrameworkIteration(value.cwd, dataset, value.run.id, true, AbortSignal.timeout(5000)),
	).rejects.toThrow("逐项审查");
});
it("preserves review history when a concurrent version invalidates the baseline", async () => {
	const value = await ready();
	const review = decideAll(value, "accepted");
	const manual = createResearchDraft(value.cwd, dataset, value.original, [], value.basis.id);
	publishResearchDraft(value.cwd, dataset, {
		draftId: manual.id,
		revision: 1,
		expectedVersionId: value.basis.id,
		requestId: "manual",
	});
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: 1, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("没有可发布");
	expect(getFrameworkIteration(value.cwd, dataset, value.run.id).status).toBe("blocked");
	expect(listIterationChangeReviewHistory(value.cwd, dataset, value.run.id)[0].events).toHaveLength(1);
});
it("rejects publication if a prepared draft is edited outside the point review", async () => {
	const value = await ready();
	const review = decideAll(value, "accepted");
	await publishIterationChangeReview(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: 1, acknowledgeWarnings: false },
		AbortSignal.timeout(5000),
	);
	const published = getFrameworkIteration(value.cwd, dataset, value.run.id);
	const current = getResearchFramework(value.cwd, dataset).versions[0];
	// Check the guard with an otherwise valid new draft, leaving immutable published versions intact.
	const draft = createResearchDraft(value.cwd, dataset, value.candidate, ["new"], current.id);
	updateResearchDraft(value.cwd, dataset, draft.id, 1, value.candidate);
	expect(() =>
		publishResearchDraft(value.cwd, dataset, {
			draftId: draft.id,
			revision: 2,
			expectedVersionId: current.id,
			requestId: "forged",
			iteration: { runId: published.id, automatic: false, reviewPlanId: review.plan.id, reviewRevision: 1 },
		}),
	).toThrow("绕过逐项审查");
});

it("tracks stable-ID reordering separately and applies accepted ordering", async () => {
	const value = setup();
	value.candidate.sections.investmentJudgments.items.reverse();
	value.candidate.sections.valuation.scenarios.reverse();
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(value.run.status).toBe("review_required");
	const review = decideAll(value, "accepted");
	expect(review.plan.changes.filter((change) => change.path.at(-1)?.startsWith("@order:")).length).toBe(2);
	expect(review.preview).toEqual(value.candidate);
	expect(review.errors).toEqual([]);
});
it("attaches new judgments to the originating impact and retains their sources", async () => {
	const value = setup();
	value.candidate.sections.investmentJudgments.items.push({
		...structuredClone(value.candidate.sections.investmentJudgments.items[0]),
		id: "new-case",
		origin: "research",
		claim: "收入不能替代销量证据",
	});
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(value.run.status).toBe("review_required");
	const review = decideAll(value, "accepted");
	const addition = review.plan.changes.find((change) => change.path.includes("@id:new-case"))!;
	expect(addition.observationIds).toEqual(["revenue"]);
	expect(addition.evidenceIds).toContain(evidence);
	expect(addition.dependencies.length).toBeGreaterThan(0);
	expect(review.preview).toEqual(value.candidate);
	expect(review.errors).toEqual([]);
});
it("invalidates old review decisions when the effective candidate checkpoint changes", async () => {
	const value = await ready();
	const first = decideAll(value, "accepted");
	const revised = structuredClone(value.candidate);
	revised.sections.investmentJudgments.items[0].rationale = "定向修订后的最新判断依据";
	withResearchDatabase(value.cwd, dataset, (db) =>
		db
			.prepare("INSERT INTO framework_iteration_artifact_attempts VALUES(?,?,?,?)")
			.run(
				"replacement",
				value.run.id,
				"revise",
				JSON.stringify({ stage: "revise", value: revised, at: "2099-01-01T00:00:00.000Z" }),
			),
	);
	expect(() =>
		saveIterationChangeDecisions(
			value.cwd,
			dataset,
			value.run,
			{
				planId: first.plan.id,
				revision: 1,
				changeIds: [first.plan.changes[0].id],
				decision: "rejected",
				note: "stale",
			},
			"reviewer",
		),
	).toThrow("候选版本已变化");
	const latest = getIterationChangeReview(
		value.cwd,
		dataset,
		getFrameworkIteration(value.cwd, dataset, value.run.id),
	)!;
	expect(latest.plan.id).not.toBe(first.plan.id);
	expect(latest.revision).toBe(0);
	expect(
		listIterationChangeReviewHistory(value.cwd, dataset, value.run.id).map((entry) => entry.events.length),
	).toEqual([1, 0]);
});

it("keeps execution failures and stage attempts visible after checkpoint recovery", async () => {
	const value = setup();
	const originalImpact = value.engine.impact;
	value.engine.impact = async () => {
		throw new Error("temporary provider failure");
	};
	const ingest = async () => ({ docIds: ["new"], warnings: [] });
	const failed = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		ingest,
		AbortSignal.timeout(5000),
	);
	expect(failed.status).toBe("failed");
	expect(failed.diagnostics.find((entry) => entry.tool === "pe_iteration_execution_error")?.error).toBe(
		"temporary provider failure",
	);
	value.engine.impact = originalImpact;
	value.engine.extract = async () => {
		throw new Error("must reuse validated extraction");
	};
	const resumed = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		ingest,
		AbortSignal.timeout(5000),
	);
	expect(resumed.status).toBe("review_required");
	expect(resumed.error).toBeNull();
	expect(resumed.executionAttempts?.map((attempt) => attempt.status)).toEqual(["failed", "review_required"]);
	expect(
		resumed.stageAttempts?.filter((attempt) => attempt.stage === "impact").map((attempt) => attempt.status),
	).toEqual(["failed", "completed"]);
	expect(resumed.diagnostics.find((entry) => entry.tool === "pe_iteration_execution_error")?.error).toBe(
		"temporary provider failure",
	);
});

it("reviews source catalog entries independently from the coverage-gap rewrite", async () => {
	const value = setup();
	value.candidate.sections.evidenceAndChanges.coverageGaps = ["销量和毛利率仍缺失"];
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	const review = getIterationChangeReview(value.cwd, dataset, value.run)!;
	const source = review.plan.changes.find((change) => change.path.includes("sources"))!;
	const gaps = review.plan.changes.find((change) => change.path.includes("coverageGaps"))!;
	const saved = saveIterationChangeDecisions(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: 0, changeIds: [source.id], decision: "rejected", note: "资料描述需核实" },
		"reviewer",
	);
	expect(saved.decisions[source.id].decision).toBe("rejected");
	expect(saved.decisions[gaps.id].decision).toBe("pending");
	expect(saved.events[0].changeIds).toEqual([source.id]);
});

it("reads a completed review from its immutable plan and published document", async () => {
	const value = await ready();
	const review = decideAll(value, "accepted");
	await publishIterationChangeReview(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: 1, acknowledgeWarnings: false },
		AbortSignal.timeout(5000),
	);
	const completed = getFrameworkIteration(value.cwd, dataset, value.run.id);
	const historical = getIterationChangeReview(value.cwd, dataset, {
		...completed,
		processorVersion: "future",
		modelId: "new-catalog-alias",
	})!;
	expect(historical.plan.id).toBe(review.plan.id);
	expect(historical.plan.modelId).toBe(value.run.modelId);
	expect(historical.plan.processorVersion).toBe(value.run.processorVersion);
	expect(historical.preview).toEqual(getResearchFramework(value.cwd, dataset).versions[0].content);
	expect(historical.events).toEqual(review.events);
	expect(listIterationChangeReviewHistory(value.cwd, dataset, value.run.id)).toHaveLength(1);
});

it("requires adopted judgment evidence without forcing its rationale and monitoring changes", async () => {
	const value = setup();
	value.candidate.sections.investmentJudgments.items[0].rationale = "新收入只能支持进一步核查，不能确定需求原因";
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	decideAll(value, "rejected");
	let review = acceptChanges(
		value,
		(change) =>
			change.path.at(-1) === "informationCutoff" ||
			(change.path.includes("@id:demand") && change.path.at(-1) === "claim"),
	);
	expect(review.errors.join(" ")).toContain("缺少本轮证据");
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: true },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("缺少本轮证据");
	review = acceptChanges(
		value,
		(change) => change.path.includes("@id:demand") && change.path.at(-1) === "evidenceIds",
	);
	expect(review.errors).toEqual([]);
	expect(review.preview?.sections.investmentJudgments.items[0].rationale).toBe(
		value.original.sections.investmentJudgments.items[0].rationale,
	);
	expect(review.preview?.sections.monitoring).toEqual(value.original.sections.monitoring);
	expect(review.preview?.sections.investmentJudgments.items[1]).toEqual(
		value.original.sections.investmentJudgments.items[1],
	);
	await publishIterationChangeReview(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: true },
		AbortSignal.timeout(5000),
	);
	const completed = getFrameworkIteration(value.cwd, dataset, value.run.id);
	expect(getIterationChangeReview(value.cwd, dataset, completed)?.warnings.join(" ")).toContain("仅采用部分修改");
});

it("keeps the original claim and truthful change history when only its citation is adopted", async () => {
	const value = await ready();
	decideAll(value, "rejected");
	const review = acceptChanges(
		value,
		(change) =>
			change.path.at(-1) === "informationCutoff" ||
			(change.path.includes("@id:demand") && change.path.at(-1) === "evidenceIds"),
	);
	expect(review.errors).toEqual([]);
	expect(review.preview?.sections.investmentJudgments.items[0].claim).toBe(
		value.original.sections.investmentJudgments.items[0].claim,
	);
	const change = review.preview!.sections.evidenceAndChanges.changes[0];
	expect(change.before).toBe(value.original.sections.investmentJudgments.items[0].claim);
	expect(change.after).toBe(change.before);
	expect(change.reason).toContain("判断正文保留基线");
	expect(change.reason).not.toContain(impacts.impacts[0].proposedChange);
	expect(change.evidenceIds).toEqual([evidence]);
});

it("allows one judgment and a shared business field without adopting the other judgment", async () => {
	const value = setup();
	const sharedImpacts = structuredClone(impacts);
	for (const impact of sharedImpacts.impacts) impact.sections.push("businessModel");
	value.engine.impact = async () => sharedImpacts;
	value.candidate.sections.businessModel.summary = "本轮披露收入，需求与盈利原因仍需分别核查";
	value.candidate.sections.businessModel.evidenceIds = [evidence];
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	decideAll(value, "rejected");
	const review = acceptChanges(
		value,
		(change) =>
			change.path.at(-1) === "informationCutoff" ||
			change.section === "businessModel" ||
			change.path.includes("@id:demand"),
	);
	expect(review.plan.changes.find((change) => change.section === "businessModel")?.groupId).toBe(
		"judgments:demand,margin",
	);
	expect(review.errors).toEqual([]);
	expect(review.preview?.sections.businessModel).toEqual(value.candidate.sections.businessModel);
	expect(review.preview?.sections.investmentJudgments.items[1]).toEqual(
		value.original.sections.investmentJudgments.items[1],
	);
	expect(review.preview?.sections.valuation).toEqual(value.original.sections.valuation);
	expect(review.preview?.sections.evidenceAndChanges.changes.map((change) => change.judgmentIds)).toEqual([
		["demand"],
	]);
	await publishIterationChangeReview(
		value.cwd,
		dataset,
		value.run,
		{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: true },
		AbortSignal.timeout(5000),
	);
	expect(getResearchFramework(value.cwd, dataset).versions).toHaveLength(2);
});

it("blocks actual missing judgment references while preserving independent decisions", async () => {
	const value = setup();
	value.candidate.sections.investmentJudgments.items.push({
		...structuredClone(value.candidate.sections.investmentJudgments.items[0]),
		id: "new-case",
		origin: "research",
	});
	value.candidate.sections.monitoring.rules.push({
		...structuredClone(value.candidate.sections.monitoring.rules[0]),
		id: "new-rule",
		judgmentIds: ["new-case"],
	});
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	decideAll(value, "rejected");
	let review = acceptChanges(
		value,
		(change) => change.path.at(-1) === "informationCutoff" || change.path.includes("@id:new-rule"),
	);
	expect(review.errors.join(" ")).toContain("unknown judgment ID");
	expect(review.preview).toBeNull();
	review = acceptChanges(value, (change) => change.path.includes("@id:new-case"));
	expect(review.errors).toEqual([]);
	expect(review.preview?.sections.investmentJudgments.items[0]).toEqual(
		value.original.sections.investmentJudgments.items[0],
	);
});

it("blocks ordering whose new item was rejected instead of forcing unrelated fields", async () => {
	const value = setup();
	value.candidate.sections.valuation.scenarios.unshift({
		...structuredClone(value.candidate.sections.valuation.scenarios[0]),
		id: "new-scenario",
	});
	value.run = await runFrameworkIteration(
		value.cwd,
		dataset,
		value.run.id,
		value.engine,
		async () => ({ docIds: ["new"], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	decideAll(value, "rejected");
	const review = acceptChanges(
		value,
		(change) => change.path.at(-1) === "informationCutoff" || change.path.at(-1) === "@order:id",
	);
	expect(review.errors.join(" ")).toContain("排序修改依赖");
	expect(review.preview).toBeNull();
});

it("does not publish a prepared draft built under different assembly rules", async () => {
	const value = await ready();
	const review = decideAll(value, "accepted");
	const obsolete = createResearchDraft(value.cwd, dataset, value.original, [], value.basis.id);
	withResearchDatabase(value.cwd, dataset, (db) =>
		db
			.prepare("INSERT INTO framework_iteration_review_drafts VALUES(?,?,?,?,?)")
			.run(
				review.plan.id,
				review.revision,
				obsolete.id,
				JSON.stringify(value.original),
				JSON.stringify(obsolete.inputs),
			),
	);
	await expect(
		publishIterationChangeReview(
			value.cwd,
			dataset,
			value.run,
			{ planId: review.plan.id, revision: review.revision, acknowledgeWarnings: false },
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("组装规则已变化");
	expect(getResearchFramework(value.cwd, dataset).versions).toHaveLength(1);
	expect(getIterationChangeReview(value.cwd, dataset, value.run)?.events).toEqual(review.events);
});

it("keeps change-record citations bounded and prioritizes the adopted supporting evidence", () => {
	const basis = frameworkFixture();
	basis.sections.investmentJudgments.items[0].evidenceIds = Array.from(
		{ length: 100 },
		(_, index) => `existing-${index}`,
	);
	const candidate = structuredClone(basis);
	candidate.sections.researchSetup.informationCutoff = null;
	candidate.sections.investmentJudgments.items[0].counterEvidenceIds = [evidence];
	const changes = buildIterationChanges(basis, candidate, impacts);
	const decisions = Object.fromEntries(
		changes.map((change) => [
			change.id,
			{
				decision:
					change.path.at(-1) === "informationCutoff" || change.path.at(-1) === "counterEvidenceIds"
						? ("accepted" as const)
						: ("rejected" as const),
				note: "",
				at: "",
				actorId: "reviewer",
			},
		]),
	);
	// Make this a partial review so it records the adopted fields rather than the full proposal.
	candidate.sections.evidenceAndChanges.coverageGaps = ["新的资料缺口"];
	const withGap = buildIterationChanges(basis, candidate, impacts);
	for (const change of withGap)
		decisions[change.id] ??= { decision: "rejected", note: "", at: "", actorId: "reviewer" };
	const result = assembleIterationReview(basis, candidate, impacts, facts, withGap, decisions);
	expect(result.errors).toEqual([]);
	expect(result.preview?.sections.evidenceAndChanges.changes[0].evidenceIds).toHaveLength(100);
	expect(result.preview?.sections.evidenceAndChanges.changes[0].evidenceIds[0]).toBe(evidence);
	expect(result.preview?.sections.investmentJudgments.items[0].evidenceIds).toEqual(
		basis.sections.investmentJudgments.items[0].evidenceIds,
	);
});
