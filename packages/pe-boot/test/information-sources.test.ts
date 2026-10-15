import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import {
	assertInformationSourceConfig,
	type InformationQuery,
	type InformationSourceConfig,
	informationSourceConfig,
	renderWindFinancials,
} from "../src/information-source-model.ts";
import {
	fetchIterationInformation,
	listInformationSourceQueries,
	readInformationView,
	readInformationViewRange,
	readIterationSourceArchive,
	sourceCollectionResult,
} from "../src/information-source-store.ts";
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
	validateIterationAnalysis,
	validateIterationRevision,
} from "../src/research/iteration.ts";
import { getIterationChangeReview } from "../src/research/iteration-review.ts";
import { readResearchInput } from "../src/research/pi-engine.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { trackingPeriods } from "../src/research/tracking-periods.ts";
import { sourceId } from "../src/source.ts";
import { frameworkFixture } from "./fixtures/framework.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("sends every tracking quarter in chronological order, with a cutoff and no internal framework purpose", async () => {
	const config = informationSourceConfig("Company", "0700.HK", ["wind-financials"]);
	config.trackingWindow = { valuationDate: "2025-06-30", asOf: "2026-10-16" };
	config.defaultPeriods = trackingPeriods(config.trackingWindow.valuationDate, config.trackingWindow.asOf);
	const { root, run } = project(config);
	let sent = "";
	await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(
					root,
					"dataset_test",
					value,
					{ ...query, purpose: "私有投资目的及框架版本" },
					signal,
					async (request) => {
						sent = request.query;
						return response();
					},
				);
				return sourceCollectionResult(root, "dataset_test", value.id, "已保存");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "数据口径未核实", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("No revision expected");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(sent).toContain(config.defaultPeriods.join("、"));
	expect(sent).toContain("截至2026-10-16已披露");
	expect(sent).not.toContain("私有投资目的及框架版本");
});
const query: InformationQuery = {
	sourceId: "wind-financials",
	metrics: ["营业收入"],
	periods: ["2025年年报"],
	purpose: "核查收入",
	judgmentIds: ["demand"],
};
function response(code = "0700.HK", period = "2025年年报营业收入", value: number | null = 9) {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					data: {
						data: [
							{
								columns: [
									{ name: "Wind代码" },
									{ name: "证券简称" },
									{ name: period, unit: "亿元" },
									{ name: "最新报告期" },
								],
								rows: [[code, "Company", value, "H1 FY2026"]],
							},
						],
					},
					error: null,
				}),
			},
		],
		isError: false,
	};
}
function project(
	sourceConfig: InformationSourceConfig = informationSourceConfig("Company", "0700.HK", ["wind-financials"]),
) {
	const root = mkdtempSync(join(tmpdir(), "pe-information-source-"));
	roots.push(root);
	for (const path of ["raw", "meta"]) mkdirSync(join(root, path));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), {
		datasetId: "dataset_test",
		name: "Company",
	});
	const basis = frameworkFixture();
	const draft = createResearchDraft(root, "dataset_test", basis, [], null);
	const version = publishResearchDraft(root, "dataset_test", {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: null,
		requestId: "baseline",
	});
	setIterationTestProject(root, "dataset_test", true);
	const run = createFrameworkIteration(root, "dataset_test", {
		requestId: "sources",
		basisVersionId: version.id,
		modelId: "test",
		uploadIdentity: "sources",
		sourceMode: "sources",
		sourceConfig,
		changeReview: false,
	});
	return { root, run, basis, version };
}
function observations(root: string, run: ReturnType<typeof createFrameworkIteration>): IterationObservations {
	const docId = run.newDocIds[0];
	const read = readResearchInput(
		root,
		"dataset_test",
		{ objective: "test", inputs: run.inputs, asOf: run.createdAt },
		{ docId },
	) as ReturnType<typeof readInformationViewRange>;
	const fact = read.locations[0];
	const quote = read.text.split("\n")[fact.line - read.lineStart];
	return {
		observations: [
			{
				id: "revenue",
				docId,
				subject: "Company",
				metric: "营业收入",
				sourceField: fact.metric,
				value: fact.value,
				period: fact.period,
				unit: fact.unit,
				role: fact.role ?? "unknown",
				quote,
				evidenceIds: [read.evidenceId],
				gaps: [],
				context: {
					periodKind: fact.periodKind,
					asOf: fact.periodKind === "cumulative" ? fact.period : null,
					scope: fact.scope,
					basisQuote: quote,
					eventKind: "none",
					reviewReasons: [],
				},
			},
		],
		coverage: [{ docId, readLocations: ["text"], gaps: [] }],
	};
}

async function collectArchive(root: string, run: ReturnType<typeof createFrameworkIteration>) {
	const fetcher = vi.fn(async () => response());
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher);
				return sourceCollectionResult(root, "dataset_test", value.id, "已归档");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "无需修改", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("No revision expected");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(completed.status, completed.error ?? "").toBe("no_change");
	expect(fetcher).toHaveBeenCalledTimes(1);
	return listInformationSourceQueries(root, "dataset_test", run.id)[0];
}

