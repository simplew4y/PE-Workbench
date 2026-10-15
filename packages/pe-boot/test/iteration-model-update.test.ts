import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as documents from "../src/documents.ts";
import { registerPeDocuments } from "../src/documents.ts";
import {
	currentModelVersionId,
	insertModelVersion,
	listModelVersionRows,
	withModelUpdateDatabase,
} from "../src/model-update-storage.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
import {
	cancelFrameworkIteration,
	createFrameworkIteration,
	getFrameworkIteration,
	runFrameworkIteration,
} from "../src/research/iteration.ts";
import type { IterationImpacts, IterationObservations } from "../src/research/iteration-model.ts";
import {
	executeIterationModelUpdate,
	freezeIterationModelBaseline,
	getIterationModelConfig,
	getIterationModelUpdateResult,
	promoteIterationModelUpdate,
	readIterationModelWorkbook,
	type SaveIterationModelConfigInput,
	saveIterationModelConfig,
} from "../src/research/iteration-model-update.ts";
import { saveResearchMonitor } from "../src/research/monitor.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { reviewAssumptionUpdates } from "../src/tools/assumption-review.ts";
import {
	type ApplyPeModelUpdateOptions,
	applyPeModelUpdate,
	type PeModelUpdateManifest,
} from "../src/tools/model-update.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const roots: string[] = [];
const dataset = "model-iteration-test";
const bytes = readFileSync(join(import.meta.dirname, "fixtures/excel-parity.xlsx"));
const evidence = sourceId({ docId: "new", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
const observations: IterationObservations = {
	observations: [
		{
			id: "revenue",
			docId: "new",
			subject: "公司",
			metric: "收入",
			value: 120,
			period: "2026Q2",
			unit: "亿元",
			role: "fact",
			quote: "2026年第二季度收入120亿元",
			evidenceIds: [evidence],
			gaps: [],
			context: {
				periodKind: "single",
				asOf: null,
				scope: "公司",
				basisQuote: "2026年第二季度收入120亿元",
				eventKind: "none",
				reviewReasons: [],
			},
		},
	],
	coverage: [{ docId: "new", readLocations: ["page 1"], gaps: [] }],
};
const impacts: IterationImpacts = {
	substantive: false,
	summary: "记录已报告实际值，不调整框架判断",
	gaps: [],
	impacts: [
		{
			judgmentIds: ["demand"],
			sections: ["investmentJudgments"],
			observationIds: ["revenue"],
			relation: "supports",
			comparable: true,
			comparisonBasis: { period: "2026Q2", periodKind: "single", scope: "公司", currency: "CNY" },
			reason: "本期实际收入120亿元",
			proposedChange: null,
			evidenceIds: [evidence],
		},
	],
};

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function setup(configured = true) {
	const cwd = mkdtempSync(join(tmpdir(), "pe-iteration-model-test-"));
	roots.push(cwd);
	for (const directory of ["raw", "meta", "generated"]) mkdirSync(join(cwd, directory));
	const docId = String(registerPeDocuments(cwd, dataset, [{ name: "model.xlsx", bytes }]).documents[0].doc_id);
	const input: SaveIterationModelConfigInput = {
		expectedRevision: 0,
		docId,
		baseVersionId: null,
		mappings: [
			{
				id: "revenue",
				subject: "公司",
				metric: "收入",
				period: "2026Q2",
				periodKind: "single",
				asOf: null,
				unit: "亿元",
				scope: "公司",
				currency: "CNY",
				role: "actual",
				sheet: "DCF",
				cell: "B2",
				expectedValue: 100,
			},
		],
		outputs: [{ key: "value", sheet: "DCF", cell: "B7" }],
		checks: [{ key: "actual", sheet: "DCF", cell: "B2", expectedValue: 120, tolerance: 0 }],
	};
	if (configured) saveIterationModelConfig(cwd, dataset, input);
	const draft = createResearchDraft(cwd, dataset, frameworkFixture(), [], null);
	const baseline = publishResearchDraft(cwd, dataset, {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "first",
	});
	withResearchDatabase(cwd, dataset, (connection) => {
		connection
			.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new',?,'report.pdf','report.pdf','new','pdf','completed','before','before')",
			)
			.run(dataset);
		connection.exec(
			"INSERT INTO pdf_pages VALUES('page','new',1,'2026年第二季度收入120亿元','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
		);
	});
	const create = () =>
		createFrameworkIteration(cwd, dataset, {
			requestId: `run_${Math.random().toString(36).slice(2)}`,
			basisVersionId: baseline.id,
			modelId: "test",
			uploadIdentity: "test",
		});
	const run = create();
	async function complete(facts = observations, effects = impacts, runId = run.id) {
		return runFrameworkIteration(
			cwd,
			dataset,
			runId,
			{
				extract: async () => facts,
				impact: async () => effects,
				revise: async () => {
					throw new Error("No revision expected");
				},
			},
			async () => ({ docIds: facts.coverage.map((entry) => entry.docId), warnings: [] }),
			AbortSignal.timeout(5000),
		);
	}
	return { cwd, input, docId, run, complete, create };
}

function receipt(cwd: string, options: ApplyPeModelUpdateOptions): PeModelUpdateManifest {
	const versionId = `request-${hash(`${options.docId}\0${options.requestId}`)}`;
	const path = `generated/model-updates/${options.docId}/${versionId}/model.xlsx`;
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), bytes);
	const review = reviewAssumptionUpdates(options.reviewItems ?? []);
	const manifest: PeModelUpdateManifest = {
		request: { id: options.requestId!, sha256: hash(JSON.stringify(options)) },
		schema_version: "1.0",
		version_id: versionId,
		dataset_id: dataset,
		doc_id: options.docId,
		parent_version_id: options.baseVersionId ?? null,
		created_at: new Date().toISOString(),
		state: review.version_state,
		approval_eligible:
			review.version_state === "candidate" &&
			review.assessments.every((entry) => entry.action === "propose_local_revision"),
		can_advance_baseline: review.can_advance_baseline,
		promoted: false,
		file: { path, sha256: hash(bytes) },
		source: { path: "raw/model.xlsx", sha256: hash(bytes), unchanged: true },
		changes: options.changes.map((change) => ({
			sheet: change.sheet,
			cell: change.cell,
			before: change.expectedValue,
			after: change.newValue,
			kind: change.kind,
			metric_id: change.metricId ?? null,
			evidence_ids: change.evidenceIds,
			reason: change.reason,
		})),
		assumption_review: review,
		validation: { recalculated: true, hard_errors: [], new_error_cells: [], checks: [] },
		outputs: { value: 210 },
		formula_cell_count: 4,
	};
	withModelUpdateDatabase(cwd, dataset, (connection) =>
		insertModelVersion(
			connection,
			{
				version_id: versionId,
				dataset_id: dataset,
				doc_id: options.docId,
				parent_version_id: options.baseVersionId ?? null,
				state: manifest.state,
				file_relpath: path,
				file_sha256: manifest.file.sha256,
				manifest_json: JSON.stringify(manifest),
				created_at: manifest.created_at,
			},
			false,
		),
	);
	return manifest;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorizeDirect(cwd: string, runId: string) {
	saveResearchMonitor(
		cwd,
		dataset,
		{
			pipeline: "iteration",
			runtime: "server",
			modelId: "test",
			updatePolicy: "direct",
			enabled: false,
			mode: "auto",
			intervalHours: 168,
			objective: "更新框架与模型",
			queries: [],
			includeMemos: false,
		},
		0,
	);
	withResearchDatabase(cwd, dataset, (db) => {
		db.prepare("INSERT INTO research_monitor_runs VALUES('direct',?,1,'running',?,?,'now')").run(
			dataset,
			Date.now() + 60_000,
			JSON.stringify({ id: "direct", status: "running", events: [] }),
		);
		db.prepare(
			"UPDATE framework_iterations SET record_json=json_set(record_json,'$.monitorRunId','direct','$.automatic',json('true')) WHERE id=?",
		).run(runId);
	});
}

