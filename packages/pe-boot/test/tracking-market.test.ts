import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializePeCollectionDatabase } from "../src/collection-schema.ts";
import { resolvePeEvidenceSource } from "../src/evidence.ts";
import { parseSourceId } from "../src/source.ts";
import { fetchTrackingMarketData } from "../src/tracking-market.ts";
import { fetchWindSnapshot, listWindSnapshots, queryWind } from "../src/trusted-sources.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
	const root = mkdtempSync(join(tmpdir(), "pe-tracking-market-"));
	roots.push(root);
	mkdirSync(join(root, "raw"));
	mkdirSync(join(root, "meta"));
	initializePeCollectionDatabase(join(root, "meta/collection.sqlite3"), { datasetId: "tracking_test", name: "Test" });
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-14T17:00:00+08:00"));
	return root;
}

const input = { symbol: "0700.HK", currency: "HKD", startDate: "2026-09-10", endDate: "2026-09-14" };
const quote = () => ({
	columns: ["最新交易日", "交易时间", "最新成交价", "Wind代码"].map((name) => ({ name, type: "string" })),
	rows: [["20260914", "2026-09-14T16:08:10.000+08:00", "103.600", "0700.HK"]],
	unit: { 最新成交价: "港币" },
});
// Shape captured from Wind get_stock_kline on 2026-09-14, prices changed to fixture values.
const history = () => ({
	columns: ["TIME", "OPEN", "MATCH", "HIGH", "LOW", "TURNOVER", "VOLUME", "CHANGEHANDRATE", "AVPRICE"].map((name) => ({
		name,
		type: "string",
	})),
	rows: [
		["2026-09-10T00:00:00.000+08:00", "100", "102.600", "104", "99", "1000000", "10000", "0.2", "102"],
		["2026-09-11T00:00:00.000+08:00", "101", "101.400", "103", "100", "1000000", "10000", "0.2", "102"],
	],
	unit: {
		"HIGH 单位：": "港币",
		"LOW 单位：": "港币",
		"MATCH 单位：": "港币",
		"OPEN 单位：": "港币",
		"VOLUME 单位：": "股",
	},
});

function mockWind(quoteData: unknown = quote(), historyData: unknown = history()) {
	vi.stubEnv("WIND_API_KEY", "tracking-test-key");
	const mock = vi.fn(async (_url: string, options: RequestInit) => {
		const request = JSON.parse(String(options.body));
		const result =
			request.method === "initialize"
				? { protocolVersion: "2025-03-26" }
				: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									data: request.params.name === "get_stock_kline" ? historyData : quoteData,
									error: null,
								}),
							},
						],
					};
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

it("parses the observed Wind tables, keeps quote time separate and saves versioned evidence without duplicating identical data", async () => {
	const root = project();
	const mock = mockWind();
	const result = await fetchTrackingMarketData(root, input);
	expect(result).toMatchObject({
		fetchedAt: "2026-09-14T09:00:00.000Z",
		quote: { price: 103.6, tradeDate: "2026-09-14", asOf: "2026-09-14T16:08:10.000+08:00", currency: "HKD" },
		warnings: [],
	});
	expect(result.bars.map((bar) => [bar.date, bar.close])).toEqual([
		["2026-09-10", 102.6],
		["2026-09-11", 101.4],
	]);
	expect(result.bars.some((bar) => bar.date === result.quote?.tradeDate)).toBe(false);
	expect(JSON.parse(String(mock.mock.calls[3][1].body)).params).toEqual({
		name: "get_stock_kline",
		arguments: {
			windcode: "0700.HK",
			begin_date: input.startDate,
			end_date: input.endDate,
			period: "10",
			count: 0,
			aftype: "2",
			issusp: "0",
		},
	});
	for (const evidenceId of [result.quote!.evidenceId, result.bars[0].evidenceId])
		expect((await resolvePeEvidenceSource(root, evidenceId)).payload.kind).toBe("text");
	expect((await fetchTrackingMarketData(root, input)).bars[0].evidenceId).toBe(result.bars[0].evidenceId);
	expect(listWindSnapshots(root)).toHaveLength(2);
	const nextHistory = history();
	nextHistory.rows[0][2] = "103.000";
	mockWind(quote(), nextHistory);
	expect((await fetchTrackingMarketData(root, input)).bars[0].evidenceId).not.toBe(result.bars[0].evidenceId);
	expect(listWindSnapshots(root)).toHaveLength(3);
	const otherRange = await fetchWindSnapshot(root, {
		category: "history",
		query: input.symbol,
		startDate: "2026-09-01",
		endDate: input.endDate,
	});
	expect(otherRange.version).toBe(1);
	expect(otherRange.preview).toContain('"adjustment": "unadjusted"');
});

it.each([
	[
		"wrong currency",
		(data: ReturnType<typeof quote>) => {
			data.unit.最新成交价 = "美元";
		},
		"CURRENCY",
	],
	[
		"wrong stock",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][3] = "9988.HK";
		},
		"SYMBOL",
	],
	[
		"multiple stocks",
		(data: ReturnType<typeof quote>) => {
			data.rows.push([...data.rows[0].slice(0, 3), "9988.HK"]);
		},
		"SYMBOL",
	],
	[
		"date mismatch",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][0] = "20260911";
		},
		"TIME",
	],
	[
		"impossible date",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][0] = "20260230";
		},
		"DATE",
	],
	[
		"no timezone",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][1] = "2026-09-14T16:08:10";
		},
		"TIME",
	],
	[
		"future time",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][1] = "2026-09-14T18:08:10+08:00";
		},
		"TIME",
	],
	[
		"missing price",
		(data: ReturnType<typeof quote>) => {
			data.rows[0][2] = "--";
		},
		"PRICE",
	],
] as const)("rejects %s without returning a normalized price", async (_name, change, error) => {
	const root = project();
	const data = quote();
	change(data);
	mockWind(data);
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow(`WIND_MARKET_${error}`);
});

