import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { withResearchDatabase } from "../src/research/storage.ts";
import { sourceId } from "../src/source.ts";
import {
	addSimulatedTrade,
	calculateTrackingPosition,
	getStockTracking,
	refreshStockTracker,
	runDueStockTrackers,
	type StockTrackerInput,
	saveStockTracker,
	type TrackingMarketProvider,
	trackingMarketClock,
} from "../src/tracking.ts";

const roots: string[] = [];
const datasetId = "tracking_test";
const signal = () => new AbortController().signal;
it("saves sourced forecasts without a review form and keeps legacy copies marked until updated", () => {
	const root = project();
	model(root, "doc1", 1, 9);
	const evidenceId = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const basis = { summary: "旧模型历史参考", evidenceIds: [evidenceId] };
	const point = { date: "2026-09-14", price: 10.38, basis };
	const forecast = { bear: 8.78, base: 10.38, bull: 12.73, targetDate: "2027-09-14", basis };
	const input = { ...config(), rule: { kind: "target", base: 9, effectiveDate: "2026-09-01", evidenceId }, basis };
	const first = saveStockTracker(root, datasetId, input, 0);
	const legacy = { ...first.config, valuationEstimates: [point], forecast };
	withResearchDatabase(root, datasetId, (db) => {
		db.prepare("UPDATE stock_trackers SET config_json=? WHERE id=?").run(JSON.stringify(legacy), first.id);
		db.prepare("UPDATE stock_tracking_rules SET config_json=? WHERE tracker_id=?").run(
			JSON.stringify(legacy),
			first.id,
		);
	});
	const read = getStockTracking(root, datasetId, first.id).selected!;
	expect(read.valuationEstimateNeedsUpdate).toBe(true);
	expect(read.forecastNeedsUpdate).toBe(true);
	expect(read.config.valuationEstimates?.[0].price).toBe(10.38);
	expect(read.valuation?.base).toBe(9);
	const paused = saveStockTracker(root, datasetId, { ...read.config, enabled: false }, read.revision);
	expect(paused.forecastNeedsUpdate).toBe(true);
	const updatedBasis = { ...basis, summary: "本轮根据最新数据计算情景" };
	const forecastUpdated = saveStockTracker(
		root,
		datasetId,
		{
			...paused.config,
			forecast: { ...forecast, bear: 4, base: 6, bull: 8, basis: updatedBasis },
		},
		paused.revision,
	);
	expect(forecastUpdated.valuationEstimateNeedsUpdate).toBe(true);
	expect(forecastUpdated.forecastNeedsUpdate).toBe(false);
	expect(forecastUpdated.error).toBeNull();
	const revised = saveStockTracker(
		root,
		datasetId,
		{
			...forecastUpdated.config,
			valuationEstimates: [{ ...point, price: 5, basis: updatedBasis }],
			forecast: { ...forecast, bear: 4, base: 6, bull: 8, basis: updatedBasis },
		},
		forecastUpdated.revision,
	);
	expect(revised.valuationEstimateNeedsUpdate).toBe(false);
	expect(revised.forecastNeedsUpdate).toBe(false);
	expect(revised.config.forecast?.generatedAt).toBe("2026-09-14T09:00:00.000Z");
	expect(revised.config.valuationEstimates?.[0].generatedAt).toBe("2026-09-14T09:00:00.000Z");
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	const resumed = saveStockTracker(root, datasetId, { ...revised.config, enabled: true }, revised.revision);
	expect(resumed.config.forecast).toEqual(revised.config.forecast);
	expect(resumed.config.valuationEstimates).toEqual(revised.config.valuationEstimates);
	const forecastOnly = saveStockTracker(root, datasetId, { ...input, forecast: revised.config.forecast }, 0);
	expect(forecastOnly.config.valuationEstimates).toBeUndefined();
	expect(forecastOnly.forecastNeedsUpdate).toBe(false);
});

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project() {
	const root = mkdtempSync(join(tmpdir(), "pe-tracking-test-"));
	roots.push(root);
	mkdirSync(join(root, "meta"));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), { datasetId, name: "Test" });
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-14T09:00:00Z"));
	return root;
}
const config = (): StockTrackerInput => ({
	name: "腾讯模拟",
	code: "0700.HK",
	currency: "HKD",
	startDate: "2026-09-01",
	targetDate: "2027-09-14",
	enabled: true,
	rule: { kind: "fixed", bear: 80, base: 130, bull: 160 },
});
const provider: TrackingMarketProvider = async () => ({
	fetchedAt: new Date().toISOString(),
	quote: {
		price: 110,
		tradeDate: "2026-09-14",
		asOf: "2026-09-14T08:00:00Z",
		currency: "HKD",
		evidenceId: "source:quote",
	},
	bars: [
		{ date: "2026-09-10", close: 100, currency: "HKD", evidenceId: "source:history" },
		{ date: "2026-09-14", close: 108, currency: "HKD", evidenceId: "source:history" },
	],
	warnings: [],
});
function model(root: string, docId = "doc1", version = 1, value = 10, unit = "HKD/share") {
	withResearchDatabase(root, datasetId, (db) => {
		db.prepare("UPDATE documents SET is_current=0 WHERE dataset_id=? AND logical_doc_id='series1'").run(datasetId);
		db.prepare(
			"INSERT INTO documents(doc_id,dataset_id,original_filename,logical_doc_id,version_no,is_current,file_type,status,created_at,updated_at) VALUES(?,?,?,'series1',?,1,'xlsx','completed',?,?)",
		).run(docId, datasetId, "model.xlsx", version, new Date().toISOString(), new Date().toISOString());
		db.prepare(
			"INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,numeric_value,row_label,period,unit) VALUES(?,?,?,'Valuation','B2',2,2,'number',?,'EPS','2027E',?)",
		).run(`${docId}_b2`, datasetId, docId, value, unit);
	});
}
function cellConfig(): StockTrackerInput {
	return {
		...config(),
		rule: {
			kind: "cell",
			docId: "doc1",
			sheet: "Valuation",
			cell: "B2",
			label: "EPS",
			period: "2027E",
			unit: "HKD/share",
			multipliers: { bear: 8, base: 13, bull: 16 },
			minValue: 1,
			maxValue: 30,
			maxChangePercent: 30,
		},
	};
}