it.each(["actual", "assumption"] as const)(
	"direct updates adopt a recalculated %s model and advance the mapped baseline",
	async (role) => {
		const { cwd, run, input, complete, docId } = setup(false);
		input.mappings[0].role = role;
		saveIterationModelConfig(cwd, dataset, input);
		withResearchDatabase(cwd, dataset, (db) =>
			db
				.prepare(
					"UPDATE framework_iterations SET record_json=json_set(record_json,'$.createdAt','2099-01-01T00:00:00.000Z') WHERE id=?",
				)
				.run(run.id),
		);
		authorizeDirect(cwd, run.id);
		const facts = structuredClone(observations);
		if (role === "assumption") facts.observations[0].role = "forecast";
		await complete(facts);
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, AbortSignal.timeout(10_000), {
			apply: async (root, options) => receipt(root, options),
		});
		expect(result.error).toBeNull();
		expect(result.proposal).toHaveLength(1);
		expect(result.proposal[0].kind).toBe(role);
		const adopted = promoteIterationModelUpdate(cwd, dataset, run.id, 1, "自动更新");
		expect(adopted.mappings[0].expectedValue).toBe(120);
		expect(adopted.baseVersionId).toBe(result.modelVersionId);
		expect(withModelUpdateDatabase(cwd, dataset, (db) => currentModelVersionId(db, dataset, docId))).toBe(
			result.modelVersionId,
		);
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)?.promotionReceipt?.actor).toBe("自动更新");
	},
);

