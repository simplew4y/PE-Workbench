import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { registerPeDocuments } from "../src/documents.ts";
import { informationSourceConfig } from "../src/information-source-model.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
import {
	cancelFrameworkIteration,
	decideFrameworkIteration,
	getFrameworkIteration,
	listFrameworkIterations,
	runFrameworkIteration,
	setIterationTestProject,
} from "../src/research/iteration.ts";
import type { FrameworkIteration, IterationEngine, IterationObservations } from "../src/research/iteration-model.ts";
import * as modelUpdate from "../src/research/iteration-model-update.ts";
import { isFrameworkDocument, ResearchError } from "../src/research/model.ts";
import {
	getResearchMonitor,
	type MonitorConfig,
	requestResearchMonitorRun,
	runResearchMonitor,
	saveResearchMonitor,
} from "../src/research/monitor.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const dataset = "dataset_monitor_iteration";
const roots: string[] = [];
const config: MonitorConfig = {
	pipeline: "iteration",
	runtime: "server",
	modelId: "server-test",
	enabled: true,
	mode: "review",
	intervalHours: 24,
	objective: "验证新增财报",
	queries: [],
	includeMemos: false,
};
const legacy = {
	generate: vi.fn(async () => {
		throw new Error("Legacy generation must not run");
	}),
};
const oldFetch = vi.fn(async () => {
	throw new Error("Legacy source collection must not run");
});

function setup(hasDocument = true, plan = config) {
	const cwd = mkdtempSync(join(tmpdir(), "pe-monitor-iteration-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId: dataset, name: "Monitor" });
	const content = frameworkFixture();
	const draft = createResearchDraft(cwd, dataset, content, [], null);
	publishResearchDraft(cwd, dataset, {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "initial",
	});
	setIterationTestProject(cwd, dataset, true);
	if (hasDocument) addDocument(cwd, "new");
	saveResearchMonitor(cwd, dataset, plan, 0);
	return cwd;
}

function addDocument(cwd: string, id: string) {
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES(?,?,?, ?,?,'pdf','completed','before','before')",
		).run(id, dataset, `${id}.pdf`, `${id}.pdf`, id);
		db.prepare(
			"INSERT INTO pdf_pages VALUES(?,?,1,'二季度收入9亿元','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
		).run(`page-${id}`, id);
	});
}

