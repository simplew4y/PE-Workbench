import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import * as evidence from "../src/evidence.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import { peStockTrackingTool } from "../src/tools/stock-tracking.ts";
import {
	addSimulatedTrade,
	type StockTrackerInput,
	type StockTrackingState,
	saveStockTracker,
	saveStockTrackerWithSources,
	trackingMarketClock,
} from "../src/tracking.ts";
import { writeWorkbookFixture } from "./workbook-source-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Config = StockTrackerInput & { basis: NonNullable<StockTrackerInput["basis"]> };
type ToolDetails = StockTrackingState & {
	project?: { name: string };
	documents?: Array<{ doc_id: string }>;
	mutation: string | null;
	trackerId: string | null;
};
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pe-stock-agent-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "meta"));
	const datasetId = "dataset_agent_tracking";
	initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "腾讯研究" });
	withResearchDatabase(cwd, datasetId, (db) => {
		const insert = db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,logical_doc_id,file_type,status,company_ticker,created_at,updated_at) VALUES(?,?,?,?,'xlsx','completed','0700.HK',?,?)",
		);
		insert.run("model", datasetId, "model.xlsx", "series_model", "2026-01-01", "2026-01-01");
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('notes',?,'notes.md','md','completed','2026-01-01','2026-01-01')",
		).run(datasetId);
	});
	writeWorkbookFixture(cwd, "model", [
		{ sheet: "Valuation", cell: "A2", value: "EPS" },
		{ sheet: "Valuation", cell: "B1", value: "2027E" },
		{ sheet: "Valuation", cell: "B2", value: 10 },
		{ sheet: "Valuation", cell: "C2", value: "HKD/share" },
		{ sheet: "Cover", cell: "A1", value: "Tencent 0700.HK" },
	]);
	const basis = {
		summary: "原模型EPS为10 HKD/股；8/10/12倍及观察期限为分析师情景假设。",
		evidenceIds: [sourceId({ docId: "model", location: { kind: "excel", sheet: "Valuation", range: "B2" } })],
	};
	const config: Config = {
		name: "腾讯",
		code: "0700.HK",
		currency: "HKD",
		startDate: "2026-01-01",
		targetDate: "2027-12-31",
		enabled: true,
		rule: {
			kind: "cell",
			docId: "model",
			sheet: "Valuation",
			cell: "B2",
			label: "EPS",
			period: "2027E",
			unit: "HKD/share",
			context: {
				label: { sheet: "Valuation", cell: "A2", text: "EPS" },
				period: { sheet: "Valuation", cell: "B1", text: "2027E" },
				unit: { sheet: "Valuation", cell: "C2", text: "HKD/share" },
			},
			multipliers: { bear: 8, base: 10, bull: 12 },
			minValue: 1,
			maxValue: 20,
		},
		basis,
	};
	const ctx = { cwd } as Parameters<typeof peStockTrackingTool.execute>[4];
	const run = async (
		params: Parameters<typeof peStockTrackingTool.execute>[1],
		signal = new AbortController().signal,
	) => {
		const result = await peStockTrackingTool.execute("call", params, signal, undefined, ctx);
		return { ...result, details: result.details as ToolDetails };
	};
	return { cwd, datasetId, config, run };
}