it.each(["default TMPDIR", "symlinked project root"])("archives and reads sources under %s", async (mode) => {
	const projectState = project();
	let root = projectState.root;
	if (mode === "symlinked project root") {
		const aliasFolder = mkdtempSync(join(tmpdir(), "pe-information-source-alias-"));
		roots.push(aliasFolder);
		root = join(aliasFolder, "project");
		symlinkSync(projectState.root, root, "dir");
	}
	const record = await collectArchive(root, projectState.run);
	for (const projectRoot of [root, realpathSync(root)]) {
		expect(
			JSON.parse(readIterationSourceArchive(projectRoot, "dataset_test", projectState.run.id, record.id, "raw"))
				.response,
		).toEqual(response());
		expect(readIterationSourceArchive(projectRoot, "dataset_test", projectState.run.id, record.id, "text")).toContain(
			"值：9",
		);
	}
});

it.each([
	["directory", "inside"],
	["directory", "outside"],
	["file", "inside"],
	["file", "outside"],
] as const)("rejects an archive %s symlink pointing %s the project", async (kind, destination) => {
	const { root, run } = project();
	const record = await collectArchive(root, run);
	const rawPath = join(root, record.attempts[0].rawPath!);
	const target = kind === "directory" ? dirname(rawPath) : rawPath;
	const outside = mkdtempSync(join(tmpdir(), "pe-information-source-outside-"));
	roots.push(outside);
	const relocated = join(destination === "inside" ? root : outside, "relocated");
	renameSync(target, relocated);
	symlinkSync(relocated, target, kind === "directory" ? "dir" : "file");
	for (const format of ["raw", "text"] as const)
		expect(() => readIterationSourceArchive(root, "dataset_test", run.id, record.id, format)).toThrowError(
			expect.objectContaining({ status: 403, message: "来源归档不能使用符号链接。" }),
		);
});

it.each(["traversal", "absolute external file", "project root"])("rejects an archived %s path", async (mode) => {
	const { root, run } = project();
	const record = await collectArchive(root, run);
	const outside = mkdtempSync(join(tmpdir(), "pe-information-source-outside-"));
	roots.push(outside);
	const externalFile = join(realpathSync(outside), "archive.json");
	writeFileSync(externalFile, readFileSync(join(root, record.attempts[0].rawPath!)));
	const forged = { ...record, id: "forged-query", attempts: [] };
	const attempt = {
		...record.attempts[0],
		id: "forged-attempt",
		rawPath:
			mode === "traversal"
				? relative(realpathSync(root), externalFile)
				: mode === "project root"
					? "."
					: externalFile,
	};
	withResearchDatabase(root, "dataset_test", (db) => {
		db.prepare("INSERT INTO framework_iteration_source_queries VALUES(?,?,?)").run(
			run.id,
			forged.id,
			JSON.stringify(forged),
		);
		db.prepare("INSERT INTO framework_iteration_source_attempts VALUES(?,?,?,?,?,?)").run(
			attempt.id,
			run.id,
			forged.id,
			attempt.number,
			attempt.finishedAt,
			JSON.stringify(attempt),
		);
	});
	expect(() => readIterationSourceArchive(root, "dataset_test", run.id, forged.id, "raw")).toThrowError(
		expect.objectContaining({ status: 403, message: "来源归档路径超出项目。" }),
	);
});

it("renders full tables once and preserves field periods, nulls, original units and JSON provenance", () => {
	const rendered = renderWindFinancials(response(), "0700.HK");
	expect(rendered.usable).toBe(true);
	expect(rendered.facts[0]).toMatchObject({
		metric: "2025年年报营业收入",
		value: 9,
		unit: "亿元",
		period: "2025年年报",
	});
	expect(rendered.facts[0].paths).toContain("response.content[0].text::$.data.data[0].rows[0][2]");
	expect(rendered.text.match(/值：9/g)).toHaveLength(1);
	expect(renderWindFinancials(response("0700.HK", "营业收入"), "0700.HK").facts[0].period).toBeNull();
	expect(renderWindFinancials(response("0700.HK", "营业收入", null), "0700.HK").usable).toBe(false);
	expect(renderWindFinancials(response("AAPL.O"), "0700.HK").gaps.join()).toContain("证券代码不匹配");
	expect(renderWindFinancials({ content: [{ text: "No data" }] }, "0700.HK").usable).toBe(false);
});

it("rejects malformed header/row mappings and retains business labels instead of guessing", () => {
	const payload = response();
	const body = JSON.parse(payload.content[0].text);
	body.data.data[0].rows[0].pop();
	payload.content[0].text = JSON.stringify(body);
	expect(renderWindFinancials(payload, "0700.HK")).toMatchObject({ usable: false, facts: [] });
	expect(renderWindFinancials(payload, "0700.HK").gaps.join()).toContain("表头长度不一致");
});