it("calculates fee-inclusive weighted cost, realized gains, dividends and splits", () => {
	const position = calculateTrackingPosition(
		[
			{ requestId: "1", date: "2026-01-01", kind: "buy", quantity: 10, price: 100, fee: 10 },
			{ requestId: "2", date: "2026-01-02", kind: "buy", quantity: 10, price: 120 },
			{ requestId: "3", date: "2026-01-03", kind: "sell", quantity: 5, price: 150, fee: 5 },
			{ requestId: "4", date: "2026-01-04", kind: "dividend", amount: 30 },
			{ requestId: "5", date: "2026-01-05", kind: "split", ratio: 2 },
		],
		60,
	);
	expect(position).toMatchObject({
		quantity: 30,
		cost: 1657.5,
		averageCost: 55.25,
		realizedPnl: 192.5,
		dividends: 30,
		marketValue: 1800,
		unrealizedPnl: 142.5,
		totalPnl: 365,
	});
	expect(position.unrealizedReturnPercent).toBeCloseTo((142.5 / 1657.5) * 100);
	expect(position.returnPercent).toBeCloseTo((365 / 2210) * 100);
});

it("tracks a backdated buy with fee-inclusive P&L, default and custom alerts, and stops alerts when closed", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	expect(first.pnlAlertThresholds).toEqual({ profitPercent: 20, lossPercent: 10 });
	expect(first.pnlAlert).toBeNull();
	const buy = { requestId: "backdated-buy", date: "2026-09-12", kind: "buy", quantity: 10, price: 100, fee: 10 };
	const bought = addSimulatedTrade(root, datasetId, first.id, buy);
	expect(bought.position.cost).toBe(1010);
	expect(bought.pnlAlert).toBeNull();
	expect(bought.position.unrealizedReturnPercent).toBeNull();
	expect(addSimulatedTrade(root, datasetId, first.id, buy).position.quantity).toBe(10);
	const refresh = (price: number) =>
		refreshStockTracker(root, datasetId, first.id, signal(), async () => {
			const data = await provider(root, {
				symbol: "0700.HK",
				currency: "HKD",
				startDate: "2026-09-01",
				endDate: "2026-09-14",
			});
			return { ...data, quote: { ...data.quote!, price }, bars: data.bars.map((bar) => ({ ...bar, close: price })) };
		});
	const profit = await refresh(121.2);
	expect(profit.position.unrealizedReturnPercent).toBeCloseTo(20);
	expect(profit.pnlAlert).toBe("profit");
	expect(profit.observations[0].position.quantity).toBe(10);
	expect(profit.observations[1].position.quantity).toBe(0);
	const loss = await refresh(90.9);
	expect(loss.position.unrealizedReturnPercent).toBeCloseTo(-10);
	expect(loss.pnlAlert).toBe("loss");
	const custom = saveStockTracker(
		root,
		datasetId,
		{
			...loss.config,
			pnlAlertThresholds: { profitPercent: 15, lossPercent: 12 },
		},
		loss.revision,
	);
	expect(custom.pnlAlert).toBeNull();
	const paused = saveStockTracker(
		root,
		datasetId,
		{ ...custom.config, enabled: false, pnlAlertThresholds: undefined },
		custom.revision,
	);
	expect(paused.config.pnlAlertThresholds).toEqual(custom.config.pnlAlertThresholds);
	expect((await refresh(116.15)).pnlAlert).toBe("profit");
	const closed = addSimulatedTrade(root, datasetId, first.id, {
		requestId: "close",
		date: "2026-09-14",
		kind: "sell",
		quantity: 10,
		price: 116.15,
	});
	expect(closed.pnlAlert).toBeNull();
	expect(closed.position.totalPnl).toBeCloseTo(151.5);
	for (const pnlAlertThresholds of [
		{ profitPercent: 0, lossPercent: 10 },
		{ profitPercent: Number.NaN, lossPercent: 10 },
		{ profitPercent: 10001, lossPercent: 10 },
		{ profitPercent: 20, lossPercent: -1 },
		{ profitPercent: 20, lossPercent: 101 },
	])
		expect(() =>
			saveStockTracker(root, datasetId, { ...closed.config, pnlAlertThresholds }, closed.revision),
		).toThrow("提醒阈值");
});