function engine(substantive = false): IterationEngine {
	return {
		async extract(run) {
			const observations: IterationObservations = {
				observations: run.newDocIds.map((docId) => ({
					id: `revenue-${docId}`,
					docId,
					subject: "公司",
					metric: "季度收入",
					value: 9,
					period: "二季度",
					unit: "亿元",
					role: "fact",
					quote: "二季度收入9亿元",
					evidenceIds: [sourceId({ docId, location: { kind: "pdf", pageStart: 1, pageEnd: 1 } })],
					gaps: [],
					context: {
						periodKind: "single",
						asOf: null,
						scope: "公司",
						basisQuote: "二季度收入9亿元",
						eventKind: "none",
						reviewReasons: [],
					},
				})),
				coverage: run.newDocIds.map((docId) => ({ docId, readLocations: ["page 1"], gaps: [] })),
			};
			return observations;
		},
		async impact(_run, _basis, observations) {
			return {
				substantive,
				summary: "核对收入",
				impacts: substantive
					? [
							{
								judgmentIds: ["demand"],
								sections: ["investmentJudgments"],
								observationIds: observations.observations.map((value) => value.id),
								relation: "weakens",
								comparable: true,
								comparisonBasis: { period: "二季度", periodKind: "single", scope: "公司" },
								reason: "收入实际低于预测",
								proposedChange: "需求仍待核验",
								evidenceIds: observations.observations.flatMap((value) => value.evidenceIds),
							},
						]
					: [],
				gaps: [],
			};
		},
		async revise(_run, basis, observations) {
			const candidate = structuredClone(basis);
			const judgment = candidate.sections.investmentJudgments.items[0];
			const before = judgment.claim;
			judgment.claim = "需求增长尚未验证，收入低于预测";
			judgment.evidenceIds = observations.observations.flatMap((value) => value.evidenceIds);
			candidate.sections.evidenceAndChanges.changes.push({
				judgmentIds: [judgment.id],
				before,
				after: judgment.claim,
				reason: "新增财报披露收入",
				evidenceIds: judgment.evidenceIds,
			});
			return candidate;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

it("requires explicit server runtime and review without silently dropping legacy settings", () => {
	const cwd = setup();
	for (const invalid of [
		{ mode: "auto" },
		{ runtime: undefined },
		{ modelId: " " },
		{ includeMemos: true },
		{ queries: [{ category: "news", query: "news" }] },
		{ pipeline: "unknown" },
	])
		expect(() => saveResearchMonitor(cwd, dataset, { ...config, ...invalid }, 1)).toThrow();
	expect(getResearchMonitor(cwd, dataset).config).toEqual(config);
});

it("routes ready official documents to one structured iteration and never auto publishes even in a test project", async () => {
	const cwd = setup();
	const factory = vi.fn(async () => engine(true));
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(true);
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run).toMatchObject({ pipeline: "iteration", status: "review_required" });
	const iteration = getFrameworkIteration(cwd, dataset, run.iterationId!);
	expect(iteration).toMatchObject({
		requestId: run.id,
		modelId: config.modelId,
		automatic: false,
		changeReview: true,
		newDocIds: ["new"],
	});
	expect(run.draftId).toBe(iteration.draftId);
	expect(modelUpdate.getIterationModelUpdateResult(cwd, dataset, iteration.id)?.status).toBe("not_configured");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	requestResearchMonitorRun(cwd, dataset);
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(getResearchMonitor(cwd, dataset).runs).toHaveLength(1);
	expect(listFrameworkIterations(cwd, dataset)).toHaveLength(1);
	expect(legacy.generate).not.toHaveBeenCalled();
	expect(oldFetch).not.toHaveBeenCalled();
});

it("records model delivery failures without changing the framework review result", async () => {
	const cwd = setup();
	vi.spyOn(modelUpdate, "freezeIterationModelBaseline").mockImplementation(() => {
		throw new Error("freeze unavailable");
	});
	vi.spyOn(modelUpdate, "executeIterationModelUpdate").mockRejectedValue(new Error("recalculator unavailable"));
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => engine(true));
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("review_required");
	expect(run.events.filter((event) => event.stage === "model").map((event) => event.detail)).toEqual([
		"freeze unavailable",
		"recalculator unavailable",
	]);
	expect(getFrameworkIteration(cwd, dataset, run.iterationId!).status).toBe("review_required");
});

it("blocks missing server authentication once, preserves ingest for manual resume and never falls back to local credentials", async () => {
	const cwd = setup();
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000));
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("blocked");
	expect(run.error).toContain("不会借用");
	const iteration = getFrameworkIteration(cwd, dataset, run.iterationId!);
	expect(iteration.artifacts.map((artifact) => artifact.stage)).toEqual(["ingest"]);
	requestResearchMonitorRun(cwd, dataset);
	const factory = vi.fn(async () => engine());
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
	expect(factory).not.toHaveBeenCalled();
	await runFrameworkIteration(
		cwd,
		dataset,
		iteration.id,
		engine(),
		async () => {
			throw new Error("Ingest must reuse its checkpoint");
		},
		AbortSignal.timeout(5000),
	);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(getResearchMonitor(cwd, dataset).runs.find((value) => value.id === run.id)?.status).toBe("no_change");
	expect(factory).not.toHaveBeenCalled();
});

it("skips consumed documents and picks up a later ingest trigger", async () => {
	const cwd = setup();
	const factory = vi.fn(async () => engine());
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(factory).toHaveBeenCalledTimes(1);
	addDocument(cwd, "later");
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(factory).toHaveBeenCalledTimes(2);
	expect(listFrameworkIterations(cwd, dataset)[0].newDocIds).toEqual(["later"]);
});