it("preserves per-column and row periods, explicit currencies and forecast roles without treating numeric axes as facts", () => {
	const payload = {
		content: [
			{
				text: JSON.stringify({
					columns: [
						{ name: "Wind代码" },
						{ name: "日期" },
						{ name: "年份" },
						{ name: "季度" },
						{ name: "2023年EBIT", unit: "亿英镑" },
						{ name: "2024年营业收入", unit: "亿元" },
						{ name: "2025H1营业收入", unit: "人民币亿元", scope: "合并" },
						{ name: "2023到2025年每季度毛利", unit: "亿元" },
						{ name: "2026年中报营业收入预测", unit: "亿元" },
					],
					rows: [["0700.HK", "Q4 FY2025", 2025, 4, -2, 3, 4, 5, 6]],
				}),
			},
		],
	};
	const view = renderWindFinancials(payload, "0700.HK");
	expect(view.facts).toHaveLength(5);
	expect(view.facts[0]).toMatchObject({ period: "2023年", periodKind: "unknown", currency: "英镑" });
	expect(view.facts[1]).toMatchObject({ period: "2024年", currency: null });
	expect(view.facts[2]).toMatchObject({ period: "2025H1", periodKind: "cumulative", scope: "合并" });
	expect(view.facts[3]).toMatchObject({ period: "Q4 FY2025", periodKind: "unknown" });
	expect(view.facts[3].paths).toContain("response.content[0].text::$.rows[0][1]");
	expect(view.facts[4]).toMatchObject({ period: "2026年中报", role: "forecast" });
	expect(view.gaps).not.toContain("2023年EBIT 未明确记账币种，金额换算和跨币种比较需要核查。");
	for (const fact of view.facts) expect(view.text.split("\n")[fact.line - 1]).toContain(`指标：${fact.metric}`);
});

it("binds financial values to explicit business row labels and raw year/quarter coordinates", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "主营项目收入", unit: "亿元" },
							{ name: "主营项目名称" },
							{ name: "记账本位币" },
							{ name: "年份" },
							{ name: "季度" },
							{ name: "名次" },
						],
						rows: [
							["0700.HK", 11, "授权及服务业务", "CNY", 2026, 2, 1],
							["0700.HK", 9, "产品解决方案", "CNY", 2026, 2, 2],
						],
					}),
				},
			],
		},
		"0700.HK",
	);
	expect(view.facts).toHaveLength(2);
	expect(view.facts[0]).toMatchObject({
		scope: "授权及服务业务",
		period: "年份=2026，季度=2",
		periodKind: "unknown",
		currency: "CNY",
	});
	expect(view.facts[1]).toMatchObject({ scope: "产品解决方案", value: 9 });
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][2]");
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][4]");
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][5]");
	expect(() =>
		assertInformationSourceConfig({
			...informationSourceConfig("Company", "0700.HK", ["wind-financials"]),
			viewVersion: "old",
		}),
	).toThrow("版本已变化");
});

it("uses each row date under year-range headers without assigning the collection cutoff to financial fields", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "日期" },
							{ name: "2023年到2026年年报的营业总收入", unit: "亿元" },
						],
						rows: [
							["0700.HK", "Q4 FY2025", 37.5827],
							["0700.HK", "Q4 FY2024", 23.8355],
							["0700.HK", "Q4 FY2023", 15.5161],
						],
					}),
				},
			],
		},
		"0700.HK",
	);
	expect(view.facts.map((fact) => fact.period)).toEqual(["Q4 FY2025", "Q4 FY2024", "Q4 FY2023"]);
	expect(view.facts.every((fact) => fact.periodKind === "unknown")).toBe(true);
	expect(
		renderWindFinancials(response("0700.HK", "截至2026年10月12日披露的2024年营业收入"), "0700.HK").facts[0].period,
	).toBeNull();
});

it("prefers field-specific dates over shared row dates and preserves explicit forecast roles", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "日期" },
							{ name: "营业收入", unit: "CNY亿元", role: "Forecast" },
							{ name: "营业收入报告期" },
						],
						rows: [["0700.HK", "Q2 FY2026", 12, "2025年年报"]],
					}),
				},
			],
		},
		"0700.HK",
	);
	expect(view.facts[0]).toMatchObject({ period: "2025年年报", role: "forecast" });
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][3]");
});