it("persists independent stocks without a published research framework and enforces revisions and date bounds", () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	expect(first.valuation?.base).toBe(130);
	saveStockTracker(root, datasetId, { ...config(), code: "AAPL.O", currency: "USD" }, 0);
	expect(getStockTracking(root, datasetId).trackers).toHaveLength(2);
	expect(() => saveStockTracker(root, datasetId, first.config, 0)).toThrow("changed");
	expect(() => saveStockTracker(root, datasetId, { ...config(), startDate: "2026-02-30" }, 0)).toThrow();
	expect(() => saveStockTracker(root, datasetId, { ...config(), code: "腾讯" }, 0)).toThrow();
	expect(() => saveStockTracker(root, datasetId, { ...config(), currency: "USD" }, 0)).toThrow();
	expect(() => getStockTracking(root, "other", first.id)).toThrow();
});

it("tracks market prices and simulated P&L without a model target, then adds a target without losing history", async () => {
	const root = project();
	model(root);
	withResearchDatabase(root, datasetId, (db) =>
		db
			.prepare(
				"INSERT INTO excel_cells(cell_id,dataset_id,doc_id,sheet_name,cell_ref,row_index,col_index,value_type,raw_value) VALUES('cover',?,'doc1','Cover','A1',1,1,'text','Tencent 0700.HK')",
			)
			.run(datasetId),
	);
	const identity = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Cover", range: "A1" } });
	const input: StockTrackerInput = {
		...config(),
		rule: { kind: "market" },
		basis: { summary: "封面确认公司，无可核验目标价", evidenceIds: [identity] },
	};
	const first = saveStockTracker(root, datasetId, input, 0);
	expect(first).toMatchObject({
		valuation: null,
		valuationStatus: "unavailable",
		status: "ready",
		error: null,
		valuations: [],
	});
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "market-buy",
		date: "2026-09-09",
		kind: "buy",
		quantity: 10,
		price: 90,
	});
	const fetch = vi.fn(provider);
	expect(await runDueStockTrackers(root, datasetId, signal(), fetch)).toBe(1);
	expect(await runDueStockTrackers(root, datasetId, signal(), fetch)).toBe(0);
	const marketOnly = getStockTracking(root, datasetId, first.id).selected!;
	expect(marketOnly).toMatchObject({
		valuation: null,
		status: "attention",
		pnlAlert: "profit",
		error: null,
		valuations: [],
		position: { quantity: 10, totalPnl: 200 },
	});
	expect(
		marketOnly.observations.every(
			(entry) => entry.base === null && entry.bear === null && entry.bull === null && entry.valuationId === null,
		),
	).toBe(true);
	model(root, "target_model", 2, 140);
	const target = sourceId({ docId: "target_model", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const upgraded = saveStockTracker(
		root,
		datasetId,
		{
			...marketOnly.config,
			rule: { kind: "target", base: 140, effectiveDate: "2026-09-14", evidenceId: target },
			basis: { summary: "新增目标价", evidenceIds: [target] },
		},
		marketOnly.revision,
	);
	expect(upgraded.id).toBe(first.id);
	expect(upgraded.observations).toEqual(marketOnly.observations);
	expect(upgraded.trades).toEqual(marketOnly.trades);
	const refreshed = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(refreshed.valuation?.base).toBe(140);
	expect(refreshed.observations.map((entry) => entry.base)).toEqual([140, null]);
	expect(refreshed.position.totalPnl).toBe(200);
	expect(() => saveStockTracker(root, datasetId, { ...config(), rule: { kind: "market" } }, 0)).toThrow(
		"project evidence",
	);
});

it("keeps a market-only forecast under split review until the forecast itself is updated", () => {
	const root = project();
	model(root);
	const basis = {
		summary: "独立研究情景",
		evidenceIds: [sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } })],
	};
	const first = saveStockTracker(
		root,
		datasetId,
		{
			...config(),
			rule: { kind: "market" },
			basis,
			forecast: { bear: 80, base: 120, bull: 160, targetDate: "2027-09-14", basis },
		},
		0,
	);
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "buy",
		date: "2026-09-14",
		kind: "buy",
		quantity: 10,
		price: 100,
	});
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	const split = addSimulatedTrade(root, datasetId, first.id, {
		requestId: "split",
		date: "2026-09-15",
		kind: "split",
		ratio: 2,
	});
	expect(split.valuationStatus).toBe("split_review");
	const paused = saveStockTracker(root, datasetId, { ...split.config, enabled: false }, split.revision);
	expect(paused.valuationStatus).toBe("split_review");
	vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
	const revised = saveStockTracker(
		root,
		datasetId,
		{
			...paused.config,
			forecast: { ...paused.config.forecast, bear: 40, base: 60, bull: 80 },
		},
		paused.revision,
	);
	expect(revised.valuationStatus).toBe("unavailable");
	expect(revised.error).toBeNull();
});

