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
	candidate.sections.currentAssessment.summary = "汽车等分部经营亏损0.5亿元";
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).toThrow("金额单位不符");
	candidate.sections.currentAssessment.summary = "汽车等分部经营亏损5亿元";
	expect(() => validateIterationRevision(basis, candidate, impacts, facts)).not.toThrow();
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