it("pairs year-specific business labels and report types without borrowing segment labels for company totals", () => {
	const view = renderWindFinancials(
		{
			content: [
				{
					text: JSON.stringify({
						columns: [
							{ name: "Wind代码" },
							{ name: "2023年主营项目名称", type: "string" },
							{ name: "2026年中报主营项目名称", type: "string" },
							{ name: "2026年中报主营项目收入", type: "number", unit: "CNY亿元" },
							{ name: "2026年中报主营项目收入时间", type: "string" },
							{ name: "2026年中报研发费用", type: "number", unit: "CNY亿元" },
							{ name: "2025年营业总收入", type: "number", unit: "CNY亿元" },
							{ name: "2025年营业总收入.报表类型", type: "string" },
						],
						rows: [["0700.HK", null, "产品解决方案", 9, "2026-06-30", 27.55, 37.58, "合并报表"]],
					}),
				},
			],
		},
		"0700.HK",
	);
	expect(view.facts).toHaveLength(3);
	expect(view.facts[0]).toMatchObject({ scope: "产品解决方案", period: "2026-06-30", periodKind: "cumulative" });
	expect(view.facts[1].scope).toBeNull();
	expect(view.facts[2].scope).toBe("合并报表");
	expect(view.facts[0].paths).toContain("response.content[0].text::$.rows[0][2]");
	expect(view.facts[2].paths).toContain("response.content[0].text::$.rows[0][7]");
});

it("shares request idempotency and active-task exclusion across document and source entry points", () => {
	const { root, run, version } = project();
	const request = {
		requestId: "sources",
		basisVersionId: version.id,
		modelId: "test",
		uploadIdentity: "sources",
		sourceMode: "sources" as const,
		sourceConfig: run.sourceConfig,
		changeReview: false,
	};
	expect(createFrameworkIteration(root, "dataset_test", request).id).toBe(run.id);
	expect(() => createFrameworkIteration(root, "dataset_test", { ...request, requestId: "other" })).toThrow("活跃");
	expect(() =>
		createFrameworkIteration(root, "dataset_test", {
			requestId: "document",
			basisVersionId: version.id,
			modelId: "test",
			uploadIdentity: "upload",
		}),
	).toThrow("活跃");
	expect(() => createFrameworkIteration(root, "dataset_test", { ...request, modelId: "another" })).toThrow(
		"different input",
	);
	cancelFrameworkIteration(root, "dataset_test", run.id);
	expect(
		createFrameworkIteration(root, "dataset_test", {
			requestId: "document",
			basisVersionId: version.id,
			modelId: "test",
			uploadIdentity: "upload",
			changeReview: true,
		}).stage,
	).toBe("ingest");
});

it("reserves four unique queries and prevents a concurrent duplicate provider call", async () => {
	const { root, run } = project();
	let release: (value: ReturnType<typeof response>) => void = () => {};
	const fetcher = vi.fn(
		() =>
			new Promise<ReturnType<typeof response>>((resolve) => {
				release = resolve;
			}),
	);
	const result = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				const pending = fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher);
				await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
				await expect(
					fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher),
				).rejects.toThrow("正在执行");
				release(response());
				await pending;
				for (const metric of ["毛利", "研发费用", "净利润"])
					await fetchIterationInformation(
						root,
						"dataset_test",
						value,
						{ ...query, metrics: [metric] },
						signal,
						async () => response(),
					);
				await expect(
					fetchIterationInformation(
						root,
						"dataset_test",
						value,
						{ ...query, metrics: ["现金流"] },
						signal,
						fetcher,
					),
				).rejects.toThrow("4个");
				return sourceCollectionResult(root, "dataset_test", value.id, "有限采集");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "无变化", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(result.status, result.error ?? "").toBe("no_change");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(listInformationSourceQueries(root, "dataset_test", run.id)).toHaveLength(4);
});

it("reuses identical evidence already in the baseline without extraction, revision or another version", async () => {
	const { root, run, basis, version } = project();
	const collect: NonNullable<IterationEngine["collect"]> = async (value, _basis, signal) => {
		await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => response());
		return sourceCollectionResult(root, "dataset_test", value.id, "已取数");
	};
	const first = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect,
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "无需修改", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(first.status, first.error ?? "").toBe("no_change");
	const draft = createResearchDraft(
		root,
		"dataset_test",
		basis,
		first.inputs.map((input) => input.docId),
		version.id,
	);
	const baseline = publishResearchDraft(root, "dataset_test", {
		draftId: draft.id,
		revision: 1,
		expectedVersionId: version.id,
		requestId: "known-data",
	});
	const next = createFrameworkIteration(root, "dataset_test", {
		requestId: "repeat",
		basisVersionId: baseline.id,
		modelId: "test",
		uploadIdentity: "sources",
		sourceMode: "sources",
		sourceConfig: run.sourceConfig,
	});
	const downstream = vi.fn(async () => {
		throw new Error("Duplicate data must not reach downstream model stages");
	});
	const repeat = await runFrameworkIteration(
		root,
		"dataset_test",
		next.id,
		{ collect, extract: downstream, impact: downstream, revise: downstream },
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(repeat.status, repeat.error ?? "").toBe("no_change");
	expect(repeat.newDocIds).toEqual([]);
	expect(downstream).not.toHaveBeenCalled();
	expect(getResearchFramework(root, "dataset_test").versions).toHaveLength(2);
});