it("keeps an old forecast under split review independently of a new valid post-split model target", () => {
	const root = project();
	model(root);
	const basis = {
		summary: "研究情景",
		evidenceIds: [sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } })],
	};
	const first = saveStockTracker(
		root,
		datasetId,
		{
			...config(),
			rule: { kind: "market" },
			basis,
			forecast: { bear: 80, base: 120, bull: 160, targetDate: "2027-09-14", basis },
		},
		0,
	);
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "buy",
		date: "2026-09-14",
		kind: "buy",
		quantity: 10,
		price: 100,
	});
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	addSimulatedTrade(root, datasetId, first.id, { requestId: "split", date: "2026-09-15", kind: "split", ratio: 2 });
	vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
	model(root, "post_split", 2, 65);
	const evidenceId = sourceId({ docId: "post_split", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const upgraded = saveStockTracker(
		root,
		datasetId,
		{
			...first.config,
			rule: { kind: "target", base: 65, effectiveDate: "2026-09-15", evidenceId },
			basis: { summary: "拆股后模型目标", evidenceIds: [evidenceId] },
		},
		first.revision,
	);
	expect(upgraded.valuationStatus).toBe("valid");
	expect(upgraded.valuation?.base).toBe(65);
	expect(upgraded.forecastSplitReview).toBe(true);
	expect(upgraded.error).toBe("预测每股口径待复核");
	const revised = saveStockTracker(
		root,
		datasetId,
		{
			...upgraded.config,
			forecast: { ...upgraded.config.forecast, bear: 40, base: 60, bull: 80 },
		},
		upgraded.revision,
	);
	expect(revised.valuationStatus).toBe("valid");
	expect(revised.forecastSplitReview).toBe(false);
	expect(revised.error).toBeNull();
});

it("deduplicates simulated entries, rejects overselling and recalculates historical positions for backfills", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	const buy = { requestId: "buy1", date: "2026-09-09", kind: "buy", quantity: 10, price: 90 };
	addSimulatedTrade(root, datasetId, first.id, buy);
	const second = addSimulatedTrade(root, datasetId, first.id, buy);
	expect(second.trades).toHaveLength(1);
	expect(second.observations[1].position.unrealizedPnl).toBe(100);
	expect(second.observations[1].valuationId).toBeNull();
	expect(() => addSimulatedTrade(root, datasetId, first.id, { ...buy, price: 91 })).toThrow("different");
	expect(() =>
		addSimulatedTrade(root, datasetId, first.id, {
			requestId: "sell",
			kind: "sell",
			date: "2026-09-08",
			quantity: 1,
			price: 100,
		}),
	).toThrow("Oversell");
	expect(() =>
		addSimulatedTrade(root, datasetId, first.id, {
			requestId: "sell",
			kind: "sell",
			date: "2026-09-10",
			quantity: 11,
			price: 100,
		}),
	).toThrow("Oversell");
	expect(() =>
		addSimulatedTrade(root, datasetId, first.id, { ...buy, requestId: "future", date: "2026-09-15" }),
	).toThrow();
	expect(getStockTracking(root, datasetId, first.id).selected?.trades).toHaveLength(1);
});

it("keeps historical valuation versions and never backfills older dates using a later model", async () => {
	const root = project();
	model(root);
	const first = saveStockTracker(root, datasetId, cellConfig(), 0);
	let result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.observations[0].base).toBe(130);
	expect(result.observations[1].base).toBeNull();
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	model(root, "doc2", 2, 12);
	result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.valuation).toMatchObject({ base: 156, docId: "doc2" });
	expect(result.valuations).toHaveLength(2);
	expect(result.observations[0].base).toBe(130);
	expect(result.observations[1].base).toBeNull();
	result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.valuations).toHaveLength(2);
	expect(result.observations).toHaveLength(2);
});