it("pausing the plan during a workbook write preserves its artifact but prevents automatic adoption", async () => {
	const { cwd, run, complete } = setup();
	authorizeDirect(cwd, run.id);
	await complete();
	const result = await executeIterationModelUpdate(cwd, dataset, run.id, AbortSignal.timeout(10_000), {
		apply: async (root, options) => {
			const saved = receipt(root, options);
			saveResearchMonitor(
				cwd,
				dataset,
				{
					pipeline: "iteration",
					runtime: "server",
					modelId: "test",
					updatePolicy: "direct",
					enabled: false,
					mode: "auto",
					intervalHours: 168,
					objective: "暂停",
					queries: [],
					includeMemos: false,
				},
				1,
			);
			return saved;
		},
	});
	expect(result.status).toBe("unavailable");
	expect(result.modelVersionId).toBeTruthy();
	expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "自动更新")).toThrow();
	expect(getIterationModelConfig(cwd, dataset)?.baseVersionId).toBeNull();
});

describe("iteration model baseline configuration", () => {
	it("registers a typed baseline with optimistic revision and project isolation", () => {
		const { cwd, input } = setup();
		expect(getIterationModelConfig(cwd, dataset)).toMatchObject({
			revision: 1,
			documentSha256: hash(bytes),
			baselineSha256: hash(bytes),
		});
		expect(() => saveIterationModelConfig(cwd, dataset, input)).toThrow("revision");
		expect(saveIterationModelConfig(cwd, dataset, { ...input, expectedRevision: 1 }).revision).toBe(2);
		expect(() => getIterationModelConfig(cwd, "other-project")).toThrow("does not match");
	});
	it.each(["A0", "XFE1", "A1048577", "=A1", "a1"])("rejects invalid Excel cell %s", (cell) => {
		const { cwd, input } = setup(false);
		input.mappings[0].cell = cell;
		expect(() => saveIterationModelConfig(cwd, dataset, input)).toThrow();
	});
	it("rejects malformed runtime values, duplicate cells and formula expected values", () => {
		const { cwd, input } = setup(false);
		expect(() => saveIterationModelConfig(cwd, dataset, { ...input, expectedRevision: -1 })).toThrow();
		expect(() =>
			saveIterationModelConfig(cwd, dataset, { ...input, extra: true } as SaveIterationModelConfigInput),
		).toThrow();
		input.mappings[0].expectedValue = Number.NaN;
		expect(() => saveIterationModelConfig(cwd, dataset, input)).toThrow();
		input.mappings[0].expectedValue = "=1+1";
		expect(() => saveIterationModelConfig(cwd, dataset, input)).toThrow();
		input.mappings[0].expectedValue = 100;
		input.mappings.push({ ...input.mappings[0], id: "another" });
		expect(() => saveIterationModelConfig(cwd, dataset, input)).toThrow("Duplicate");
	});
	it("freezes absence of configuration and never retrospectively adopts it", async () => {
		const { cwd, run, complete, input } = setup(false);
		expect(freezeIterationModelBaseline(cwd, dataset, run.id).config).toBeNull();
		saveIterationModelConfig(cwd, dataset, input);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>();
		expect(
			(await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply })).status,
		).toBe("not_configured");
		expect(apply).not.toHaveBeenCalled();
	});
	it("refuses a late configuration when no creation-time snapshot exists", async () => {
		const { cwd, run, complete } = setup();
		withResearchDatabase(cwd, dataset, (connection) =>
			connection
				.prepare(
					"UPDATE framework_iterations SET record_json=json_set(record_json,'$.createdAt','2000-01-01T00:00:00.000Z') WHERE id=?",
				)
				.run(run.id),
		);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result).toMatchObject({ status: "unavailable", error: expect.stringContaining("postdates") });
		expect(apply).not.toHaveBeenCalled();
	});
});

