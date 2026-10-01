import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
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
	validateIterationRevision,
} from "../src/research/iteration.ts";
import {
	observationReviewReasons,
	validateLinkedObservationText,
	validateObservationContext,
} from "../src/research/iteration-quality.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const roots: string[] = [];
const dataset = "dataset_test";
const evidence = sourceId({ docId: "new", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
const observations: IterationObservations = {
	observations: [
		{
			id: "revenue",
			docId: "new",
			subject: "公司",
			metric: "季度收入",
			value: 9,
			period: "二季度",
			unit: "亿元",
			role: "fact",
			quote: "二季度收入9亿元",
			evidenceIds: [evidence],
			gaps: ["未披露销量"],
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
	summary: "收入低于原假设，销量原因未知",
	impacts: [
		{
			judgmentIds: ["demand"],
			sections: ["investmentJudgments"],
			observationIds: ["revenue"],
			relation: "weakens",
			comparable: true,
			comparisonBasis: { period: "二季度", periodKind: "single", scope: "公司" },
			reason: "收入实际低于预测",
			proposedChange: "需求仍待核验",
			evidenceIds: [evidence],
		},
	],
	gaps: ["需要销量和价格数据"],
};
function setup(automatic = true) {
	const cwd = mkdtempSync(join(tmpdir(), "pe-iteration-test-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId: dataset, name: "Test" });
	const content = frameworkFixture();
	const draft = createResearchDraft(cwd, dataset, content, [], null);
	const basis = publishResearchDraft(cwd, dataset, {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "first",
	});
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new',?,'report.pdf','report.pdf','new','pdf','completed','before','before')",
		).run(dataset);
		db.exec(
			"INSERT INTO pdf_pages VALUES('page','new',1,'二季度收入9亿元','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
		);
	});
	if (automatic) setIterationTestProject(cwd, dataset, true);
	const request = { requestId: "run", basisVersionId: basis.id, modelId: "platform-test", uploadIdentity: "sha256" };
	const run = createFrameworkIteration(cwd, dataset, request);
	const candidate = structuredClone(content);
	candidate.sections.researchSetup.informationCutoff = null;
	candidate.sections.investmentJudgments.items[0].claim = "需求增长尚未验证，收入低于预测";
	candidate.sections.investmentJudgments.items[0].evidenceIds = [evidence];
	candidate.sections.evidenceAndChanges.changes.push({
		judgmentIds: ["demand"],
		before: content.sections.investmentJudgments.items[0].claim,
		after: candidate.sections.investmentJudgments.items[0].claim,
		reason: "新增财报披露收入",
		evidenceIds: [evidence],
	});
	const engine: IterationEngine = {
		async extract() {
			return observations;
		},
		async impact() {
			return impacts;
		},
		async revise() {
			return candidate;
		},
	};
	return { cwd, run, engine, request, basis, candidate };
}
const ingest = async () => ({ docIds: ["new"], warnings: [] });
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("publishes a complete evidenced revision in a registered test project and deduplicates requests", async () => {
	const { cwd, run, engine, request, candidate } = setup();
	expect(createFrameworkIteration(cwd, dataset, request).id).toBe(run.id);
	expect(() => createFrameworkIteration(cwd, dataset, { ...request, uploadIdentity: "other" })).toThrow(
		"different input",
	);
	const completed = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(completed.status).toBe("published");
	expect(getResearchFramework(cwd, dataset).versions[0].content).toEqual(candidate);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
});
it("keeps ordinary projects as drafts and confirms without duplicate publication", async () => {
	const { cwd, run, engine } = setup(false);
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"review_required",
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	const published = await decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000));
	expect((await decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000))).versionId).toBe(
		published.versionId,
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
});
it("does not revise or publish unrelated observations", async () => {
	const { cwd, run, engine } = setup();
	engine.impact = async () => ({ ...impacts, substantive: false, impacts: [] });
	engine.revise = async () => {
		throw new Error("must not revise");
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"no_change",
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});
it("resumes a failed impact stage without extracting again and preserves immutable artifacts", async () => {
	const { cwd, run, engine } = setup();
	const original = engine.impact;
	engine.impact = async () => {
		throw new Error("model unavailable");
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"failed",
	);
	engine.extract = async () => {
		throw new Error("must reuse extraction");
	};
	engine.impact = original;
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"published",
	);
	withResearchDatabase(cwd, dataset, (db) => {
		expect(() => db.exec("UPDATE framework_iteration_artifacts SET artifact_json='{}'")).toThrow("immutable");
		expect(() => db.exec("DELETE FROM framework_iteration_artifacts")).toThrow("immutable");
	});
});