it("tracks exact dated model targets before prices load and keeps research forecasts separate", async () => {
	const root = project();
	model(root, "old_model", 1, 90);
	model(root, "new_model", 2, 140);
	const cite = (docId: string) => sourceId({ docId, location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const input: StockTrackerInput = {
		...config(),
		rule: { kind: "target", base: 140, effectiveDate: "2026-09-12", evidenceId: cite("new_model") },
		historicalTargets: [{ date: "2026-09-01", price: 90, evidenceId: cite("old_model") }],
		basis: { summary: "模型目标价", evidenceIds: [cite("new_model")] },
	};
	const first = saveStockTracker(root, datasetId, input, 0);
	expect(first.valuation).toMatchObject({ base: 140, bear: null, bull: null, effectiveDate: "2026-09-12" });
	expect(first.valuations.map((entry) => [entry.effectiveDate, entry.base])).toEqual([
		["2026-09-12", 140],
		["2026-09-01", 90],
	]);
	expect(first.observations).toHaveLength(0);
	await expect(
		refreshStockTracker(root, datasetId, first.id, signal(), async () => {
			throw new Error("Wind unavailable");
		}),
	).rejects.toThrow("Wind unavailable");
	expect(getStockTracking(root, datasetId, first.id).selected?.valuations).toHaveLength(2);
	const prices = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(prices.observations.map((entry) => [entry.date, entry.close, entry.base, entry.downsidePercent])).toEqual([
		["2026-09-14", 108, 140, null],
		["2026-09-10", 100, 90, null],
	]);
	const forecast = {
		bear: 100,
		base: 150,
		bull: 180,
		targetDate: "2027-09-14",
		basis: { summary: "研究情景假设", evidenceIds: [cite("new_model")] },
	};
	const updated = saveStockTracker(root, datasetId, { ...first.config, forecast }, first.revision);
	expect(updated.config.forecast).toMatchObject(forecast);
	expect(updated.valuation?.base).toBe(140);
	expect(updated.valuations).toHaveLength(2);
	expect(updated.observations[1].base).toBe(90);
});

it("updates only the current AI valuation without changing original targets or market prices", async () => {
	const root = project();
	model(root, "doc1", 1, 100);
	const evidenceId = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const basis = { summary: "AI推导：模型100 × 情景系数1.1，沿用模型每股口径", evidenceIds: [evidenceId] };
	const first = saveStockTracker(
		root,
		datasetId,
		{
			...config(),
			rule: { kind: "target", base: 100, effectiveDate: "2026-09-01", evidenceId },
			basis: { summary: "原模型目标100", evidenceIds: [evidenceId] },
			valuationEstimates: [
				{
					date: "2026-09-14",
					price: 120,
					basis: { ...basis, summary: "AI推导：100 × 1.2" },
				},
			],
		},
		0,
	);
	await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	const updated = saveStockTracker(
		root,
		datasetId,
		{
			...first.config,
			valuationEstimates: [
				{
					date: "2026-09-14",
					price: 125,
					basis: { ...basis, summary: "AI推导：100 × 1.25" },
				},
			],
		},
		first.revision,
	);
	expect(updated.config.valuationEstimates?.map((point) => [point.date, point.price])).toEqual([["2026-09-14", 125]]);
	expect(updated.valuation?.base).toBe(100);
	expect(updated.observations.map((point) => [point.close, point.base])).toEqual([
		[108, 100],
		[100, 100],
	]);
	expect(updated.quote?.price).toBe(110);
	withResearchDatabase(root, datasetId, (db) => {
		const previous = db
			.prepare("SELECT config_json FROM stock_tracking_rules WHERE tracker_id=? AND revision=1")
			.get(first.id);
		expect((JSON.parse(String(previous?.config_json)) as StockTrackerInput).valuationEstimates?.[0].price).toBe(120);
	});
	const retained = saveStockTracker(
		root,
		datasetId,
		{ ...updated.config, valuationEstimates: undefined, enabled: false },
		updated.revision,
	);
	expect(retained.config.valuationEstimates).toEqual(updated.config.valuationEstimates);
	model(root, "doc2", 2, 140);
	const newEvidence = sourceId({ docId: "doc2", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const newerModel = saveStockTracker(
		root,
		datasetId,
		{
			...retained.config,
			rule: { kind: "target", base: 140, effectiveDate: "2026-09-10", evidenceId: newEvidence },
			basis: { summary: "新原模型140", evidenceIds: [newEvidence] },
		},
		retained.revision,
	);
	expect(newerModel.config.valuationEstimates).toEqual(retained.config.valuationEstimates);
	expect(() =>
		saveStockTracker(
			root,
			datasetId,
			{
				...newerModel.config,
				valuationEstimates: [{ date: "2026-09-10", price: 142, basis }],
			},
			newerModel.revision,
		),
	).toThrow("venue today");
});

it("hides legacy retrospective estimates while retaining the actual analysis-day point and revision audit", () => {
	const root = project();
	model(root);
	const basis = {
		summary: "当天分析",
		evidenceIds: [sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } })],
	};
	const point = { date: "2026-09-14", price: 120, basis };
	const first = saveStockTracker(
		root,
		datasetId,
		{ ...config(), rule: { kind: "market" }, basis, valuationEstimates: [point] },
		0,
	);
	const legacy = { ...first.config, valuationEstimates: [{ ...point, date: "2026-09-05", price: 110 }, point] };
	withResearchDatabase(root, datasetId, (db) => {
		db.prepare("UPDATE stock_trackers SET config_json=? WHERE id=?").run(JSON.stringify(legacy), first.id);
		db.prepare("UPDATE stock_tracking_rules SET config_json=? WHERE tracker_id=?").run(
			JSON.stringify(legacy),
			first.id,
		);
	});
	expect(getStockTracking(root, datasetId, first.id).selected?.config.valuationEstimates).toEqual([point]);
	const historicalOnly = { ...legacy, valuationEstimates: legacy.valuationEstimates.slice(0, 1) };
	withResearchDatabase(root, datasetId, (db) => {
		db.prepare("UPDATE stock_trackers SET config_json=? WHERE id=?").run(JSON.stringify(historicalOnly), first.id);
		db.prepare("UPDATE stock_tracking_rules SET config_json=? WHERE tracker_id=?").run(
			JSON.stringify(historicalOnly),
			first.id,
		);
	});
	expect(getStockTracking(root, datasetId, first.id).selected?.config.valuationEstimates).toEqual([]);
	withResearchDatabase(root, datasetId, (db) => {
		const saved = db.prepare("SELECT config_json FROM stock_tracking_rules WHERE tracker_id=?").get(first.id);
		expect(JSON.parse(String(saved?.config_json)).valuationEstimates).toHaveLength(1);
	});
});

it("rejects invalid or unsourced AI estimates before saving", () => {
	const root = project();
	model(root);
	const evidenceId = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const basis = { summary: "AI推导：EPS10 × PE12", evidenceIds: [evidenceId] };
	const point = { date: "2026-09-14", price: 120, basis };
	for (const valuationEstimates of [
		[{ ...point, date: "2026-09-13" }],
		[{ ...point, date: "2026-09-15" }],
		[{ ...point, date: "2026-08-31" }],
		[{ ...point, price: Number.NaN }],
		[{ ...point, basis: { ...basis, summary: "" } }],
		[point, point],
		Array.from({ length: 2001 }, () => point),
	])
		expect(() =>
			saveStockTracker(root, datasetId, { ...config(), rule: { kind: "market" }, basis, valuationEstimates }, 0),
		).toThrow("AI valuation estimates");
	const foreign = sourceId({ docId: "foreign", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	expect(() =>
		saveStockTracker(
			root,
			datasetId,
			{
				...config(),
				rule: { kind: "market" },
				basis,
				valuationEstimates: [{ ...point, basis: { ...basis, evidenceIds: [foreign] } }],
			},
			0,
		),
	).toThrow("different project");
	expect(getStockTracking(root, datasetId).trackers).toHaveLength(0);
});

it("does not reuse a pre-split AI estimate as the current per-share valuation", () => {
	const root = project();
	model(root);
	const basis = {
		summary: "AI推导：EPS10 × PE12",
		evidenceIds: [sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } })],
	};
	const first = saveStockTracker(
		root,
		datasetId,
		{
			...config(),
			rule: { kind: "market" },
			basis,
			valuationEstimates: [{ date: "2026-09-14", price: 120, basis }],
		},
		0,
	);
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "buy",
		date: "2026-09-14",
		kind: "buy",
		quantity: 10,
		price: 100,
	});
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	const split = addSimulatedTrade(root, datasetId, first.id, {
		requestId: "split",
		date: "2026-09-15",
		kind: "split",
		ratio: 2,
	});
	expect(split.valuationEstimateSplitReview).toBe(true);
	const paused = saveStockTracker(root, datasetId, { ...split.config, enabled: false }, split.revision);
	expect(paused.valuationEstimateSplitReview).toBe(true);
	vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
	const revised = saveStockTracker(
		root,
		datasetId,
		{
			...paused.config,
			valuationEstimates: [
				{
					date: "2026-09-15",
					price: 60,
					basis: { ...basis, summary: "AI推导：原估值120 ÷ 2，反映一拆二" },
				},
			],
		},
		paused.revision,
	);
	expect(revised.valuationEstimateSplitReview).toBe(false);
	expect(revised.config.valuationEstimates?.map((point) => point.price)).toEqual([60]);
	expect(revised.valuation).toBeNull();
});