describe("evidence-bound model deliveries", () => {
	it.each([false, true])(
		"rejects conflicting observations including an unchanged baseline value, reverse=%s",
		async (reverse) => {
			const { cwd, run, complete } = setup();
			const facts = structuredClone(observations);
			const unchanged = {
				...structuredClone(facts.observations[0]),
				id: "unchanged",
				value: 100,
				quote: "2026年第二季度收入100亿元",
			};
			unchanged.context.basisQuote = unchanged.quote;
			facts.observations.push(unchanged);
			if (reverse) facts.observations.reverse();
			const effects = structuredClone(impacts);
			effects.impacts[0].observationIds.push(unchanged.id);
			withResearchDatabase(cwd, dataset, (connection) =>
				connection
					.prepare("UPDATE pdf_pages SET page_text=? WHERE doc_id='new'")
					.run(facts.observations.map((entry) => entry.quote).join("\n")),
			);
			expect((await complete(facts, effects)).status).toBe("no_change");
			const apply = vi.fn<typeof applyPeModelUpdate>();
			const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
				apply,
			});
			expect(result).toMatchObject({ status: "no_change", proposal: [], manualProposals: [], modelVersionId: null });
			expect(result.skips).toHaveLength(2);
			expect(result.skips.every((entry) => entry.reason === "ambiguous_observations")).toBe(true);
			expect(apply).not.toHaveBeenCalled();
		},
	);
	it("records a sole unchanged compliant observation without producing a workbook", async () => {
		const { cwd, run, complete, input } = setup(false);
		input.mappings[0].expectedValue = 120;
		saveIterationModelConfig(cwd, dataset, input);
		withResearchDatabase(cwd, dataset, (connection) =>
			connection
				.prepare(
					"UPDATE framework_iterations SET record_json=json_set(record_json,'$.createdAt','2099-01-01T00:00:00.000Z') WHERE id=?",
				)
				.run(run.id),
		);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result).toMatchObject({ status: "no_change", proposal: [], skips: [{ reason: "unchanged_value" }] });
		expect(apply).not.toHaveBeenCalled();
	});
	it("returns nothing_new when source collection finished without any new document or analysis", async () => {
		const { cwd, run } = setup();
		withResearchDatabase(cwd, dataset, (connection) =>
			connection.prepare("UPDATE framework_iterations SET status='no_change' WHERE id=?").run(run.id),
		);
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result).toMatchObject({
			status: "no_change",
			error: null,
			modelVersionId: null,
			skips: [{ observationId: null, mappingId: null, reason: "nothing_new" }],
		});
		expect(apply).not.toHaveBeenCalled();
	});
	it.each(["model", "evidence"])("fences changed %s bytes or identity before applying", async (target) => {
		const { cwd, run, complete } = setup();
		await complete();
		if (target === "model") writeFileSync(join(cwd, "raw/model.xlsx"), "changed");
		else
			withResearchDatabase(cwd, dataset, (connection) =>
				connection.exec("UPDATE documents SET updated_at='changed' WHERE doc_id='new'"),
			);
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("unavailable");
		expect(apply).not.toHaveBeenCalled();
	});
	it("rejects unvalidated analysis even when it is inserted into the artifact table", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		const forged = structuredClone(observations);
		forged.observations[0].value = 999;
		forged.observations[0].quote = "公司收入999亿元";
		withResearchDatabase(cwd, dataset, (connection) =>
			connection
				.prepare("INSERT INTO framework_iteration_artifact_attempts VALUES(?,?,?,?)")
				.run("forged", run.id, "extract", JSON.stringify({ stage: "extract", value: forged, at: "2099-01-01" })),
		);
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("unavailable");
		expect(result.error).toContain("原文引述");
		expect(apply).not.toHaveBeenCalled();
	});
	it("produces a real downloadable candidate, preserves the framework and deduplicates concurrent retries", async () => {
		const { cwd, run, complete, docId } = setup();
		freezeIterationModelBaseline(cwd, dataset, run.id);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>(async (root, options) => {
			expect(options.promoteIfEligible).toBe(false);
			expect(options.expectedSourceSha256).toBe(hash(bytes));
			return receipt(root, options);
		});
		const first = executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		const concurrent = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply,
		});
		expect(concurrent.status).toBe("running");
		const result = await first;
		expect(result).toMatchObject({
			status: "candidate",
			configRevision: 1,
			proposal: [{ expectedValue: 100, newValue: 120, kind: "actual", evidenceIds: [evidence] }],
		});
		expect(await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply })).toEqual(
			result,
		);
		expect(apply).toHaveBeenCalledTimes(1);
		expect(readIterationModelWorkbook(cwd, dataset, run.id).bytes).toEqual(bytes);
		expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => currentModelVersionId(connection, dataset, docId)),
		).toBeUndefined();
	});
	it.each(["unit", "scope", "period", "subject", "metric", "asOf"] as const)(
		"never guesses a %s mapping",
		async (field) => {
			const { cwd, input, run, complete } = setup(false);
			input.mappings[0][field] = "different";
			saveIterationModelConfig(cwd, dataset, input);
			withResearchDatabase(cwd, dataset, (connection) =>
				connection
					.prepare(
						"UPDATE framework_iterations SET record_json=json_set(record_json,'$.createdAt','2099-01-01T00:00:00.000Z') WHERE id=?",
					)
					.run(run.id),
			);
			freezeIterationModelBaseline(cwd, dataset, run.id);
			await complete();
			const apply = vi.fn<typeof applyPeModelUpdate>();
			const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
				apply,
			});
			expect(result.status).toBe("no_change");
			expect(result.skips).toContainEqual({ observationId: "revenue", mappingId: null, reason: "no_exact_mapping" });
			expect(apply).not.toHaveBeenCalled();
		},
	);
	it("leaves assumption decisions manual even with an exact factual observation", async () => {
		const { cwd, input, run, complete } = setup(false);
		input.mappings[0].role = "assumption";
		saveIterationModelConfig(cwd, dataset, input);
		withResearchDatabase(cwd, dataset, (connection) =>
			connection
				.prepare(
					"UPDATE framework_iterations SET record_json=json_set(record_json,'$.createdAt','2099-01-01T00:00:00.000Z') WHERE id=?",
				)
				.run(run.id),
		);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("no_change");
		expect(result.manualProposals).toHaveLength(1);
		expect(result.skips[0].reason).toBe("assumption_requires_human_decision");
		expect(apply).not.toHaveBeenCalled();
	});
	it.each(["gap", "role", "ambiguity", "unresolved", "currency"])(
		"skips %s rather than inventing an update",
		async (condition) => {
			const { cwd, run, complete } = setup();
			const facts = structuredClone(observations);
			const effects = structuredClone(impacts);
			if (condition === "gap") facts.observations[0].gaps = ["口径待确认"];
			if (condition === "role") facts.observations[0].role = "unknown";
			if (condition === "ambiguity") {
				facts.observations.push({ ...facts.observations[0], id: "second" });
				effects.impacts[0].observationIds.push("second");
			}
			if (condition === "unresolved") effects.impacts[0].relation = "unresolved";
			if (condition === "currency") effects.impacts[0].comparisonBasis!.currency = "USD";
			expect((await complete(facts, effects)).status).toBe("no_change");
			const apply = vi.fn<typeof applyPeModelUpdate>();
			const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
				apply,
			});
			expect(result.status).toBe("no_change");
			expect(result.skips.length).toBeGreaterThan(0);
			expect(apply).not.toHaveBeenCalled();
		},
	);
	it("makes formula/expected-value failures unavailable without blocking the framework", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		const apply = vi
			.fn<typeof applyPeModelUpdate>()
			.mockRejectedValue(new Error("Refusing to overwrite formula cell DCF!B2"));
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result).toMatchObject({ status: "unavailable", error: expect.stringContaining("formula") });
		expect(getFrameworkIteration(cwd, dataset, run.id).status).toBe("no_change");
		expect(
			(await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply })).status,
		).toBe("unavailable");
		expect(apply).toHaveBeenCalledTimes(1);
		expect(() => readIterationModelWorkbook(cwd, dataset, run.id)).toThrow("no available");
	});
	it("marks failed recalculation unavailable while retaining the version association", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>(async (root, options) => ({
			...receipt(root, options),
			state: "unavailable",
			validation: { recalculated: false, hard_errors: ["LibreOffice unavailable"], new_error_cells: [], checks: [] },
		}));
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("unavailable");
		expect(result.modelVersionId).not.toBeNull();
		expect(result.error).toContain("LibreOffice");
	});
	it("fences cancelled signals and late cancellation results", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		const stop = new AbortController();
		const apply = vi.fn<typeof applyPeModelUpdate>(async (root, options) => {
			stop.abort();
			return receipt(root, options);
		});
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, stop.signal, { apply });
		expect(result.status).toBe("cancelled");
		expect(() => readIterationModelWorkbook(cwd, dataset, run.id)).toThrow();
		const fresh = setup();
		cancelFrameworkIteration(fresh.cwd, dataset, fresh.run.id);
		const unused = vi.fn<typeof applyPeModelUpdate>();
		expect(
			(
				await executeIterationModelUpdate(fresh.cwd, dataset, fresh.run.id, new AbortController().signal, {
					apply: unused,
				})
			).status,
		).toBe("cancelled");
		expect(unused).not.toHaveBeenCalled();
	});
	it("fences configuration changes before and during model application", async () => {
		const { cwd, run, complete, input } = setup();
		freezeIterationModelBaseline(cwd, dataset, run.id);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>(async (root, options) => {
			saveIterationModelConfig(cwd, dataset, { ...input, expectedRevision: 1 });
			return receipt(root, options);
		});
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result).toMatchObject({ status: "unavailable", error: expect.stringContaining("stale") });
		const fresh = setup();
		freezeIterationModelBaseline(fresh.cwd, dataset, fresh.run.id);
		saveIterationModelConfig(fresh.cwd, dataset, { ...fresh.input, expectedRevision: 1 });
		await fresh.complete();
		const unused = vi.fn<typeof applyPeModelUpdate>();
		expect(
			(
				await executeIterationModelUpdate(fresh.cwd, dataset, fresh.run.id, new AbortController().signal, {
					apply: unused,
				})
			).status,
		).toBe("unavailable");
		expect(unused).not.toHaveBeenCalled();
	});
});