it("exposes bounded simulated holdings to the agent and requires an explicit tracker to refresh", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pe-stock-tool-"));
	try {
		for (const name of ["raw", "meta", "generated"]) mkdirSync(join(cwd, name));
		const datasetId = "dataset_tool_test";
		initializePeCollectionDatabase(join(cwd, "meta/collection.sqlite3"), { datasetId, name: "Test" });
		const tracker = saveStockTracker(
			cwd,
			datasetId,
			{
				name: "模拟",
				code: "0700.HK",
				currency: "HKD",
				enabled: false,
				startDate: "2026-01-01",
				targetDate: "2027-12-31",
				rule: { kind: "fixed", bear: 80, base: 120, bull: 150 },
			},
			0,
		);
		for (const requestId of ["first", "second"])
			addSimulatedTrade(cwd, datasetId, tracker.id, {
				requestId,
				date: "2026-01-02",
				kind: "buy",
				quantity: 100,
				price: 95,
			});
		const context = { cwd } as Parameters<typeof peStockTrackingTool.execute>[4];
		const signal = new AbortController().signal;
		const result = await peStockTrackingTool.execute(
			"read",
			{ operation: "read", tracker_id: tracker.id, limit: 1 },
			signal,
			undefined,
			context,
		);
		const details = result.details as {
			selected: { position: { quantity: number }; trades: unknown[]; truncated: boolean };
		};
		expect(details.selected.position.quantity).toBe(200);
		expect(details.selected.trades).toHaveLength(1);
		expect(details.selected.truncated).toBe(true);
		await expect(
			peStockTrackingTool.execute("bad", { operation: "refresh" }, signal, undefined, context),
		).rejects.toThrow("tracker_id");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("lets the agent discover its project documents and configure sourced rules with a mutation receipt", async () => {
	const { config, run } = fixture();
	const context = (await run({ operation: "context" })).details;
	expect(context.project?.name).toBe("腾讯研究");
	expect(context.documents?.map((document) => document.doc_id).sort()).toEqual(["model", "notes"]);
	const result = (await run({ operation: "configure", config, revision: 0 })).details;
	expect(result.mutation).toBe("configured");
	expect(result.trackerId).toBe(result.selected?.id);
	expect(result.selected?.config.enabled).toBe(true);
	expect(result.selected?.valuation).toMatchObject({ bear: 80, base: 100, bull: 120, basis: config.basis });
	expect(result.selected?.trades).toHaveLength(0);
	await expect(
		run({ operation: "configure", config: { ...config, id: result.trackerId! }, revision: 0 }),
	).rejects.toThrow("changed");
});

it("lets the agent create market tracking from identity evidence without inventing model targets", async () => {
	const { config, run } = fixture();
	const basis = {
		summary: "公司封面确认证券；模型无目标价",
		evidenceIds: [sourceId({ docId: "model", location: { kind: "excel", sheet: "Cover", range: "A1" } })],
	};
	const result = (
		await run({ operation: "configure", config: { ...config, rule: { kind: "market" }, basis }, revision: 0 })
	).details;
	expect(result.mutation).toBe("configured");
	expect(result.selected).toMatchObject({
		config: { rule: { kind: "market" }, basis },
		valuation: null,
		valuations: [],
		error: null,
		status: "ready",
	});
	const forecast = {
		bear: 80,
		base: 120,
		bull: 150,
		targetDate: "2027-12-31",
		basis: config.basis,
	};
	const updated = (
		await run({
			operation: "configure",
			config: { ...result.selected!.config, forecast },
			revision: result.selected!.revision,
		})
	).details;
	expect(updated.selected?.config.forecast).toMatchObject(forecast);
	expect(updated.selected?.valuation).toBeNull();
	const foreign = sourceId({ docId: "foreign", location: { kind: "excel", sheet: "Cover", range: "A1" } });
	await expect(
		run({
			operation: "configure",
			config: { ...config, rule: { kind: "market" }, basis: { ...basis, evidenceIds: [foreign] } },
			revision: 0,
		}),
	).rejects.toThrow("different project");
});

it("rejects other-project sources and cancellation before configuration", async () => {
	const { config, run } = fixture();
	const foreign = sourceId({ docId: "foreign", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	await expect(
		run({
			operation: "configure",
			config: { ...config, basis: { ...config.basis, evidenceIds: [foreign] } },
			revision: 0,
		}),
	).rejects.toThrow("different project");
	await expect(run({ operation: "configure" })).rejects.toThrow("source basis");
	await expect(run({ operation: "configure", config, revision: 0 }, AbortSignal.abort())).rejects.toThrow();
	expect((await run({ operation: "read" })).details.trackers).toHaveLength(0);
});

it("discovers historical models and resolves memo citations before saving a separate forecast", async () => {
	const { cwd, datasetId, config, run } = fixture();
	withResearchDatabase(cwd, datasetId, (db) => {
		db.prepare("UPDATE documents SET version_no=2 WHERE doc_id='model'").run();
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,logical_doc_id,file_type,status,is_current,created_at,updated_at) VALUES('older',?,'older.xlsx','series_model','xlsx','completed',0,'2025-01-01','2025-01-01')",
		).run(datasetId);
	});
	expect((await run({ operation: "context" })).details.documents?.map((document) => document.doc_id)).toContain(
		"older",
	);
	const memo = sourceId({ docId: "notes", location: { kind: "text", lineStart: 1, lineEnd: 1 } });
	const sources = vi.spyOn(evidence, "resolvePeEvidenceSources").mockResolvedValue(
		new Map([
			[
				memo,
				{
					kind: "text",
					dataset_id: datasetId,
					doc_id: "notes",
					version_no: 1,
					evidence_id: memo,
					citation: "notes.md L1",
					markdown_citation: "notes",
					filename: "notes.md",
					warnings: [],
					content: "Scenario analysis",
					truncated: false,
				},
			],
		]),
	);
	const forecast = {
		bear: 80,
		base: 110,
		bull: 140,
		targetDate: "2027-12-31",
		basis: { summary: "根据memo更新情景假设", evidenceIds: [memo] },
	};
	const valuationEstimates = [{ date: trackingMarketClock(config.code).date, price: 12, basis: forecast.basis }];
	const result = (
		await run({
			operation: "configure",
			config: {
				...config,
				rule: { kind: "target", base: 10, effectiveDate: "2026-01-01", evidenceId: config.basis.evidenceIds[0] },
				forecast,
				valuationEstimates,
			},
			revision: 0,
		})
	).details;
	expect(sources).toHaveBeenCalledWith(realpathSync(cwd), [memo], expect.any(AbortSignal));
	expect(result.selected?.valuation).toMatchObject({ base: 10, bear: null, bull: null });
	expect(result.selected?.config.forecast).toMatchObject(forecast);
	expect(result.selected?.config.valuationEstimates).toMatchObject(valuationEstimates);
	const recent = (await run({ operation: "read", tracker_id: result.trackerId!, limit: 1 })).details;
	expect(recent.selected?.config.valuationEstimates).toMatchObject(valuationEstimates.slice(-1));
	expect(recent.trackers[0].config.valuationEstimates).toMatchObject(valuationEstimates.slice(-1));
	expect(recent.selected).toMatchObject({
		valuationEstimatesTotal: 1,
		valuationEstimatesTruncated: false,
		truncated: false,
	});
	const paused = await saveStockTrackerWithSources(
		cwd,
		datasetId,
		{ ...result.selected!.config, enabled: false },
		result.selected!.revision,
	);
	expect(paused.config.enabled).toBe(false);
	expect(paused.config.forecast).toMatchObject(forecast);
	expect(paused.config.valuationEstimates).toMatchObject(valuationEstimates);
});

it("records only supplied simulated trade fields and reuses their request IDs", async () => {
	const { config, run } = fixture();
	const { trackerId } = (await run({ operation: "configure", config, revision: 0 })).details;
	const trade = { requestId: "user-purchase", date: "2026-01-03", kind: "buy" as const, price: 95, quantity: 100 };
	const result = (await run({ operation: "trade", tracker_id: trackerId!, trade })).details;
	expect(result.mutation).toBe("trade_recorded");
	expect(result.selected?.position.quantity).toBe(100);
	expect((await run({ operation: "trade", tracker_id: trackerId!, trade })).details.selected?.trades).toHaveLength(1);
	await expect(run({ operation: "trade", tracker_id: trackerId! })).rejects.toThrow("transaction details");
	await expect(
		run({
			operation: "trade",
			tracker_id: trackerId!,
			trade: { requestId: "incomplete", date: "2026-01-03", kind: "buy" },
		}),
	).rejects.toThrow("Quantity and price");
});

it("normalizes returned PDF page citations for tracking, forecasts and estimates without accepting missing sources", async () => {
	const { config, run, cwd, datasetId } = fixture();
	withResearchDatabase(cwd, datasetId, (db) => {
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,file_type,status,created_at,updated_at) VALUES('pdf',?,'report.pdf','pdf','completed','before','before')",
		).run(datasetId);
		db.exec(
			"INSERT INTO pdf_pages VALUES('identity_page','pdf',1,'Tencent 0700.HK','p1','body','{}','good','{}',100,100,0,'[]',0,0,0)",
		);
	});
	const canonical = sourceId({ docId: "pdf", location: { kind: "pdf", pageStart: 1, pageEnd: 1 } });
	const basis = { summary: "已核对公司封面；价格预测为验收假设", evidenceIds: ["page:identity_page", canonical] };
	const result = (
		await run({
			operation: "configure",
			revision: 0,
			config: {
				...config,
				rule: { kind: "market" },
				basis,
				forecast: { bear: 80, base: 100, bull: 120, targetDate: "2027-12-31", basis },
				valuationEstimates: [{ date: trackingMarketClock(config.code).date, price: 100, basis }],
			},
		})
	).details;
	expect(result.mutation).toBe("configured");
	expect(result.selected?.config.basis?.evidenceIds).toEqual([canonical]);
	expect(result.selected?.config.forecast?.basis.evidenceIds).toEqual([canonical]);
	expect(result.selected?.config.valuationEstimates?.[0].basis.evidenceIds).toEqual([canonical]);
	expect(result.selected?.valuation).toBeNull();
	await expect(
		run({
			operation: "configure",
			revision: 0,
			config: { ...config, rule: { kind: "market" }, basis: { ...basis, evidenceIds: ["page:missing"] } },
		}),
	).rejects.toThrow();
	expect((await run({ operation: "read" })).details.trackers).toHaveLength(1);
});