it("separates market failures from an expired model with current AI valuation and a future forecast", async () => {
	const root = project();
	model(root, "doc1", 1, 100);
	const evidenceId = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const basis = { summary: "模型100，AI按100 × 1.2推导今天估值", evidenceIds: [evidenceId] };
	const first = saveStockTracker(
		root,
		datasetId,
		{
			...config(),
			targetDate: "2026-09-13",
			rule: { kind: "target", base: 100, effectiveDate: "2026-09-01", evidenceId },
			basis,
			valuationEstimates: [{ date: "2026-09-14", price: 120, basis }],
			forecast: { bear: 100, base: 130, bull: 160, targetDate: "2027-09-14", basis },
		},
		0,
	);
	const current = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(current.marketError).toBeNull();
	expect(current.valuationStatus).toBe("expired");
	expect(current.error).toContain("目标期限已到期");
	expect(current.config.valuationEstimates?.at(-1)?.date).toBe("2026-09-14");
	expect(current.forecastSplitReview).toBe(false);
	withResearchDatabase(root, datasetId, (db) =>
		db.prepare("UPDATE stock_trackers SET error='旧模型警告',valuation_error='旧模型警告' WHERE id=?").run(first.id),
	);
	const legacy = getStockTracking(root, datasetId, first.id).selected!;
	expect(legacy.marketError).toBeNull();
	expect(legacy.error).toContain("旧模型警告");
	await expect(
		refreshStockTracker(root, datasetId, first.id, signal(), async () => {
			throw new Error("Wind offline");
		}),
	).rejects.toThrow("Wind offline");
	expect(getStockTracking(root, datasetId, first.id).selected?.marketError).toBe("Wind offline");
});