it("rejects out-of-range or duplicate bars and accepts an explicitly empty history", async () => {
	const root = project();
	const data = history();
	data.rows[0][0] = "2026-09-09T00:00:00.000+08:00";
	mockWind(quote(), data);
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_MARKET_RANGE");
	data.rows[0][0] = data.rows[1][0];
	mockWind(quote(), data);
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_MARKET_DUPLICATE");
	mockWind(quote(), { columns: [], rows: [], unit: {} });
	expect(await fetchTrackingMarketData(root, input)).toMatchObject({
		bars: [],
		warnings: [expect.stringContaining("没有日线")],
	});
	mockWind({ columns: [], rows: [], unit: {} });
	expect(await fetchTrackingMarketData(root, input)).toMatchObject({ quote: null, bars: expect.any(Array) });
});

it("filters an unfinished current-day K line without treating normal intraday data as a warning", async () => {
	const root = project();
	vi.setSystemTime(new Date("2026-09-14T15:00:00+08:00"));
	const data = history();
	data.rows[1][0] = "2026-09-14T00:00:00.000+08:00";
	const currentQuote = quote();
	currentQuote.rows[0][1] = "2026-09-14T14:58:10.000+08:00";
	mockWind(currentQuote, data);
	expect(await fetchTrackingMarketData(root, input)).toMatchObject({
		quote: { tradeDate: "2026-09-14" },
		bars: [{ date: "2026-09-10" }],
		warnings: [],
	});
});

it("requires price units and rejects contradictory units or an explicit wrong historical stock code", async () => {
	const root = project();
	mockWind(quote(), { ...history(), unit: {} });
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_MARKET_CURRENCY");
	const conflicting = history();
	mockWind(quote(), {
		...conflicting,
		columns: conflicting.columns.map((column) => (column.name === "MATCH" ? { ...column, unit: "USD" } : column)),
	});
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_MARKET_CURRENCY");
	mockWind(quote(), {
		...history(),
		columns: [...history().columns, { name: "Wind代码", type: "string" }],
		rows: history().rows.map((row) => [...row, "9988.HK"]),
	});
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_MARKET_SYMBOL");
});

it("validates dates before querying and preserves authentication failures", async () => {
	const root = project();
	const mock = mockWind();
	await expect(
		queryWind({ category: "history", query: input.symbol, startDate: "2026-02-30", endDate: input.endDate }),
	).rejects.toThrow("valid YYYY-MM-DD");
	expect(mock).not.toHaveBeenCalled();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("secret", { status: 403 })),
	);
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow("WIND_HTTP_403");
	expect(listWindSnapshots(root)).toHaveLength(0);
});

it("identifies a failed history request and keeps already-fetched quote evidence", async () => {
	const root = project();
	const mock = mockWind();
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		const request = JSON.parse(String(options.body));
		if (request.params?.name === "get_stock_kline")
			throw new Error("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
		return mock(url, options);
	});
	await expect(fetchTrackingMarketData(root, input)).rejects.toThrow(
		"WIND_TRACKING_HISTORY: 历史日线更新失败；fetch failed (UND_ERR_CONNECT_TIMEOUT)",
	);
	expect(listWindSnapshots(root)).toHaveLength(1);
});

it("accepts an internal-dot US ticker and resolves a long history's tail price from its own bounded source", async () => {
	const root = project();
	vi.setSystemTime(new Date("2026-09-14T17:00:00Z"));
	const stockQuote = quote();
	stockQuote.rows[0] = ["20260914", "2026-09-14T12:00:00.000-04:00", "500.100", "BRK.B.N"];
	stockQuote.unit.最新成交价 = "美元";
	const data = history();
	data.unit["MATCH 单位："] = "美元";
	data.rows = Array.from({ length: 1300 }, (_, index) => {
		const date = new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10);
		return [
			`${date}T00:00:00.000-04:00`,
			"100",
			index === 1299 ? "123456.789" : "101.400",
			...history().rows[0].slice(3),
		];
	});
	mockWind(stockQuote, data);
	const result = await fetchTrackingMarketData(root, {
		symbol: "BRK.B.N",
		currency: "USD",
		startDate: "2022-01-01",
		endDate: input.endDate,
	});
	const last = result.bars.at(-1)!;
	const location = parseSourceId(last.evidenceId)!.location;
	expect(location.kind).toBe("text");
	if (location.kind === "text") expect(location.lineStart).toBeGreaterThan(100);
	const resolved = await resolvePeEvidenceSource(root, last.evidenceId);
	expect(resolved.payload.kind).toBe("text");
	expect(resolved.payload.truncated).toBe(false);
	if (resolved.payload.kind === "text") {
		expect(resolved.payload.content).toContain(last.date);
		expect(resolved.payload.content).toContain("123456.789");
	}
});
