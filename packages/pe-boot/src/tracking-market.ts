import { sourceId } from "./source.ts";
import { openPeDataset } from "./tools/database.ts";
import { fetchWindSnapshot, readWindSnapshot, type WindHistoryQuery, type WindQuery } from "./trusted-sources.ts";

export interface TrackingMarketData {
	fetchedAt: string;
	quote: { price: number; tradeDate: string; asOf: string; currency: string; evidenceId: string } | null;
	bars: Array<{ date: string; close: number; currency: string; evidenceId: string }>;
	warnings: string[];
}

export interface TrackingMarketInput {
	symbol: string;
	currency: string;
	startDate: string;
	endDate: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dateValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("WIND_MARKET_DATE: missing trading date");
	const date = /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
	if (
		!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
		!Number.isFinite(Date.parse(date)) ||
		new Date(date).toISOString().slice(0, 10) !== date
	)
		throw new Error("WIND_MARKET_DATE: invalid trading date");
	return date;
}

function timestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		Number(value.slice(11, 13)) > 23 ||
		Number(value.slice(14, 16)) > 59 ||
		Number(value.slice(17, 19)) > 59
	)
		throw new Error("WIND_MARKET_TIME: missing or invalid timezone-bearing market time");
	dateValue(value.slice(0, 10));
	return value;
}

function marketClock(instant: string, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(instant));
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

const currencies: Record<string, string> = {
	CNY: "CNY",
	人民币: "CNY",
	人民币元: "CNY",
	元: "CNY",
	HKD: "HKD",
	港币: "HKD",
	港元: "HKD",
	USD: "USD",
	美元: "USD",
	美元每股: "USD",
};

function readTable(response: unknown): {
	columns: Array<{ name: string; unit?: unknown }>;
	rows: unknown[][];
	unit: unknown;
} {
	if (!object(response) || !Array.isArray(response.content))
		throw new Error("WIND_MARKET_SCHEMA: missing MCP content");
	const dataBlocks: Record<string, unknown>[] = [];
	for (const block of response.content) {
		if (!object(block) || typeof block.text !== "string") continue;
		let decoded: unknown;
		try {
			decoded = JSON.parse(block.text);
		} catch {
			continue;
		}
		if (object(decoded) && object(decoded.data)) dataBlocks.push(decoded.data);
	}
	if (dataBlocks.length !== 1) throw new Error("WIND_MARKET_SCHEMA: expected one stock data table");
	const data = dataBlocks[0];
	if (!Array.isArray(data.columns) || !Array.isArray(data.rows))
		throw new Error("WIND_MARKET_SCHEMA: missing columns or rows");
	const columns = data.columns.map((column) => {
		if (typeof column === "string") return { name: column };
		if (!object(column) || typeof column.name !== "string") throw new Error("WIND_MARKET_SCHEMA: invalid column");
		return { name: column.name, unit: column.unit };
	});
	if (
		new Set(columns.map((column) => column.name)).size !== columns.length ||
		data.rows.some((row) => !Array.isArray(row) || row.length !== columns.length)
	)
		throw new Error("WIND_MARKET_SCHEMA: duplicate columns or malformed rows");
	return { columns, rows: data.rows as unknown[][], unit: data.unit };
}

function priceColumn(table: ReturnType<typeof readTable>, name: string, currency: string): number {
	const index = table.columns.findIndex((column) => column.name === name);
	if (index < 0) throw new Error(`WIND_MARKET_SCHEMA: missing ${name}`);
	const units = [
		table.columns[index].unit,
		...(object(table.unit) ? [table.unit[name], table.unit[`${name} 单位：`]] : [table.unit]),
	].filter((unit) => unit !== undefined && unit !== null);
	if (!units.length || units.some((unit) => typeof unit !== "string" || currencies[unit.trim()] !== currency))
		throw new Error(`WIND_MARKET_CURRENCY: ${name} unit is missing or does not match ${currency}`);
	return index;
}

function price(value: unknown): number {
	if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)))
		throw new Error("WIND_MARKET_PRICE: missing or invalid price");
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new Error("WIND_MARKET_PRICE: price must be positive and finite");
	return number;
}