it("rejects made-up target values, future source dates, bad caches and invalid forecast ranges", () => {
	const root = project();
	model(root, "model", 1, 140);
	const evidenceId = sourceId({ docId: "model", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const rule = { kind: "target" as const, base: 140, effectiveDate: "2026-09-01", evidenceId };
	expect(() => saveStockTracker(root, datasetId, { ...config(), rule: { ...rule, base: 141 } }, 0)).toThrow(
		"source cell value",
	);
	expect(() =>
		saveStockTracker(root, datasetId, { ...config(), rule: { ...rule, effectiveDate: "2026-09-15" } }, 0),
	).toThrow("non-future");
	expect(() =>
		saveStockTracker(
			root,
			datasetId,
			{ ...config(), rule, historicalTargets: [{ date: "2026-08-01", price: 100, evidenceId }] },
			0,
		),
	).toThrow("source cell value");
	expect(() =>
		saveStockTracker(
			root,
			datasetId,
			{
				...config(),
				rule,
				forecast: {
					bear: 160,
					base: 150,
					bull: 180,
					targetDate: "2027-01-01",
					basis: { summary: "forecast", evidenceIds: [evidenceId] },
				},
			},
			0,
		),
	).toThrow("ordered range");
	withResearchDatabase(root, datasetId, (db) =>
		db.prepare("UPDATE excel_cells SET is_formula=1,formula_cache_status='missing' WHERE doc_id='model'").run(),
	);
	expect(() => saveStockTracker(root, datasetId, { ...config(), rule }, 0)).toThrow("numeric cache");
	expect(getStockTracking(root, datasetId).trackers).toHaveLength(0);
});

it("can pause with an unchanged expired forecast but rejects new or changed expired forecasts", () => {
	const root = project();
	model(root);
	const evidenceId = sourceId({ docId: "doc1", location: { kind: "excel", sheet: "Valuation", range: "B2" } });
	const forecast = {
		bear: 80,
		base: 120,
		bull: 150,
		targetDate: "2026-09-15",
		basis: { summary: "情景假设", evidenceIds: [evidenceId] },
	};
	const first = saveStockTracker(root, datasetId, { ...config(), forecast }, 0);
	vi.setSystemTime(new Date("2026-09-16T09:00:00Z"));
	const paused = saveStockTracker(root, datasetId, { ...first.config, enabled: false }, first.revision);
	expect(paused.config.enabled).toBe(false);
	expect(paused.config.forecast).toMatchObject(forecast);
	expect(() => saveStockTracker(root, datasetId, { ...config(), forecast }, 0)).toThrow("future target date");
	expect(() =>
		saveStockTracker(root, datasetId, { ...paused.config, forecast: { ...forecast, base: 125 } }, paused.revision),
	).toThrow("future target date");
});

it("retains the last valid model on mismatched units, missing caches, bounds and excessive changes", async () => {
	const root = project();
	model(root);
	const first = saveStockTracker(root, datasetId, cellConfig(), 0);
	model(root, "doc2", 2, 12, "CNY/share");
	let result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.valuation?.base).toBe(130);
	expect(result.error).toContain("单位");
	expect(result.marketError).toBeNull();
	expect(result.valuationStatus).toBe("stale");
	withResearchDatabase(root, datasetId, (db) =>
		db
			.prepare(
				"UPDATE excel_cells SET unit='HKD/share',is_formula=1,formula='=6*2',formula_cache_status='missing' WHERE doc_id='doc2'",
			)
			.run(),
	);
	result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.error).toContain("缓存");
	expect(result.valuations).toHaveLength(1);
	withResearchDatabase(root, datasetId, (db) =>
		db.prepare("UPDATE excel_cells SET is_formula=0,numeric_value=40 WHERE doc_id='doc2'").run(),
	);
	result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.error).toContain("范围");
	withResearchDatabase(root, datasetId, (db) =>
		db.prepare("UPDATE excel_cells SET numeric_value=20 WHERE doc_id='doc2'").run(),
	);
	result = await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	expect(result.error).toContain("幅度");
	expect(result.valuation?.base).toBe(130);
});

it("does not overwrite good prices on failure or accept a late response after a settings change", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	await expect(
		refreshStockTracker(root, datasetId, first.id, signal(), async () => {
			throw new Error("source down");
		}),
	).rejects.toThrow("source down");
	expect(getStockTracking(root, datasetId, first.id).selected?.quote?.price).toBe(110);
	await expect(
		refreshStockTracker(root, datasetId, first.id, signal(), async (...args) => {
			saveStockTracker(root, datasetId, { ...first.config, enabled: false }, 1);
			return provider(...args);
		}),
	).rejects.toThrow("late response");
	expect(getStockTracking(root, datasetId, first.id).selected?.status).toBe("paused");
});

it("rolls back the whole refresh on invalid market values", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	await expect(
		refreshStockTracker(root, datasetId, first.id, signal(), async (...args) => {
			const data = await provider(...args);
			data.bars[1].close = Number.NaN;
			return data;
		}),
	).rejects.toThrow("Invalid");
	expect(getStockTracking(root, datasetId, first.id).selected?.observations).toHaveLength(0);
});