it("preserves an invalid saved candidate and regenerates revision from the last valid checkpoint", async () => {
	const { cwd, run, engine, candidate } = setup();
	engine.impact = async () => {
		throw new Error("interrupted");
	};
	await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	const invalid = structuredClone(candidate);
	invalid.sections.evidenceAndChanges.sources.push({
		evidenceId: "source:invalid",
		description: "Invalid old candidate",
		quality: "unknown",
		limitations: "unknown",
	});
	const rejectedArtifact = { stage: "revise", value: invalid, at: new Date().toISOString() };
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare("INSERT INTO framework_iteration_artifacts VALUES(?,?,?)").run(
			run.id,
			"impact",
			JSON.stringify({ stage: "impact", value: impacts, at: new Date().toISOString() }),
		);
		db.prepare("INSERT INTO framework_iteration_artifacts VALUES(?,?,?)").run(
			run.id,
			"revise",
			JSON.stringify(rejectedArtifact),
		);
	});
	engine.extract = async () => {
		throw new Error("must reuse extraction");
	};
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("published");
	expect(result.invalidArtifacts).toHaveLength(1);
	expect(result.invalidArtifacts[0].value).toEqual(invalid);
	expect(result.artifacts.find((a) => a.stage === "revise")?.value).toEqual(candidate);
	withResearchDatabase(cwd, dataset, (db) => {
		expect(
			db
				.prepare("SELECT artifact_json FROM framework_iteration_artifacts WHERE run_id=? AND stage='revise'")
				.get(run.id)?.artifact_json,
		).toBe(JSON.stringify(rejectedArtifact));
		expect(() => db.exec("DELETE FROM framework_iteration_artifact_attempts")).toThrow("immutable");
	});
});
it("cancellation fences a late result", async () => {
	const { cwd, run, engine } = setup();
	engine.impact = async () => {
		cancelFrameworkIteration(cwd, dataset, run.id);
		return impacts;
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"cancelled",
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	withResearchDatabase(cwd, dataset, (db) => {
		expect(db.prepare("SELECT status FROM framework_iteration_attempts WHERE run_id=?").get(run.id)?.status).toBe(
			"cancelled",
		);
		expect(
			db
				.prepare("SELECT status FROM framework_iteration_stage_attempts WHERE run_id=? AND stage='impact'")
				.get(run.id)?.status,
		).toBe("cancelled");
	});
});

it("rejects contradictory no-change results instead of discarding a proposed revision", async () => {
	const { cwd, run, engine } = setup();
	engine.impact = async () => ({ ...impacts, substantive: false });
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("failed");
	expect(result.error).toContain("无实质变化");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("rejects copying a billion amount into an incompatible yuan unit", () => {
	const { candidate } = setup();
	const basis = frameworkFixture();
	const facts: IterationObservations = {
		...observations,
		observations: [{ ...observations.observations[0], value: 0.5, unit: "十亿元", quote: "loss was RMB0.5 billion" }],
	};
	candidate.sections.currentAssessment.evidenceIds = [evidence];
	candidate.sections.currentAssessment.summary = "汽车等分部经营亏损0.5亿元";
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).toThrow("金额单位不符");
	candidate.sections.currentAssessment.summary = "汽车等分部经营亏损5亿元";
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).not.toThrow();
	candidate.sections.evidenceAndChanges.sources.push({
		evidenceId: evidence,
		description: "经营亏损0.5亿元",
		quality: "official",
		limitations: "合并分部",
	});
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).toThrow("金额单位不符");
});
it("rejects a competing baseline and changed evidence", async () => {
	const { cwd, run, engine, basis } = setup();
	engine.impact = async () => {
		const draft = createResearchDraft(cwd, dataset, frameworkFixture({ title: "人工更新" }), [], basis.id);
		publishResearchDraft(cwd, dataset, {
			draftId: draft.id,
			revision: 1,
			expectedVersionId: basis.id,
			requestId: "human",
		});
		return impacts;
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"blocked",
	);
	expect(getResearchFramework(cwd, dataset).versions[0].content.title).toBe("人工更新");
	expect(() => getFrameworkIteration(cwd, "other", run.id)).toThrow();
});
it("blocks failed parsing and invalid evidence without publishing", async () => {
	const { cwd, run, engine } = setup();
	engine.extract = async () => ({
		...observations,
		observations: [{ ...observations.observations[0], evidenceIds: ["source:invalid"] }],
	});
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"failed",
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});
it("reclaims an expired lease and cannot change test mode during an active run", () => {
	const { cwd, run } = setup();
	expect(() => setIterationTestProject(cwd, dataset, false)).toThrow("结束");
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare("UPDATE framework_iterations SET status='running',lease_until=0 WHERE id=?").run(run.id);
	});
	expect(getFrameworkIteration(cwd, dataset, run.id).status).toBe("blocked");
});

