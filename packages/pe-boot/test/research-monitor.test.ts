import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { createResearchDraft, getResearchFramework, publishResearchDraft } from "../src/research/framework.ts";
import type { FrameworkContent } from "../src/research/model.ts";
import {
	getResearchMonitor,
	type MonitorConfig,
	requestResearchMonitorRun,
	runResearchMonitor,
	saveResearchMonitor,
} from "../src/research/monitor.ts";
import { withResearchDatabase } from "../src/research/storage.ts";

const roots: string[] = [];
const dataset = "dataset_test";
const content: FrameworkContent = {
	title: "原框架",
	objective: "验证需求",
	horizon: "一年",
	items: [
		{
			id: "demand",
			kind: "hypothesis",
			claim: "需求可能增长",
			rationale: "用户假设",
			subject: "公司",
			verification: "订单增长",
			invalidation: "订单下滑",
			origin: "user",
			evidenceIds: [],
		},
	],
	coverageGaps: ["待补充财报"],
};
const config: MonitorConfig = {
	enabled: true,
	mode: "auto",
	intervalHours: 24,
	objective: "核对新增证据",
	queries: [],
	includeMemos: true,
};
function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "pe-monitor-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId: dataset, name: "Test" });
	const draft = createResearchDraft(cwd, dataset, content, [], null);
	publishResearchDraft(cwd, dataset, { draftId: draft.id, revision: 1, expectedVersionId: null, requestId: "first" });
	saveResearchMonitor(cwd, dataset, config, 0);
	return cwd;
}
afterEach(() => {
	for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

it("automatically publishes, persists records, skips unchanged inputs and detects a newly ready document", async () => {
	const cwd = setup();
	let calls = 0;
	const engine = {
		async generate() {
			calls++;
			return { ...content, title: "调整框架" };
		},
	};
	await runResearchMonitor(cwd, dataset, engine, AbortSignal.timeout(5000));
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("published");
	expect(run.changes?.[0].id).toBe("title");
	expect(readFileSync(join(cwd, "generated/monitoring", `${run.id}.md`), "utf8")).toContain(run.versionId);
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(cwd, dataset, engine, AbortSignal.timeout(5000));
	expect(calls).toBe(1);
	expect(getResearchMonitor(cwd, dataset).runs[0].status).toBe("no_change");
	withResearchDatabase(cwd, dataset, (db) =>
		db
			.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new',?,'new.pdf','new.pdf','new','pdf','completed','today','today')",
			)
			.run(dataset),
	);
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate(input, basis) {
				expect(input.inputs.map((i) => i.docId)).toContain("new");
				calls++;
				return basis!;
			},
		},
		AbortSignal.timeout(5000),
	);
	expect(calls).toBe(2);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
});

it("preserves drafts in manual mode and does not conflate source failures with no new data", async () => {
	const cwd = setup();
	saveResearchMonitor(
		cwd,
		dataset,
		{ ...config, mode: "review", queries: [{ category: "news", query: "公司新闻" }] },
		1,
	);
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate() {
				return { ...content, title: "候选" };
			},
		},
		AbortSignal.timeout(5000),
		async () => {
			throw new Error("WIND_HTTP_403");
		},
	);
	const run = getResearchMonitor(cwd, dataset).runs[0];
	expect(run.status).toBe("review_required");
	expect(run.events.some((e) => e.status === "failed")).toBe(true);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	expect(getResearchFramework(cwd, dataset).drafts.find((d) => d.id === run.draftId)?.status).toBe("open");
});

it("fences concurrent runs and prevents publication after pause or a competing human version", async () => {
	const cwd = setup();
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate() {
				expect(
					await runResearchMonitor(
						cwd,
						dataset,
						{
							async generate() {
								throw new Error("must not run");
							},
						},
						AbortSignal.timeout(5000),
					),
				).toBe(false);
				saveResearchMonitor(cwd, dataset, { ...config, enabled: false }, 1);
				return { ...content, title: "不能发布" };
			},
		},
		AbortSignal.timeout(5000),
	);
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
	expect(getResearchMonitor(cwd, dataset).runs[0].status).toBe("failed");
	saveResearchMonitor(cwd, dataset, config, 2);
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate() {
				const state = getResearchFramework(cwd, dataset);
				const draft = createResearchDraft(
					cwd,
					dataset,
					{ ...content, title: "人工修改" },
					[],
					state.currentVersionId,
				);
				publishResearchDraft(cwd, dataset, {
					draftId: draft.id,
					revision: 1,
					expectedVersionId: state.currentVersionId,
					requestId: "human",
				});
				return { ...content, title: "过期结果" };
			},
		},
		AbortSignal.timeout(5000),
	);
	expect(getResearchFramework(cwd, dataset).versions[0].content.title).toBe("人工修改");
	expect(getResearchMonitor(cwd, dataset).runs[0].status).toBe("failed");
});

it("rejects invalid intervals, categories, stale config writes and mismatched projects", () => {
	const cwd = setup();
	expect(() => saveResearchMonitor(cwd, dataset, { ...config, intervalHours: 0 }, 1)).toThrow("Invalid");
	expect(() =>
		saveResearchMonitor(cwd, dataset, { ...config, queries: [{ category: "unknown", query: "x" }] }, 1),
	).toThrow("Invalid");
	expect(() => saveResearchMonitor(cwd, dataset, config, 0)).toThrow("changed");
	expect(() => getResearchMonitor(cwd, "other")).toThrow("does not match");
});

it("recovers a committed publication receipt after a worker crash without publishing twice", async () => {
	const cwd = setup();
	const engine = {
		async generate() {
			return { ...content, title: "已发布" };
		},
	};
	await runResearchMonitor(cwd, dataset, engine, AbortSignal.timeout(5000));
	const completed = getResearchMonitor(cwd, dataset).runs[0];
	withResearchDatabase(cwd, dataset, (db) =>
		db.prepare("UPDATE research_monitor_runs SET status='running',lease_until=0 WHERE run_id=?").run(completed.id),
	);
	requestResearchMonitorRun(cwd, dataset);
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate() {
				throw new Error("Must skip unchanged inputs");
			},
		},
		AbortSignal.timeout(5000),
	);
	expect(getResearchMonitor(cwd, dataset).runs.find((run) => run.id === completed.id)?.status).toBe("published");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(2);
	expect(getResearchMonitor(cwd, dataset).runs[0].status).toBe("no_change");
});

it("rejects analysis if selected input preparation changes before the draft is saved", async () => {
	const cwd = setup();
	withResearchDatabase(cwd, dataset, (db) =>
		db
			.prepare(
				"INSERT INTO documents(doc_id,dataset_id,original_filename,filename_key,sha256,file_type,status,created_at,updated_at) VALUES('new',?,'new.pdf','new.pdf','new','pdf','completed','before','before')",
			)
			.run(dataset),
	);
	await runResearchMonitor(
		cwd,
		dataset,
		{
			async generate() {
				withResearchDatabase(cwd, dataset, (db) =>
					db.exec("UPDATE documents SET updated_at='after' WHERE doc_id='new'"),
				);
				return { ...content, title: "Based on old input" };
			},
		},
		AbortSignal.timeout(5000),
	);
	expect(getResearchMonitor(cwd, dataset).runs[0].error).toContain("preparation changed");
	expect(getResearchFramework(cwd, dataset).versions).toHaveLength(1);
});