it.each(["no_change", "rejected"] as const)(
	"keeps %s evidence consumed across interval edits and disable/enable",
	async (status) => {
		const cwd = setup();
		const factory = vi.fn(async () => engine(status === "rejected"));
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		const first = getResearchMonitor(cwd, dataset).runs[0];
		if (status === "rejected") {
			await decideFrameworkIteration(cwd, dataset, first.iterationId!, false, AbortSignal.timeout(5000));
		}
		expect(getFrameworkIteration(cwd, dataset, first.iterationId!).status).toBe(status);
		expect(getResearchFramework(cwd, dataset).versions[0].inputs).toEqual([]);
		saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 12 }, 1);
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		expect(factory).toHaveBeenCalledTimes(1);
		saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 12, enabled: false }, 2);
		expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
		saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 12 }, 3);
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(listFrameworkIterations(cwd, dataset)).toHaveLength(1);
		saveResearchMonitor(cwd, dataset, config, 4, { reprocess: true });
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(listFrameworkIterations(cwd, dataset)).toHaveLength(2);
	},
);

it("does not reuse incompatible consumption cursors when switching between legacy and iteration pipelines", async () => {
	const legacyConfig: MonitorConfig = {
		enabled: true,
		mode: "review",
		intervalHours: 24,
		objective: config.objective,
		queries: [],
		includeMemos: false,
	};
	const cwd = setup(true, legacyConfig);
	const legacyEngine = { generate: vi.fn(async () => frameworkFixture()) };
	const cursor = () =>
		withResearchDatabase(cwd, dataset, (db) =>
			String(
				db.prepare("SELECT cursor_json FROM research_monitor_plans WHERE dataset_id=?").get(dataset)?.cursor_json,
			),
		);
	await runResearchMonitor(cwd, dataset, legacyEngine, AbortSignal.timeout(5000), oldFetch);
	expect(Array.isArray(JSON.parse(cursor()))).toBe(false);
	saveResearchMonitor(cwd, dataset, { ...legacyConfig, intervalHours: 12 }, 1);
	await runResearchMonitor(cwd, dataset, legacyEngine, AbortSignal.timeout(5000), oldFetch);
	expect(legacyEngine.generate).toHaveBeenCalledTimes(1);
	saveResearchMonitor(cwd, dataset, config, 2);
	expect(cursor()).toBe("");
	const factory = vi.fn(async () => engine());
	await runResearchMonitor(cwd, dataset, legacyEngine, AbortSignal.timeout(5000), oldFetch, factory);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(Array.isArray(JSON.parse(cursor()))).toBe(true);
	saveResearchMonitor(cwd, dataset, legacyConfig, 3);
	expect(cursor()).toBe("");
	await runResearchMonitor(cwd, dataset, legacyEngine, AbortSignal.timeout(5000), oldFetch);
	expect(legacyEngine.generate).toHaveBeenCalledTimes(2);
});

it.each([
	{ status: "no_change", edit: "interval" },
	{ status: "rejected", edit: "interval" },
	{ status: "no_change", edit: "pause" },
	{ status: "rejected", edit: "pause" },
	{ status: "no_change", edit: "reprocess" },
	{ status: "no_change", edit: "pipeline" },
])(
	"consumes a blocked run resumed to $status across $edit without undoing explicit resets",
	async ({ status, edit }) => {
		const cwd = setup();
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000));
		const first = getResearchMonitor(cwd, dataset).runs[0];
		expect(first.status).toBe("blocked");
		if (edit === "pipeline") {
			saveResearchMonitor(
				cwd,
				dataset,
				{
					enabled: false,
					mode: "review",
					intervalHours: 12,
					objective: config.objective,
					queries: [],
					includeMemos: false,
				},
				1,
			);
			saveResearchMonitor(cwd, dataset, config, 2);
		} else {
			saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 12, enabled: edit !== "pause" }, 1, {
				reprocess: edit === "reprocess",
			});
			if (edit === "pause") saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 12 }, 2);
		}
		const resumed = await runFrameworkIteration(
			cwd,
			dataset,
			first.iterationId!,
			engine(status === "rejected"),
			async () => {
				throw new Error("Must reuse completed ingest");
			},
			AbortSignal.timeout(5000),
		);
		if (status === "rejected")
			await decideFrameworkIteration(cwd, dataset, resumed.id, false, AbortSignal.timeout(5000));
		expect(getFrameworkIteration(cwd, dataset, resumed.id).status).toBe(status);
		const factory = vi.fn(async () => engine());
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		requestResearchMonitorRun(cwd, dataset);
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
		expect(factory).toHaveBeenCalledTimes(["reprocess", "pipeline"].includes(edit) ? 1 : 0);
		expect(getResearchMonitor(cwd, dataset).runs.find((run) => run.id === first.id)?.status).toBe(status);
	},
);