it("preserves the baseline after parsing failure", async () => {
	const { cwd, run, engine } = setup();
	const result = await runFrameworkIteration(
		cwd,
		dataset,
		run.id,
		engine,
		async () => {
			throw new Error("parser failed");
		},
		AbortSignal.timeout(5000),
	);
	expect(result.status).toBe("failed");
	expect(result.artifacts).toHaveLength(0);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});
it("rejects fabricated original quotes", async () => {
	const { cwd, run, engine } = setup();
	engine.extract = async () => ({
		...observations,
		observations: [{ ...observations.observations[0], quote: "二季度收入99亿元" }],
	});
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("failed");
	expect(result.error).toContain("原文引述");
});
it("blocks evidence mutation between stages", async () => {
	const { cwd, run, engine } = setup();
	engine.impact = async () => {
		withResearchDatabase(cwd, dataset, (db) => db.exec("UPDATE documents SET updated_at='after' WHERE doc_id='new'"));
		return impacts;
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"blocked",
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});
it("rejects a pending draft and fences later acceptance", async () => {
	const { cwd, run, engine } = setup(false);
	await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect((await decideFrameworkIteration(cwd, dataset, run.id, false, AbortSignal.timeout(5000))).status).toBe(
		"rejected",
	);
	await expect(decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000))).rejects.toThrow(
		"待确认",
	);
});

it("keeps the renewed lease through a stage checkpoint after sixty seconds", async () => {
	const { cwd, run, engine } = setup();
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	engine.extract = async () => {
		await vi.advanceTimersByTimeAsync(70_000);
		return observations;
	};
	engine.impact = async () => {
		expect(getFrameworkIteration(cwd, dataset, run.id).leaseUntil).toBeGreaterThan(Date.now());
		return impacts;
	};
	expect((await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000))).status).toBe(
		"published",
	);
});

it.each([
	{ quote: "累计交付258000辆", periodKind: "single" as const, asOf: null, period: "2025Q1", error: "累计口径" },
	{ quote: "累计交付258000辆", periodKind: "cumulative" as const, asOf: null, period: "2025Q1", error: "截至日期" },
	{
		quote: "累计交付258000辆",
		periodKind: "cumulative" as const,
		asOf: "2025-05-21",
		period: "2025Q1",
		error: "单季度",
	},
])("rejects cumulative delivery with incorrect period: $error", ({ quote, periodKind, asOf, period, error }) => {
	const observation = structuredClone(observations.observations[0]);
	Object.assign(observation, { value: 258000, quote, period, unit: "辆" });
	Object.assign(observation.context, { periodKind, asOf, basisQuote: quote });
	expect(() => validateObservationContext(observation)).toThrow(error);
});

it.each([
	{ quote: "2025E预测PE为25倍", metric: "PE", role: "fact" as const, error: "预测不能" },
	{ quote: "截至期末现有门店25家", metric: "门店", role: "guidance" as const, error: "门店数量" },
	{ quote: "premium smartphone units sold 25%", metric: "高端手机出货占比", role: "fact" as const, error: "销量不能" },
])("rejects unsupported interpretation: $error", ({ quote, metric, role, error }) => {
	const observation = structuredClone(observations.observations[0]);
	Object.assign(observation, { value: 25, quote, metric, role });
	observation.context.basisQuote = quote;
	expect(() => validateObservationContext(observation)).toThrow(error);
});

it("rejects a unit mismatch hidden in extraction gaps", () => {
	const observation = structuredClone(observations.observations[0]);
	Object.assign(observation, {
		value: 18.1,
		quote: "EV revenue RMB18.1 billion",
		unit: "billion",
		gaps: ["EV收入18.1百万元"],
	});
	observation.context.basisQuote = observation.quote;
	expect(() => validateObservationContext(observation)).toThrow("金额单位不符");
	observation.gaps = ["EV收入181亿元，独立盈亏未披露"];
	expect(() => validateObservationContext(observation)).not.toThrow();
	observation.unit = "百万元";
	expect(() => validateObservationContext(observation)).toThrow("原始金额单位");
});