it("rejects incomparable source downgrades, paired business labels and unrecalculated valuation changes", async () => {
	const { root, run, basis } = project();
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => response());
				return sourceCollectionResult(root, "dataset_test", value.id, "期间口径待核查");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "待核查", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	const extracted = observations(root, completed);
	const impacts: IterationImpacts = {
		substantive: true,
		summary: "新增核查",
		gaps: [],
		impacts: [
			{
				judgmentIds: ["demand"],
				sections: ["investmentJudgments"],
				observationIds: ["revenue"],
				relation: "unresolved",
				comparable: false,
				comparisonBasis: null,
				reason: "业务口径不明",
				proposedChange: "补充核查理由",
				evidenceIds: extracted.observations[0].evidenceIds,
			},
		],
	};
	for (const relation of ["supports", "weakens", "overturns"] as const)
		expect(() =>
			withResearchDatabase(root, "dataset_test", (db) =>
				validateIterationAnalysis(db, completed, basis, extracted, {
					...impacts,
					impacts: [{ ...impacts.impacts[0], relation }],
				}),
			),
		).toThrow("未确认可比");
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) =>
			validateIterationAnalysis(db, completed, basis, extracted, impacts),
		),
	).not.toThrow();
	const wrongScope = structuredClone(extracted);
	wrongScope.observations[0].context.scope = "产品解决方案";
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) => validateIterationAnalysis(db, completed, basis, wrongScope)),
	).toThrow("业务口径不匹配");
	const candidate = structuredClone(basis);
	candidate.sections.researchSetup.informationCutoff = null;
	candidate.sections.investmentJudgments.items[0].rationale = "原判断保留，需核查新数据口径";
	candidate.sections.evidenceAndChanges.changes = [
		{
			judgmentIds: ["demand"],
			before: "原判断",
			after: "增加核查",
			reason: "业务口径不明",
			evidenceIds: impacts.impacts[0].evidenceIds,
		},
	];
	expect(() => validateIterationRevision(basis, candidate, impacts, extracted)).not.toThrow();
	for (const key of ["claim", "invalidation", "counterEvidenceIds"] as const) {
		const changed = structuredClone(candidate);
		if (key === "counterEvidenceIds")
			changed.sections.investmentJudgments.items[0][key] = impacts.impacts[0].evidenceIds;
		else changed.sections.investmentJudgments.items[0][key] = "不可比数据改判";
		expect(() => validateIterationRevision(basis, changed, impacts, extracted)).toThrow(key);
	}
	const downgraded = structuredClone(candidate);
	downgraded.sections.investmentJudgments.items[0].confidence.level = "low";
	expect(() => validateIterationRevision(basis, downgraded, impacts, extracted)).toThrow("confidence.level");
	const valuation = structuredClone(candidate);
	valuation.sections.valuation.scenarios[0].value = 20;
	expect(() => validateIterationRevision(basis, valuation, impacts, extracted)).toThrow("未重算");
});

it.each(["baseline", "lease"] as const)("blocks collection commits after a concurrent %s change", async (mode) => {
	const { root, run, basis, version } = project();
	const result = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => {
					if (mode === "baseline") {
						const draft = createResearchDraft(root, "dataset_test", basis, [], version.id);
						publishResearchDraft(root, "dataset_test", {
							draftId: draft.id,
							revision: 1,
							expectedVersionId: version.id,
							requestId: "concurrent",
						});
					} else
						withResearchDatabase(root, "dataset_test", (db) =>
							db.prepare("UPDATE framework_iterations SET lease_until=0 WHERE id=?").run(run.id),
						);
					return response();
				});
				return sourceCollectionResult(root, "dataset_test", value.id, "中断");
			},
			extract: async () => {
				throw new Error("unused");
			},
			impact: async () => {
				throw new Error("unused");
			},
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(result.status).toBe("blocked");
	expect(listInformationSourceQueries(root, "dataset_test", run.id)[0].attempts[0].viewDocId).toBeUndefined();
	expect(result.versionId).toBeNull();
});