it("preserves expired legacy monitor records without letting them deadlock an opted-in plan", async () => {
	const cwd = setup();
	withResearchDatabase(cwd, dataset, (db) =>
		db.prepare("INSERT INTO research_monitor_runs VALUES(?,?,0,'running',0,?,?)").run(
			"legacy-interrupted",
			dataset,
			JSON.stringify({
				id: "legacy-interrupted",
				status: "running",
				startedAt: "before",
				finishedAt: null,
				events: [],
			}),
			"before",
		),
	);
	expect(
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => engine()),
	).toBe(true);
	expect(getResearchMonitor(cwd, dataset).runs.find((run) => run.id === "legacy-interrupted")?.status).toBe(
		"interrupted",
	);
	expect(listFrameworkIterations(cwd, dataset)).toHaveLength(1);
});

it("reconciles a rejection into monitor history and does not charge again for the rejected evidence", async () => {
	const cwd = setup();
	const factory = vi.fn(async () => engine(true));
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	const run = getResearchMonitor(cwd, dataset).runs[0];
	await decideFrameworkIteration(cwd, dataset, run.iterationId!, false, AbortSignal.timeout(5000));
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(getResearchMonitor(cwd, dataset).runs.find((value) => value.id === run.id)?.status).toBe("rejected");
	expect(factory).toHaveBeenCalledTimes(1);
});

it("recovers a lost link after a crash using the monitor requestId without replaying the iteration", async () => {
	const cwd = setup();
	const factory = vi.fn(async () => engine(true));
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	const run = getResearchMonitor(cwd, dataset).runs[0];
	withResearchDatabase(cwd, dataset, (db) =>
		db
			.prepare(
				"UPDATE research_monitor_runs SET status='running',lease_until=0,result_json=json_remove(json_set(result_json,'$.status','running'),'$.iterationId') WHERE run_id=?",
			)
			.run(run.id),
	);
	requestResearchMonitorRun(cwd, dataset);
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
	expect(getResearchMonitor(cwd, dataset).runs[0]).toMatchObject({
		id: run.id,
		status: "review_required",
		iterationId: run.iterationId,
	});
	expect(factory).toHaveBeenCalledTimes(1);
});

it("fences concurrent claims and a configuration pause before invoking a costly engine", async () => {
	const cwd = setup();
	const factory = vi.fn(async () => {
		expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
		saveResearchMonitor(cwd, dataset, { ...config, enabled: false }, 1);
		return {
			...engine(),
			extract: async () => {
				throw new Error("must not be invoked");
			},
		};
	});
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(getResearchMonitor(cwd, dataset).runs[0]).toMatchObject({
		status: "blocked",
		error: expect.stringContaining("paused"),
	});
	expect(factory).toHaveBeenCalledTimes(1);
});

it("prefers ready filings over source collection and uses sources on a subsequent scheduled round", async () => {
	const cwd = setup(true, {
		...config,
		sourceConfig: informationSourceConfig("测试公司", "000001.SZ", ["wind-financials"]),
	});
	const collect = vi.fn(async () => {
		throw new ResearchError(409, "source unavailable");
	});
	const factory = vi.fn(async () => ({ ...engine(), collect }));
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	expect(collect).not.toHaveBeenCalled();
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory);
	const run = listFrameworkIterations(cwd, dataset)[0];
	expect(run).toMatchObject({ sourceMode: "sources", status: "blocked", changeReview: true, automatic: false });
	expect(collect).toHaveBeenCalledTimes(1);
	requestResearchMonitorRun(cwd, dataset);
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, factory)).toBe(false);
	expect(collect).toHaveBeenCalledTimes(1);
	cancelFrameworkIteration(cwd, dataset, run.id);
});