it("does not confuse an unrelated amount with the same numeric value", () => {
	const { candidate } = setup();
	const facts = structuredClone(observations);
	Object.assign(facts.observations[0], { value: 0.5, unit: "billion", quote: "RMB0.5 billion" });
	candidate.sections.valuation.summary = "其他业务成本0.5亿元";
	const basis = frameworkFixture();
	basis.sections.valuation.summary = candidate.sections.valuation.summary;
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).not.toThrow();
});

it.each(["period", "scope", "periodKind"] as const)("rejects an incompatible comparison %s", async (field) => {
	const { cwd, run, engine } = setup();
	const incorrect = structuredClone(impacts);
	const comparison = incorrect.impacts[0].comparisonBasis!;
	if (field === "periodKind") comparison.periodKind = "cumulative";
	else comparison[field] = "different";
	engine.impact = async () => incorrect;
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("failed");
	expect(result.error).toContain("比较期间或口径");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("rejects a judgment proposal that omits its target section", async () => {
	const { cwd, run, engine } = setup();
	const incorrect = structuredClone(impacts);
	incorrect.impacts[0].sections = ["currentAssessment"];
	engine.impact = async () => incorrect;
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.error).toContain("investmentJudgments章节");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("rejects a revision that silently ignores its proposal", async () => {
	const { cwd, run, engine } = setup();
	engine.revise = async () => frameworkFixture();
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.error).toContain("建议未落实");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("requires review for semantic ambiguity even in a registered test project", async () => {
	const { cwd, run, engine } = setup();
	const uncertain = structuredClone(observations);
	uncertain.observations[0].context.reviewReasons = ["事件含义无法确认"];
	engine.extract = async () => uncertain;
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("review_required");
	expect(result.automatic).toBe(false);
	expect(result.reviewReasons).toContain("revenue：事件含义无法确认");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	const published = await decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000));
	expect(published.status).toBe("published");
	expect(published.reviewReasons).toEqual(result.reviewReasons);
});

it("preserves old runs but prevents publication under an obsolete processor", async () => {
	const { cwd, run, engine } = setup(false);
	await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	withResearchDatabase(cwd, dataset, (db) =>
		db
			.prepare(
				"UPDATE framework_iterations SET record_json=json_set(record_json,'$.processorVersion','1') WHERE id=?",
			)
			.run(run.id),
	);
	expect(getFrameworkIteration(cwd, dataset, run.id).status).toBe("blocked");
	await expect(decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000))).rejects.toThrow(
		"待确认",
	);
	expect(getFrameworkIteration(cwd, dataset, run.id).artifacts).toHaveLength(5);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("updates evidence scope without changing user horizon or preferences", () => {
	const { candidate } = setup();
	const basis = frameworkFixture({ objective: "只使用旧研报验证需求" });
	candidate.sections.researchSetup.objective = basis.sections.researchSetup.objective;
	expect(() => validateIterationRevision(basis, candidate, impacts, observations)).toThrow("旧资料范围");
	candidate.sections.researchSetup.objective = "结合基线研报与新增季度财报验证需求";
	expect(() => validateIterationRevision(basis, candidate, impacts, observations)).not.toThrow();
	candidate.sections.researchSetup.horizon = "十年";
	expect(() => validateIterationRevision(basis, candidate, impacts, observations)).toThrow("期限或偏好");
});

it("accepts cumulative deliveries only with an evidenced cutoff", () => {
	const observation = structuredClone(observations.observations[0]);
	Object.assign(observation, {
		value: 258000,
		quote: "累计交付258000辆，截至2025-05-21",
		period: "累计截至2025-05-21",
		unit: "辆",
	});
	Object.assign(observation.context, { periodKind: "cumulative", asOf: "2025-05-21", basisQuote: observation.quote });
	expect(() => validateObservationContext(observation)).not.toThrow();
	observation.context.asOf = "2025-06-21";
	observation.period = "累计截至2025-06-21";
	expect(() => validateObservationContext(observation)).toThrow("原文表述");
});

it("rejects a quarter label that contradicts the quoted period", () => {
	const observation = structuredClone(observations.observations[0]);
	observation.period = "2025Q1";
	expect(() => validateObservationContext(observation)).toThrow("季度期间");
});

it("rejects fabricated context even when the main quote is genuine", async () => {
	const { cwd, run, engine } = setup();
	const incorrect = structuredClone(observations);
	incorrect.observations[0].context.basisQuote = "季度收入预测9亿元";
	engine.extract = async () => incorrect;
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.error).toContain("revenue.context");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("requires event review even when the model labels launched as non-event", () => {
	const facts = structuredClone(observations);
	facts.observations[0].quote = "YU7 launched in May";
	expect(observationReviewReasons(facts).join(" ")).toContain("事件含义");
	facts.observations[0].quote = "YU7 unveiled in May";
	facts.observations[0].context.eventKind = "unveiling";
	expect(observationReviewReasons(facts).join(" ")).toContain("事件含义");
});

it("rejects incorrect units in an impact proposal", async () => {
	const { cwd, run, engine } = setup();
	const incorrect = structuredClone(impacts);
	incorrect.impacts[0].proposedChange = "季度收入9百万元";
	engine.impact = async () => incorrect;
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.error).toContain("金额单位不符");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});

it("does not turn consolidated segment losses into standalone vehicle losses", () => {
	const observation = structuredClone(observations.observations[0]);
	observation.quote = "EV, AI and other businesses operating loss";
	expect(() => validateLinkedObservationText(observation, "汽车独立亏损5亿元")).toThrow("合并分部");
	expect(() => validateLinkedObservationText(observation, "合并分部亏损5亿元，不等于汽车独立亏损")).not.toThrow();
});

it("allows correcting an old shipment claim while retaining the historical before text", () => {
	const { candidate } = setup();
	const basis = frameworkFixture();
	basis.sections.investmentJudgments.items[0].claim = "高端手机出货占比25%";
	candidate.sections.investmentJudgments.items[0].claim = "高端手机销量占比25%，不是出货占比";
	Object.assign(candidate.sections.evidenceAndChanges.changes[0], {
		before: basis.sections.investmentJudgments.items[0].claim,
		after: candidate.sections.investmentJudgments.items[0].claim,
	});
	const facts = structuredClone(observations);
	Object.assign(facts.observations[0], { value: 25, unit: "%", quote: "premium smartphone units sold 25%" });
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).not.toThrow();
});

it("regenerates a saved revision whose proposal was never applied", async () => {
	const { cwd, run, engine, candidate } = setup();
	const original = engine.impact;
	engine.impact = async () => {
		throw new Error("interrupted");
	};
	await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	const stale = { stage: "revise", value: frameworkFixture(), at: new Date().toISOString() };
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare("INSERT INTO framework_iteration_artifacts VALUES(?,?,?)").run(
			run.id,
			"impact",
			JSON.stringify({ stage: "impact", value: impacts, at: stale.at }),
		);
		db.prepare("INSERT INTO framework_iteration_artifacts VALUES(?,?,?)").run(
			run.id,
			"revise",
			JSON.stringify(stale),
		);
	});
	engine.impact = original;
	engine.extract = async () => {
		throw new Error("must reuse extraction");
	};
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("published");
	expect(result.invalidArtifacts[0].value).toEqual(stale.value);
	expect(result.artifacts.find((a) => a.stage === "revise")?.value).toEqual(candidate);
});