it("flags split basis changes and avoids marking new shares with pre-split prices", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, config(), 0);
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "buy",
		date: "2026-09-14",
		kind: "buy",
		price: 100,
		quantity: 10,
	});
	await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	const updated = addSimulatedTrade(root, datasetId, first.id, {
		requestId: "split",
		date: "2026-09-15",
		kind: "split",
		ratio: 2,
	});
	expect(updated.valuationStatus).toBe("split_review");
	expect(updated.position.quantity).toBe(20);
	expect(updated.position.unrealizedPnl).toBeNull();
	expect(updated.position.averageCost).toBe(50);
});

it("uses newer close data and marks expired valuation horizons", async () => {
	const root = project();
	const first = saveStockTracker(root, datasetId, { ...config(), targetDate: "2026-09-14" }, 0);
	addSimulatedTrade(root, datasetId, first.id, {
		requestId: "buy",
		date: "2026-09-14",
		kind: "buy",
		price: 100,
		quantity: 10,
	});
	const result = await refreshStockTracker(root, datasetId, first.id, signal(), async (...args) => {
		const data = await provider(...args);
		data.quote!.tradeDate = "2026-09-11";
		data.quote!.asOf = "2026-09-11T08:00:00Z";
		return data;
	});
	expect(result.position.marketValue).toBe(1080);
	vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
	expect(getStockTracking(root, datasetId, first.id).selected?.valuationStatus).toBe("expired");
});

it("schedules after the local market close with US DST and does not repeat a completed day", async () => {
	const root = project();
	saveStockTracker(root, datasetId, config(), 0);
	expect(trackingMarketClock("AAPL.O", new Date("2026-09-14T20:31:00Z")).afterClose).toBe(true);
	expect(trackingMarketClock("AAPL.O", new Date("2026-12-14T20:31:00Z")).afterClose).toBe(false);
	expect(trackingMarketClock("AAPL.O", new Date("2026-12-14T21:31:00Z")).afterClose).toBe(true);
	const fetch = vi.fn(provider);
	expect(await runDueStockTrackers(root, datasetId, signal(), fetch)).toBe(1);
	expect(await runDueStockTrackers(root, datasetId, signal(), fetch)).toBe(0);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects incompatible currencies and totals even when analyst and cell unit strings agree", () => {
	const root = project();
	model(root);
	const c = cellConfig();
	if (c.rule.kind !== "cell") throw new Error("fixture");
	expect(() => saveStockTracker(root, datasetId, { ...c, rule: { ...c.rule, unit: "USD/share" } }, 0)).toThrow(
		"currency per share",
	);
	expect(() => saveStockTracker(root, datasetId, { ...c, rule: { ...c.rule, unit: "HKD" } }, 0)).toThrow(
		"currency per share",
	);
});

it("updates today's valuation, requests incremental prices and keeps tracking after target expiry", async () => {
	const root = project();
	model(root);
	const first = saveStockTracker(root, datasetId, { ...cellConfig(), targetDate: "2026-09-14" }, 0);
	await refreshStockTracker(root, datasetId, first.id, signal(), provider);
	vi.setSystemTime(new Date("2026-09-14T10:00:00Z"));
	model(root, "doc2", 2, 12);
	const fetch = vi.fn(provider);
	const changed = await refreshStockTracker(root, datasetId, first.id, signal(), fetch);
	expect(fetch.mock.calls[0][1].startDate).toBe("2026-09-14");
	expect(changed.observations[0].base).toBe(156);
	expect(changed.observations[1].base).toBeNull();
	vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
	expect(await runDueStockTrackers(root, datasetId, signal(), fetch)).toBe(1);
	expect(getStockTracking(root, datasetId, first.id).selected?.valuationStatus).toBe("expired");
});

it("still refreshes after close following a morning check and bounds delayed-bar retries", async () => {
	const root = project();
	vi.setSystemTime(new Date("2026-09-14T02:00:00Z"));
	const first = saveStockTracker(root, datasetId, config(), 0);
	const delayed = vi.fn<TrackingMarketProvider>(async () => ({
		fetchedAt: new Date().toISOString(),
		quote: null,
		bars: [],
		warnings: ["Daily bar not ready"],
	}));
	await refreshStockTracker(root, datasetId, first.id, signal(), delayed);
	vi.setSystemTime(new Date("2026-09-14T08:30:00Z"));
	expect(await runDueStockTrackers(root, datasetId, signal(), delayed)).toBe(1);
	vi.setSystemTime(new Date("2026-09-14T08:45:00Z"));
	expect(await runDueStockTrackers(root, datasetId, signal(), delayed)).toBe(0);
	vi.setSystemTime(new Date("2026-09-14T09:00:00Z"));
	expect(await runDueStockTrackers(root, datasetId, signal(), delayed)).toBe(1);
	vi.setSystemTime(new Date("2026-09-14T11:00:00Z"));
	expect(await runDueStockTrackers(root, datasetId, signal(), delayed)).toBe(0);
	expect(delayed).toHaveBeenCalledTimes(3);
});