it.each([false, true])(
	"direct updates use the saved framework, including legacy format %s, without resaving",
	async (legacyFormat) => {
		const cwd = setup(true, { ...config, mode: "auto", updatePolicy: "direct", intervalHours: 168 });
		setIterationTestProject(cwd, dataset, false);
		const original = getResearchFramework(cwd, dataset).versions[0];
		if (legacyFormat) {
			const content = frameworkFixture();
			const saved = {
				title: content.title,
				objective: content.sections.researchSetup.objective,
				horizon: content.sections.researchSetup.horizon,
				items: content.sections.investmentJudgments.items.map(
					({
						counterEvidenceIds: _counter,
						confidence: _confidence,
						alternativeExplanations: _alternatives,
						...item
					}) => item,
				),
				coverageGaps: [],
			};
			withResearchDatabase(cwd, dataset, (db) => {
				db.prepare("INSERT INTO research_versions VALUES('saved-legacy',?,2,?,?,?,?,'old-save','{}')").run(
					dataset,
					original.id,
					JSON.stringify(saved),
					"[]",
					original.createdAt,
				);
				db.prepare("UPDATE research_frameworks SET current_version_id='saved-legacy' WHERE dataset_id=?").run(
					dataset,
				);
			});
		}
		await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => engine(true));
		const run = getResearchMonitor(cwd, dataset).runs[0];
		expect(run.status).toBe("published");
		expect(run.changes?.[0]).toMatchObject({
			before: expect.any(String),
			after: expect.any(String),
			reason: "新增财报披露收入",
		});
		const framework = getResearchFramework(cwd, dataset);
		expect(framework.versions).toHaveLength(legacyFormat ? 3 : 2);
		if (legacyFormat) {
			expect(framework.versions[0].parentVersionId).toBe("saved-legacy");
			expect(framework.versions.find((version) => version.id === "saved-legacy")?.content).not.toHaveProperty(
				"sections",
			);
		}
		const content = framework.versions[0].content;
		expect(isFrameworkDocument(content)).toBe(true);
		if (!isFrameworkDocument(content)) throw new Error("Expected complete framework");
		expect(Object.keys(content.sections)).toHaveLength(7);
	},
);

it("manual direct updates run once while weekly scheduling stays disabled, combining project files and Wind", async () => {
	const cwd = setup(true, {
		...config,
		enabled: false,
		mode: "auto",
		updatePolicy: "direct",
		sourceConfig: informationSourceConfig("测试公司", "000001.SZ", ["wind-financials"]),
	});
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch)).toBe(false);
	requestResearchMonitorRun(cwd, dataset);
	requestResearchMonitorRun(cwd, dataset);
	const collect = vi.fn(async (run: FrameworkIteration) => {
		expect(run.inputs.map((input) => input.docId)).toContain("new");
		addDocument(cwd, "wind");
		return { docIds: ["wind"], warnings: [], coverage: "complete" as const, summary: "已获取" };
	});
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => ({
		...engine(true),
		collect,
	}));
	const state = getResearchMonitor(cwd, dataset);
	expect(state.config?.enabled).toBe(false);
	expect(state.manualRequested).toBe(false);
	expect(state.runs[0].status).toBe("published");
	expect(getFrameworkIteration(cwd, dataset, state.runs[0].iterationId!).newDocIds).toEqual(["new", "wind"]);
	expect(collect).toHaveBeenCalledOnce();
	expect(await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch)).toBe(false);
});

it("a failed model adoption is visible without losing the published framework or allowing overlapping runs", async () => {
	const cwd = setup(true, { ...config, mode: "auto", updatePolicy: "direct" });
	vi.spyOn(modelUpdate, "executeIterationModelUpdate").mockResolvedValue({
		status: "candidate",
		configRevision: 1,
	} as modelUpdate.IterationModelUpdateResult);
	vi.spyOn(modelUpdate, "promoteIterationModelUpdate").mockImplementation(() => {
		throw new Error("模型重算结果有问题");
	});
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => engine(true));
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("published");
	expect(run.events).toContainEqual(
		expect.objectContaining({ stage: "model", status: "unavailable", detail: "模型重算结果有问题" }),
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
});