it("does not reuse a validated draft after its saved revision becomes invalid", async () => {
	const { cwd, run, engine, candidate } = setup(false);
	const first = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare("UPDATE framework_iterations SET status='failed' WHERE id=?").run(run.id);
		db.prepare("INSERT INTO framework_iteration_artifact_attempts VALUES(?,?,?,?)").run(
			"bad-revision",
			run.id,
			"revise",
			JSON.stringify({ stage: "revise", value: frameworkFixture(), at: "2099-01-01T00:00:00.000Z" }),
		);
	});
	const result = await runFrameworkIteration(cwd, dataset, run.id, engine, ingest, AbortSignal.timeout(5000));
	expect(result.status).toBe("review_required");
	expect(result.draftId).not.toBe(first.draftId);
	expect(result.invalidArtifacts.map((a) => a.stage)).toEqual(["revise", "validate"]);
	expect(getResearchFramework(cwd, dataset).drafts.find((d) => d.id === first.draftId)?.status).toBe("rejected");
	expect(getResearchFramework(cwd, dataset).drafts.find((d) => d.id === result.draftId)?.content).toEqual(candidate);
	const published = await decideFrameworkIteration(cwd, dataset, run.id, true, AbortSignal.timeout(5000));
	expect(published.status).toBe("published");
});