it("uses collection checkpoint, deduplicates successful queries, isolates evidence, and leaves framework unchanged", async () => {
	const { root, run } = project();
	const fetcher = vi.fn(async () => response());
	const engine: IterationEngine = {
		collect: async (value, _basis, signal) => {
			await fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher);
			await fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher);
			return sourceCollectionResult(root, "dataset_test", value.id, "已取得收入");
		},
		extract: async (value) => observations(root, value),
		impact: async () => ({ substantive: false, summary: "无需修改", impacts: [], gaps: [] }),
		revise: async () => {
			throw new Error("No revision expected");
		},
	};
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		engine,
		async () => {
			throw new Error("No uploads");
		},
		AbortSignal.timeout(5000),
	);
	expect(completed.status, completed.error ?? "").toBe("no_change");
	expect(completed.changeReview).toBe(true);
	expect(completed.automatic).toBe(false);
	expect(completed.artifacts.map((value) => value.stage)).toEqual(["collect", "extract", "impact"]);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(getResearchFramework(root, "dataset_test").versions).toHaveLength(1);
	const records = listInformationSourceQueries(root, "dataset_test", run.id);
	expect(records[0].attempts).toHaveLength(1);
	expect(records[0].actualPeriods).toEqual([...run.sourceConfig!.defaultPeriods].sort());
	expect(records[0].actualQuery).toContain("最新已披露中报或季报");
	expect(records[0].query.periods).toEqual(["2025年年报"]);
	const attempt = records[0].attempts[0];
	expect(JSON.parse(readIterationSourceArchive(root, "dataset_test", run.id, records[0].id, "raw")).response).toEqual(
		response(),
	);
	expect(readIterationSourceArchive(root, "dataset_test", run.id, records[0].id, "text")).toContain("值：9");
	const source = await resolvePeEvidenceSource(root, attempt.evidenceId!);
	expect(source.payload).toMatchObject({
		kind: "text",
		provenance: { sourceId: "wind-financials", companyTicker: "0700.HK" },
	});
	if (source.payload.kind !== "text") throw new Error("Expected source text");
	expect(source.payload.content).toContain("营业收入");
	withResearchDatabase(root, "dataset_test", (db) => {
		expect(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE parser_name='wind_snapshot'").get()?.count).toBe(
			0,
		);
		const paged = readInformationViewRange(db, "dataset_test", attempt.viewDocId!, 1, undefined, 80);
		expect(paged.truncated).toBe(true);
		expect(paged.nextLineStart).toBe(paged.lineEnd + 1);
		expect(paged.text).toBe(
			readInformationView(db, "dataset_test", attempt.viewDocId!)!
				.text.split("\n")
				.slice(0, paged.lineEnd)
				.join("\n"),
		);
		expect(() => readInformationViewRange(db, "dataset_test", attempt.viewDocId!, 1, 10000)).toThrow("行范围");
	});
	await expect(
		resolvePeEvidenceSource(
			root,
			sourceId({ docId: attempt.viewDocId!, location: { kind: "text", lineStart: 1, lineEnd: 10000 } }),
		),
	).rejects.toThrow("lines");
	writeFileSync(join(root, attempt.rawPath!), "tampered");
	await expect(resolvePeEvidenceSource(root, attempt.evidenceId!)).rejects.toThrow("已改变");
});

it("keeps a source candidate pending individual review even when the project is registered for automatic publication", async () => {
	const { root, run } = project();
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => response());
				return sourceCollectionResult(root, "dataset_test", value.id, "需核查");
			},
			extract: async (value) => observations(root, value),
			impact: async (_run, _basis, extracted) => ({
				substantive: true,
				summary: "新增验证问题",
				gaps: [],
				impacts: [
					{
						judgmentIds: ["demand"],
						sections: ["investmentJudgments"],
						observationIds: ["revenue"],
						relation: "unresolved",
						comparable: false,
						comparisonBasis: null,
						reason: "新金额口径待核实",
						proposedChange: "补充取证理由",
						evidenceIds: extracted.observations[0].evidenceIds,
					},
				],
			}),
			revise: async (_run, basis, extracted) => {
				const candidate = structuredClone(basis);
				candidate.sections.researchSetup.informationCutoff = null;
				candidate.sections.investmentJudgments.items[0].rationale = "原判断保留，新增核查财务口径的取证动作";
				candidate.sections.investmentJudgments.items[0].evidenceIds = extracted.observations[0].evidenceIds;
				candidate.sections.evidenceAndChanges.changes = [
					{
						judgmentIds: ["demand"],
						before: "原判断",
						after: "增加取证说明",
						reason: "新金额口径待核实",
						evidenceIds: extracted.observations[0].evidenceIds,
					},
				];
				return candidate;
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(completed.status, completed.error ?? "").toBe("review_required");
	expect(completed.automatic).toBe(false);
	expect(completed.changeReview).toBe(true);
	expect(getIterationChangeReview(root, "dataset_test", completed)?.events).toEqual([]);
	await expect(
		decideFrameworkIteration(root, "dataset_test", run.id, true, AbortSignal.timeout(5000)),
	).rejects.toThrow("逐项审查");
	expect(getResearchFramework(root, "dataset_test").versions).toHaveLength(1);
});