/** Only the observed Wind table contracts are accepted; units and timestamps never come from retrieval time. */
export async function fetchTrackingMarketData(
	cwd: string,
	input: TrackingMarketInput,
	signal?: AbortSignal,
): Promise<TrackingMarketData> {
	if (
		typeof input.symbol !== "string" ||
		!/^[A-Z0-9.-]+\.(SH|SZ|BJ|HK|O|N|A)$/u.test(input.symbol) ||
		!["CNY", "HKD", "USD"].includes(input.currency)
	)
		throw new Error("WIND_MARKET_INPUT: select an exact A-share, HK or US Wind code and ISO currency");
	if (
		dateValue(input.startDate) !== input.startDate ||
		dateValue(input.endDate) !== input.endDate ||
		input.startDate > input.endDate
	)
		throw new Error("WIND_MARKET_INPUT: select an ordered YYYY-MM-DD range");
	const suffix = input.symbol.split(".").at(-1);
	const timeZone =
		suffix === "HK" ? "Asia/Hong_Kong" : ["SH", "SZ", "BJ"].includes(suffix!) ? "Asia/Shanghai" : "America/New_York";
	const result: TrackingMarketData = { fetchedAt: new Date().toISOString(), quote: null, bars: [], warnings: [] };
	for (const query of [
		{ category: "quote", query: input.symbol },
		{ category: "history", query: input.symbol, startDate: input.startDate, endDate: input.endDate },
	] satisfies Array<WindQuery | WindHistoryQuery>) {
		signal?.throwIfAborted();
		let saved: Awaited<ReturnType<typeof fetchWindSnapshot>>;
		try {
			saved = await fetchWindSnapshot(cwd, query, signal);
		} catch (error) {
			signal?.throwIfAborted();
			const cause = error instanceof Error && object(error.cause) ? error.cause : null;
			const code =
				cause && typeof cause.code === "string" && /^[A-Z0-9_]+$/u.test(cause.code) ? ` (${cause.code})` : "";
			throw new Error(
				`WIND_TRACKING_${query.category.toUpperCase()}: ${query.category === "history" ? "历史日线" : "最新行情"}更新失败；${error instanceof Error ? error.message : "source request failed"}${code}`,
				{ cause: error },
			);
		}
		result.fetchedAt = saved.checkedAt;
		const connection = openPeDataset(cwd);
		let original: ReturnType<typeof readWindSnapshot>;
		try {
			original = readWindSnapshot(connection.database, connection.datasetId, saved.docId);
			if (!original) throw new Error("WIND_MARKET_EVIDENCE: original snapshot is missing");
		} finally {
			connection.database.close();
		}
		const table = readTable(original.snapshot.response);
		const chunks = original.snapshot.textChunks;
		const body = chunks.join("");
		const lines = original.text.split("\n");
		const chunkLine = lines.findIndex((line) => line.trim() === '"textChunks": [') + 2;
		let cursor = 0;
		let chunkIndex = 0;
		let chunkOffset = 0;
		function rowEvidence(anchor: string, rawPrice: unknown): string {
			const token = JSON.stringify(anchor);
			const offset = body.indexOf(token, cursor);
			if (offset < 0 || chunkLine < 2)
				throw new Error("WIND_MARKET_EVIDENCE: row is missing from original text chunks");
			cursor = offset + token.length;
			while (chunkIndex < chunks.length - 1 && chunkOffset + chunks[chunkIndex].length <= offset)
				chunkOffset += chunks[chunkIndex++].length;
			// Wind price rows are short; include adjacent chunks when a timestamp or price crosses a chunk boundary.
			const lastChunk = Math.min(chunks.length - 1, chunkIndex + 2);
			const excerpt = chunks.slice(chunkIndex, lastChunk + 1).join("");
			if (!excerpt.includes(token) || !excerpt.includes(JSON.stringify(rawPrice)))
				throw new Error("WIND_MARKET_EVIDENCE: price row exceeds the bounded source excerpt");
			return sourceId({
				docId: saved.docId,
				location: { kind: "text", lineStart: chunkLine + chunkIndex, lineEnd: chunkLine + lastChunk },
			});
		}
		if (!table.rows.length) {
			result.warnings.push(
				query.category === "quote" ? "Wind 未返回最新行情。" : "所选日期范围没有日线；空结果不代表每天均为休市。",
			);
			continue;
		}
		const codeIndex = table.columns.findIndex((column) => column.name === "Wind代码");
		if (
			(query.category === "quote" && codeIndex < 0) ||
			(codeIndex >= 0 && table.rows.some((row) => row[codeIndex] !== input.symbol))
		)
			throw new Error("WIND_MARKET_SYMBOL: returned stock does not match requested Wind code");
		if (query.category === "quote") {
			if (table.rows.length !== 1) throw new Error("WIND_MARKET_SYMBOL: expected one quote row");
			const row = table.rows[0];
			const tradeDate = dateValue(row[table.columns.findIndex((column) => column.name === "最新交易日")]);
			const asOf = timestamp(row[table.columns.findIndex((column) => column.name === "交易时间")]);
			if (marketClock(asOf, timeZone).date !== tradeDate || Date.parse(asOf) > Date.parse(saved.checkedAt) + 300_000)
				throw new Error("WIND_MARKET_TIME: trade date and market time disagree or market time is in the future");
			const rawPrice = row[priceColumn(table, "最新成交价", input.currency)];
			result.quote = {
				price: price(rawPrice),
				tradeDate,
				asOf,
				currency: input.currency,
				evidenceId: rowEvidence(asOf, rawPrice),
			};
		} else {
			// The single-stock K-line endpoint omits its code column; the immutable request binds its stock and range.
			const closeIndex = priceColumn(table, "MATCH", input.currency);
			const timeIndex = table.columns.findIndex((column) => column.name === "TIME");
			const now = marketClock(saved.checkedAt, timeZone);
			// ponytail: regular-session cutoff delays early-close days; use an exchange calendar when intraday scheduling needs them.
			const closeTime = timeZone === "Asia/Shanghai" ? "15:15" : "16:15";
			const dates = new Set<string>();
			for (const row of table.rows) {
				const barTime = timestamp(row[timeIndex]);
				const date = barTime.slice(0, 10);
				if (date < input.startDate || date > input.endDate || date > now.date)
					throw new Error("WIND_MARKET_RANGE: daily bar outside requested range or in the future");
				if (dates.has(date)) throw new Error("WIND_MARKET_DUPLICATE: duplicate daily bar");
				dates.add(date);
				if (date === now.date && now.time < closeTime) continue;
				result.bars.push({
					date,
					close: price(row[closeIndex]),
					currency: input.currency,
					evidenceId: rowEvidence(barTime, row[closeIndex]),
				});
			}
			result.bars.sort((a, b) => a.date.localeCompare(b.date));
		}
	}
	return result;
}