it("new project documents remain usable when Wind returns no data", async () => {
	const cwd = setup(true, {
		...config,
		mode: "auto",
		updatePolicy: "direct",
		sourceConfig: informationSourceConfig("测试公司", "000001.SZ", ["wind-financials"]),
	});
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(5000), oldFetch, async () => ({
		...engine(true),
		collect: async () => ({
			docIds: [],
			warnings: ["Wind未返回数据，相关字段仍待核实"],
			coverage: "empty",
			summary: "没有返回值",
		}),
	}));
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("published");
	expect(getFrameworkIteration(cwd, dataset, run.iterationId!).reviewReasons.join()).toContain("Wind未返回数据");
});

it("automatically identifies the workbook, valuation date and model inputs before requesting Wind", async () => {
	const cwd = setup(false, {
		...config,
		mode: "auto",
		enabled: false,
		updatePolicy: "direct",
		automaticSetup: true,
		company: { name: "测试公司", ticker: "000001.SZ" },
	});
	mkdirSync(join(cwd, "raw"));
	const doc = registerPeDocuments(cwd, dataset, [
		{ name: "model.xlsx", bytes: readFileSync(new URL("./fixtures/excel-parity.xlsx", import.meta.url)) },
	]).documents[0];
	withResearchDatabase(cwd, dataset, (db) =>
		db.prepare("UPDATE documents SET status='completed' WHERE doc_id=?").run(doc.doc_id),
	);
	const prepare = vi.fn<NonNullable<IterationEngine["prepare"]>>(async () => ({
		companyName: "测试公司",
		companyTicker: "000001.SZ",
		valuationDate: "2026-08-31",
		summary: "已从模型原文识别估值日期与现金流输入。",
		dateSource: { sheet: "Valuation", cell: "B1", text: "2026-08-31T00:00:00" },
		dateLabelSource: { sheet: "Valuation", cell: "A1", text: "Valuation Date" },
		identitySources: [],
		model: {
			expectedRevision: 0,
			docId: String(doc.doc_id),
			baseVersionId: null,
			valuationDate: "2026-08-31",
			mappings: [
				{
					id: "cash-flow",
					subject: "测试公司",
					metric: "Free cash flow",
					period: "2026Q3",
					periodKind: "single",
					asOf: null,
					unit: "CNY",
					scope: "公司",
					currency: "CNY",
					role: "actual",
					sheet: "DCF",
					cell: "B2",
					expectedValue: 100,
					judgmentIds: ["demand"],
					sensitivity: "现金流影响每股估值",
				},
			],
			outputs: [{ key: "每股价值", sheet: "DCF", cell: "B7" }],
		},
	}));
	const collect = vi.fn(async (run: FrameworkIteration) => {
		expect(run.sourceConfig?.trackingWindow?.valuationDate).toBe("2026-08-31");
		expect(run.sourceConfig?.defaultPeriods).toContain("2026年第四季度");
		expect(modelUpdate.getIterationModelConfig(cwd, dataset)?.mappings[0].cell).toBe("B2");
		return { docIds: [], warnings: ["本次没有新数据"], coverage: "empty" as const, summary: "没有新数据" };
	});
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, legacy, AbortSignal.timeout(10_000), oldFetch, async () => ({
		...engine(),
		prepare,
		collect,
		extract: async (run) => ({
			observations: [],
			coverage: run.newDocIds.map((docId) => ({ docId, readLocations: ["模型输入"], gaps: [] })),
		}),
	}));
	expect(prepare).toHaveBeenCalledOnce();
	expect(collect).toHaveBeenCalledOnce();
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status, run.error).toBe("no_change");
	expect(modelUpdate.freezeIterationModelBaseline(cwd, dataset, run.iterationId!).error).toBeNull();
});