describe("model delivery download and explicit promotion", () => {
	it("preserves immutable adoption receipts through A to B promotions and repeated requests", async () => {
		const { cwd, run, complete, create, docId } = setup();
		await complete();
		const first = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		expect(first.promotionReceipt).toBeNull();
		const firstConfig = promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher-A");
		const firstReceipt = getIterationModelUpdateResult(cwd, dataset, run.id)!.promotionReceipt;
		expect(firstReceipt).toEqual({
			datasetId: dataset,
			runId: run.id,
			docId,
			oldModelVersionId: null,
			newModelVersionId: first.modelVersionId,
			configRevisionBefore: 1,
			configRevisionAfter: 2,
			promotedAt: firstConfig.updatedAt,
			actor: "researcher-A",
		});
		const nextRun = create();
		const nextEvidence = sourceId({ docId: "later", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
		const facts = structuredClone(observations);
		Object.assign(facts.observations[0], {
			docId: "later",
			value: 130,
			quote: "2026年第二季度收入130亿元",
			evidenceIds: [nextEvidence],
		});
		facts.observations[0].context.basisQuote = facts.observations[0].quote;
		facts.coverage[0].docId = "later";
		const effects = structuredClone(impacts);
		effects.impacts[0].evidenceIds = [nextEvidence];
		effects.impacts[0].reason = "本期实际收入130亿元";
		withResearchDatabase(cwd, dataset, (connection) => {
			connection
				.prepare(
					"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('later',?,'later.pdf','later.pdf','later','pdf','completed','after','after')",
				)
				.run(dataset);
			connection.exec(
				"INSERT INTO pdf_pages VALUES('later-page','later',1,'2026年第二季度收入130亿元','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
			);
		});
		expect((await complete(facts, effects, nextRun.id)).status).toBe("no_change");
		const second = await executeIterationModelUpdate(cwd, dataset, nextRun.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		expect(second.status).toBe("candidate");
		const secondConfig = promoteIterationModelUpdate(cwd, dataset, nextRun.id, 2, "researcher-B");
		const secondReceipt = getIterationModelUpdateResult(cwd, dataset, nextRun.id)!.promotionReceipt;
		expect(secondReceipt).toEqual({
			datasetId: dataset,
			runId: nextRun.id,
			docId,
			oldModelVersionId: first.modelVersionId,
			newModelVersionId: second.modelVersionId,
			configRevisionBefore: 2,
			configRevisionAfter: 3,
			promotedAt: secondConfig.updatedAt,
			actor: "researcher-B",
		});
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)!.promotionReceipt).toEqual(firstReceipt);
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)!.manifest).toEqual(first.manifest);
		expect(getIterationModelUpdateResult(cwd, dataset, nextRun.id)!.manifest).toEqual(second.manifest);
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "replacement-actor")).toThrow("revision");
		expect(() => promoteIterationModelUpdate(cwd, dataset, nextRun.id, 2, "replacement-actor")).toThrow("revision");
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)!.promotionReceipt).toEqual(firstReceipt);
		expect(getIterationModelUpdateResult(cwd, dataset, nextRun.id)!.promotionReceipt).toEqual(secondReceipt);
		withModelUpdateDatabase(cwd, dataset, (connection) => {
			expect(currentModelVersionId(connection, dataset, docId)).toBe(second.modelVersionId);
			expect(connection.prepare("SELECT COUNT(*) AS count FROM iteration_model_promotions").get()?.count).toBe(2);
			expect(() => connection.exec("UPDATE iteration_model_promotions SET receipt_json='{}'")).toThrow("immutable");
			expect(() => connection.exec("DELETE FROM iteration_model_promotions")).toThrow("immutable");
		});
	});
	it("rolls back the pointer and config if the adoption receipt cannot be persisted", async () => {
		const { cwd, run, complete, docId } = setup();
		await complete();
		await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		withModelUpdateDatabase(cwd, dataset, (connection) =>
			connection.exec(
				"CREATE TRIGGER reject_promotion_receipt BEFORE INSERT ON iteration_model_promotions BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
			),
		);
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher")).toThrow("receipt failure");
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)!.promotionReceipt).toBeNull();
		expect(getIterationModelConfig(cwd, dataset)?.revision).toBe(1);
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => currentModelVersionId(connection, dataset, docId)),
		).toBeUndefined();
	});
	it.each(["", "   ", "bad\0actor", "x".repeat(501)])("rejects an invalid promotion actor", (actor) => {
		const { cwd, run } = setup();
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, actor)).toThrow("actor");
	});
	it("checks the expected source hash before any workbook write or recalculation", async () => {
		const { cwd, docId } = setup();
		vi.spyOn(documents, "preparePeDocument").mockResolvedValue({
			document: { file_type: "xlsx" },
			datasetId: dataset,
			workspaceRoot: cwd,
			filePath: join(cwd, "raw/model.xlsx"),
			readablePath: "unused",
			cachePath: "unused",
			warnings: [],
		});
		await expect(
			applyPeModelUpdate(cwd, {
				requestId: "source-guard",
				docId,
				datasetId: dataset,
				expectedSourceSha256: "0".repeat(64),
				changes: [
					{
						sheet: "DCF",
						cell: "B2",
						expectedValue: 100,
						newValue: 120,
						kind: "actual",
						evidenceIds: [evidence],
						reason: "actual",
					},
				],
				promoteIfEligible: false,
			}),
		).rejects.toThrow("baseline changed");
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => listModelVersionRows(connection, dataset, docId)),
		).toHaveLength(0);
		expect(readFileSync(join(cwd, "raw/model.xlsx"))).toEqual(bytes);
	});
	it("rolls back the version pointer if persisting the new config fails", async () => {
		const { cwd, run, complete, docId } = setup();
		await complete();
		await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		withModelUpdateDatabase(cwd, dataset, (connection) =>
			connection.exec(
				"CREATE TRIGGER reject_config_write BEFORE UPDATE ON iteration_model_configs BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END",
			),
		);
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher")).toThrow("storage failure");
		expect(getIterationModelConfig(cwd, dataset)?.revision).toBe(1);
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => currentModelVersionId(connection, dataset, docId)),
		).toBeUndefined();
	});
	it("does not promote until framework review has finished", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		withResearchDatabase(cwd, dataset, (connection) =>
			connection.prepare("UPDATE framework_iterations SET status='review_required' WHERE id=?").run(run.id),
		);
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher")).toThrow(
			"Finish framework review",
		);
		expect(getIterationModelConfig(cwd, dataset)?.revision).toBe(1);
	});
	it("does not infer a currency for a monetary model input", async () => {
		const { cwd, run, complete } = setup();
		withModelUpdateDatabase(cwd, dataset, (connection) =>
			connection.exec(
				"UPDATE iteration_model_configs SET config_json=json_set(config_json,'$.mappings[0].currency',NULL)",
			),
		);
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("no_change");
		expect(result.skips[0].reason).toBe("currency_not_confirmed");
		expect(apply).not.toHaveBeenCalled();
	});
	it("records a late file receipt but never presents it as available after the lease is lost", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		const apply = vi.fn<typeof applyPeModelUpdate>(async (root, options) => {
			withModelUpdateDatabase(cwd, dataset, (connection) =>
				connection.prepare("UPDATE iteration_model_results SET lease_until=0 WHERE run_id=?").run(run.id),
			);
			const interrupted = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
				apply: vi.fn<typeof applyPeModelUpdate>(),
			});
			expect(interrupted.status).toBe("unavailable");
			return receipt(root, options);
		});
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, { apply });
		expect(result.status).toBe("unavailable");
		expect(result.modelVersionId).not.toBeNull();
		expect(apply).toHaveBeenCalledTimes(1);
		expect(() => readIterationModelWorkbook(cwd, dataset, run.id)).toThrow();
	});
	it("atomically advances the pointer, config revision and applied expected values", async () => {
		const { cwd, run, complete, docId } = setup();
		await complete();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		const config = promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher");
		expect(config).toMatchObject({
			revision: 2,
			baseVersionId: result.modelVersionId,
			baselineSha256: hash(bytes),
			mappings: [{ expectedValue: 120 }],
		});
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => currentModelVersionId(connection, dataset, docId)),
		).toBe(result.modelVersionId);
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher")).toThrow("revision");
	});
	it.each(["sha", "symlink", "path"])("refuses %s tampering for download and promotion", async (condition) => {
		const { cwd, run, complete, docId } = setup();
		await complete();
		const result = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		const path = join(cwd, result.manifest!.file.path);
		if (condition === "sha") writeFileSync(path, "changed");
		if (condition === "symlink") {
			rmSync(path);
			symlinkSync(join(cwd, "raw/model.xlsx"), path);
		}
		if (condition === "path") {
			withModelUpdateDatabase(cwd, dataset, (connection) => {
				connection.exec("DROP TRIGGER model_update_versions_immutable_update");
				connection
					.prepare("UPDATE model_update_versions SET file_relpath='raw/model.xlsx' WHERE version_id=?")
					.run(result.modelVersionId);
			});
		}
		expect(() => readIterationModelWorkbook(cwd, dataset, run.id)).toThrow();
		expect(() => promoteIterationModelUpdate(cwd, dataset, run.id, 1, "researcher")).toThrow();
		expect(getIterationModelConfig(cwd, dataset)?.revision).toBe(1);
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => currentModelVersionId(connection, dataset, docId)),
		).toBeUndefined();
	});
	it("serializes duplicate tool requests without deleting the persisted winner artifact", async () => {
		const { cwd, docId } = setup();
		const options: ApplyPeModelUpdateOptions = {
			docId,
			datasetId: dataset,
			requestId: "same-request",
			expectedSourceSha256: hash(bytes),
			promoteIfEligible: false,
			changes: [
				{
					sheet: "DCF",
					cell: "B2",
					expectedValue: 100,
					newValue: 120,
					kind: "actual",
					evidenceIds: [evidence],
					reason: "actual",
				},
			],
		};
		const winner = receipt(cwd, options);
		const outcomes = await Promise.allSettled([applyPeModelUpdate(cwd, options), applyPeModelUpdate(cwd, options)]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
		expect(existsSync(join(cwd, winner.file.path))).toBe(true);
		expect(readFileSync(join(cwd, winner.file.path))).toEqual(bytes);
		expect((await applyPeModelUpdate(cwd, options)).version_id).toBe(winner.version_id);
		await expect(
			applyPeModelUpdate(cwd, { ...options, changes: [{ ...options.changes[0], newValue: 999 }] }),
		).rejects.toThrow("different input");
		expect(
			withModelUpdateDatabase(cwd, dataset, (connection) => listModelVersionRows(connection, dataset, docId)),
		).toHaveLength(1);
	});
	it("reconciles a crashed delivery receipt without repeating an uncertain write", async () => {
		const { cwd, run, complete } = setup();
		await complete();
		await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply: async (root, options) => receipt(root, options),
		});
		withModelUpdateDatabase(cwd, dataset, (connection) =>
			connection
				.prepare(
					"UPDATE iteration_model_results SET status='running',lease_until=0,record_json=json_set(record_json,'$.status','running','$.modelVersionId',NULL,'$.manifest',NULL) WHERE run_id=?",
				)
				.run(run.id),
		);
		const apply = vi.fn<typeof applyPeModelUpdate>();
		const recovered = await executeIterationModelUpdate(cwd, dataset, run.id, new AbortController().signal, {
			apply,
		});
		expect(recovered.status).toBe("unavailable");
		expect(recovered.modelVersionId).not.toBeNull();
		expect(apply).not.toHaveBeenCalled();
		expect(getIterationModelUpdateResult(cwd, dataset, run.id)).toEqual(recovered);
	});
});