it("checks explicit financial roles and requested/comparison currencies", async () => {
	const { root, run, basis } = project();
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(
					root,
					"dataset_test",
					value,
					{ ...query, currency: "CNY" },
					signal,
					async () => ({
						content: [
							{
								text: JSON.stringify({
									columns: [
										{ name: "Wind代码" },
										{ name: "2025年年报营业收入", unit: "亿英镑", scope: "合并报表", role: "fact" },
									],
									rows: [["0700.HK", 9]],
								}),
							},
						],
					}),
				);
				return sourceCollectionResult(root, "dataset_test", value.id, "币种待核对");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "不修改", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(completed.status, completed.error ?? "").toBe("no_change");
	expect(listInformationSourceQueries(root, "dataset_test", run.id)[0].actualQuery).toContain("以CNY计量");
	expect(completed.reviewReasons.join()).toContain("以返回字段为准");
	const extracted = observations(root, completed);
	const badRole = structuredClone(extracted);
	badRole.observations[0].role = "forecast";
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) => validateIterationAnalysis(db, completed, basis, badRole)),
	).toThrow("来源角色不匹配");
	const impact: IterationImpacts = {
		substantive: false,
		summary: "核对",
		gaps: [],
		impacts: [
			{
				judgmentIds: ["demand"],
				sections: [],
				observationIds: ["revenue"],
				relation: "supports",
				comparable: true,
				comparisonBasis: { period: "2025年年报", periodKind: "cumulative", scope: "合并报表", currency: "CNY" },
				reason: "基线原币CNY",
				proposedChange: null,
				evidenceIds: extracted.observations[0].evidenceIds,
			},
		],
	};
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) =>
			validateIterationAnalysis(db, completed, basis, extracted, impact),
		),
	).toThrow("基线币种");
});

it("distinguishes identical values in different business rows and rejects a borrowed basis quote", async () => {
	const { root, run, basis } = project();
	const completed = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => ({
					content: [
						{
							text: JSON.stringify({
								columns: [
									{ name: "Wind代码" },
									{ name: "2025年年报主营项目名称" },
									{ name: "2025年年报主营项目收入", unit: "CNY亿元", role: "fact" },
								],
								rows: [
									["0700.HK", "授权及服务业务", 9],
									["0700.HK", "产品解决方案", 9],
								],
							}),
						},
					],
				}));
				return sourceCollectionResult(root, "dataset_test", value.id, "两个业务值相同");
			},
			extract: async (value) => observations(root, value),
			impact: async () => ({ substantive: false, summary: "无变化", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(completed.status, completed.error ?? "").toBe("no_change");
	const view = withResearchDatabase(root, "dataset_test", (db) =>
		readInformationViewRange(db, "dataset_test", completed.newDocIds[0]),
	);
	const second = observations(root, completed);
	second.observations[0].quote = view.text.split("\n")[view.locations[1].line - 1];
	second.observations[0].context.scope = "产品解决方案";
	second.observations[0].context.basisQuote = second.observations[0].quote;
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) => validateIterationAnalysis(db, completed, basis, second)),
	).not.toThrow();
	second.observations[0].context.basisQuote = "2025年年报主营项目名称：授权及服务业务";
	expect(() =>
		withResearchDatabase(root, "dataset_test", (db) => validateIterationAnalysis(db, completed, basis, second)),
	).toThrow("不在对应数据行");
});

it("continues with partial results but blocks an entirely empty source run", async () => {
	for (const empty of [false, true]) {
		const { root, run } = project();
		const result = await runFrameworkIteration(
			root,
			"dataset_test",
			run.id,
			{
				collect: async (value, _basis, signal) => {
					await fetchIterationInformation(root, "dataset_test", value, query, signal, async () =>
						empty ? response("AAPL.O") : response(),
					);
					await fetchIterationInformation(
						root,
						"dataset_test",
						value,
						{ ...query, metrics: ["研发费用"] },
						signal,
						async () => {
							throw new Error("WIND_HTTP_403");
						},
					);
					return sourceCollectionResult(root, "dataset_test", value.id, "保留缺口");
				},
				extract: async (value) => observations(root, value),
				impact: async () => ({ substantive: false, summary: "已取得范围内无变化", impacts: [], gaps: [] }),
				revise: async () => {
					throw new Error("No revision");
				},
			},
			async () => ({ docIds: [], warnings: [] }),
			AbortSignal.timeout(5000),
		);
		expect(result.status, result.error ?? "").toBe(empty ? "blocked" : "no_change");
		expect(result.versionId).toBeNull();
		expect(sourceCollectionResult(root, "dataset_test", run.id, "检查").coverage).toBe(empty ? "empty" : "partial");
		if (empty) expect(result.artifacts).toHaveLength(0);
	}
});

it("resumes only failed downstream stages and preserves source quota and receipts", async () => {
	const { root, run } = project();
	const fetcher = vi.fn(async () => response());
	const extract = vi.fn(async (value: typeof run) => observations(root, value));
	let failed = true;
	const engine: IterationEngine = {
		collect: async (value, _basis, signal) => {
			await fetchIterationInformation(root, "dataset_test", value, query, signal, fetcher);
			return sourceCollectionResult(root, "dataset_test", value.id, "已完成");
		},
		extract,
		impact: async () => {
			if (failed) throw new Error("temporary model failure");
			return { substantive: false, summary: "无需调整", impacts: [], gaps: [] };
		},
		revise: async () => {
			throw new Error("unused");
		},
	};
	expect(
		(
			await runFrameworkIteration(
				root,
				"dataset_test",
				run.id,
				engine,
				async () => ({ docIds: [], warnings: [] }),
				AbortSignal.timeout(5000),
			)
		).status,
	).toBe("failed");
	failed = false;
	const restored = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		engine,
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(restored.status, restored.error ?? "").toBe("no_change");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(extract).toHaveBeenCalledTimes(1);
	expect(restored.executionAttempts).toHaveLength(2);
});

it("persists transient retry limits and does not retry authentication errors", async () => {
	const { root, run } = project();
	let calls = 0;
	const result = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => {
					calls++;
					throw new Error("WIND_HTTP_503: authentication, quota or service request failed");
				});
				await fetchIterationInformation(
					root,
					"dataset_test",
					value,
					{ ...query, metrics: ["现金流"] },
					signal,
					async () => {
						calls++;
						throw new Error("WIND_HTTP_401");
					},
				);
				await expect(
					fetchIterationInformation(
						root,
						"dataset_test",
						value,
						{ ...query, metrics: ["另一指标"] },
						signal,
						async () => {
							calls++;
							return response();
						},
					),
				).rejects.toThrow("授权或额度");
				return sourceCollectionResult(root, "dataset_test", value.id, "来源失败");
			},
			extract: async () => {
				throw new Error("unused");
			},
			impact: async () => {
				throw new Error("unused");
			},
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(result.status).toBe("blocked");
	expect(calls).toBe(4);
	expect(listInformationSourceQueries(root, "dataset_test", run.id).map((value) => value.attempts.length)).toEqual([
		3, 1,
	]);
});

it("prevents cancelled, expired and cross-project source writes and preserves pending document runs", async () => {
	const { root, run, version } = project();
	const result = await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await expect(
					fetchIterationInformation(root, "other", value, query, signal, async () => response()),
				).rejects.toThrow();
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () => {
					cancelFrameworkIteration(root, "dataset_test", run.id);
					return response();
				});
				return sourceCollectionResult(root, "dataset_test", value.id, "取消");
			},
			extract: async () => {
				throw new Error("unused");
			},
			impact: async () => {
				throw new Error("unused");
			},
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	expect(result.status).toBe("cancelled");
	expect(listInformationSourceQueries(root, "dataset_test", run.id)[0].attempts[0].viewDocId).toBeUndefined();
	const documentRun = createFrameworkIteration(root, "dataset_test", {
		requestId: "document",
		basisVersionId: version.id,
		modelId: "test",
		uploadIdentity: "file",
		changeReview: true,
	});
	expect(documentRun.processorVersion).toBe("2");
	expect(getFrameworkIteration(root, "dataset_test", documentRun.id).status).toBe("queued");
	withResearchDatabase(root, "dataset_test", (db) =>
		db.prepare("UPDATE framework_iterations SET lease_until=0,status='running' WHERE id=?").run(documentRun.id),
	);
	expect(getFrameworkIteration(root, "dataset_test", documentRun.id).status).toBe("blocked");
});

it("rejects forged text, field/unit bindings and blanket latest-period attribution", async () => {
	const { root, run, basis } = project();
	let captured: typeof run | undefined;
	await runFrameworkIteration(
		root,
		"dataset_test",
		run.id,
		{
			collect: async (value, _basis, signal) => {
				await fetchIterationInformation(root, "dataset_test", value, query, signal, async () =>
					response("0700.HK", "营业收入"),
				);
				return sourceCollectionResult(root, "dataset_test", value.id, "缺少期间");
			},
			extract: async (value) => {
				captured = value;
				return observations(root, value);
			},
			impact: async () => ({ substantive: false, summary: "缺口", impacts: [], gaps: [] }),
			revise: async () => {
				throw new Error("unused");
			},
		},
		async () => ({ docIds: [], warnings: [] }),
		AbortSignal.timeout(5000),
	);
	const good = observations(root, captured!);
	for (const patch of [
		{ quote: "伪造正文9" },
		{ sourceField: "净利润" },
		{ unit: "百万元" },
		{ period: "H1 FY2026" },
	]) {
		const bad = structuredClone(good);
		Object.assign(bad.observations[0], patch);
		expect(() =>
			withResearchDatabase(root, "dataset_test", (db) => validateIterationAnalysis(db, captured!, basis, bad)),
		).toThrow();
	}
	expect(
		readFileSync(
			join(
				root,
				"raw",
				withResearchDatabase(root, "dataset_test", (db) =>
					String(
						db.prepare("SELECT original_filename FROM documents WHERE doc_id=?").get(captured!.newDocIds[0])!
							.original_filename,
					),
				),
			),
			"utf8",
		),
	).toContain("不套用最新报告期");
});
