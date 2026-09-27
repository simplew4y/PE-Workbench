import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { resolvePeEvidenceRecord, resolvePeEvidenceSources } from "./evidence.ts";
import { ResearchError } from "./research/model.ts";
import { researchTransaction, withResearchDatabase } from "./research/storage.ts";
import { type PeSourcePayload, parseSourceId, sourceId } from "./source.ts";
import { readExcelCellsInRange } from "./tools/excel-cells.ts";
import { fetchTrackingMarketData } from "./tracking-market.ts";
import { readWorkbookContextSource, type WorkbookFactContext } from "./workbook-context.ts";

export type TrackingRule =
	| { kind: "market" }
	| { kind: "target"; base: number; effectiveDate: string; evidenceId: string }
	| { kind: "fixed"; bear: number; base: number; bull: number }
	| {
			kind: "cell";
			docId: string;
			sheet: string;
			cell: string;
			label: string;
			period: string;
			unit: string;
			context?: WorkbookFactContext;
			multipliers: { bear: number; base: number; bull: number };
			minValue: number;
			maxValue: number;
			maxChangePercent?: number;
	  };
export interface TrackingValuationEstimate {
	date: string;
	price: number;
	generatedAt?: string;
	basis: { summary: string; evidenceIds: string[] };
}
export interface StockTrackerInput {
	id?: string;
	name: string;
	code: string;
	currency: string;
	startDate: string;
	targetDate: string;
	enabled: boolean;
	pnlAlertThresholds?: { profitPercent: number; lossPercent: number };
	rule: TrackingRule;
	historicalTargets?: Array<{ date: string; price: number; evidenceId: string }>;
	valuationEstimates?: TrackingValuationEstimate[];
	forecast?: {
		bear: number;
		base: number;
		bull: number;
		targetDate: string;
		generatedAt?: string;
		basis: { summary: string; evidenceIds: string[] };
	};
	referencePrice?: { date: string; price: number };
	basis?: { summary: string; evidenceIds: string[] };
}
export interface SimulatedTradeInput {
	requestId: string;
	date: string;
	kind: "buy" | "sell" | "dividend" | "split";
	quantity?: number;
	price?: number;
	fee?: number;
	amount?: number;
	ratio?: number;
	note?: string;
}
export interface SimulatedTrade extends SimulatedTradeInput {
	id: string;
	createdAt: string;
}
export interface TrackingQuote {
	price: number;
	tradeDate: string;
	asOf: string;
	currency: string;
	evidenceId: string;
}
export interface TrackingValuation {
	id: string;
	revision: number;
	effectiveAt: string;
	effectiveDate: string;
	targetDate: string;
	bear: number | null;
	base: number;
	bull: number | null;
	sourceValue: number | null;
	docId: string | null;
	evidenceId: string | null;
	rule: TrackingRule;
	basis?: StockTrackerInput["basis"];
}
export interface TrackingPosition {
	quantity: number;
	cost: number;
	averageCost: number;
	realizedPnl: number;
	dividends: number;
	marketValue: number | null;
	unrealizedPnl: number | null;
	totalPnl: number | null;
	returnPercent: number | null;
	unrealizedReturnPercent: number | null;
	invested: number;
}
export interface TrackingObservation {
	date: string;
	close: number;
	currency: string;
	evidenceId: string;
	valuationId: string | null;
	bear: number | null;
	base: number | null;
	bull: number | null;
	upsidePercent: number | null;
	downsidePercent: number | null;
	rewardRisk: number | null;
	position: TrackingPosition;
}
export interface StockTrackerSummary {
	id: string;
	revision: number;
	config: StockTrackerInput;
	status: string;
	error: string | null;
	marketError: string | null;
	lastCheckedAt: string | null;
	quote: TrackingQuote | null;
	valuation: TrackingValuation | null;
	position: TrackingPosition;
	pnlAlertThresholds: NonNullable<StockTrackerInput["pnlAlertThresholds"]>;
	pnlAlert: "profit" | "loss" | null;
	valuationStatus: "valid" | "stale" | "expired" | "split_review" | "unavailable";
	forecastSplitReview: boolean;
	valuationEstimateSplitReview: boolean;
	valuationEstimateNeedsUpdate: boolean;
	forecastNeedsUpdate: boolean;
}
export interface StockTrackerDetail extends StockTrackerSummary {
	observations: TrackingObservation[];
	trades: SimulatedTrade[];
	valuations: TrackingValuation[];
}
export interface StockTrackingState {
	trackers: StockTrackerSummary[];
	selected: StockTrackerDetail | null;
}
export type TrackingMarketProvider = typeof fetchTrackingMarketData;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stock_trackers (
 id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,revision INTEGER NOT NULL,config_json TEXT NOT NULL,
 logical_doc_id TEXT,status TEXT NOT NULL,error TEXT,valuation_error TEXT,last_checked_at TEXT,last_attempt_at INTEGER,
 quote_json TEXT,lease_token TEXT,lease_until INTEGER,created_at TEXT NOT NULL,
 UNIQUE(dataset_id,id)
);
CREATE TABLE IF NOT EXISTS stock_tracking_rules (
 tracker_id TEXT NOT NULL,revision INTEGER NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(tracker_id,revision)
);
CREATE TABLE IF NOT EXISTS stock_tracking_valuations (
 id TEXT PRIMARY KEY,tracker_id TEXT NOT NULL,revision INTEGER NOT NULL,effective_at TEXT NOT NULL,
 content_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_tracking_trades (
 id TEXT PRIMARY KEY,tracker_id TEXT NOT NULL,request_id TEXT NOT NULL,trade_date TEXT NOT NULL,
 content_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tracker_id,request_id)
);
CREATE TABLE IF NOT EXISTS stock_tracking_observations (
 tracker_id TEXT NOT NULL,trade_date TEXT NOT NULL,content_json TEXT NOT NULL,
 PRIMARY KEY(tracker_id,trade_date)
);
`;
function database<T>(cwd: string, datasetId: string, operation: (db: DatabaseSync) => T): T {
	return withResearchDatabase(cwd, datasetId, (db) => {
		db.exec(SCHEMA);
		if (
			!db
				.prepare("PRAGMA table_info(stock_trackers)")
				.all()
				.some((column) => column.name === "valuation_error")
		)
			db.exec("ALTER TABLE stock_trackers ADD COLUMN valuation_error TEXT");
		return operation(db);
	});
}
function invalid(message: string): never {
	throw new ResearchError(400, message);
}
function date(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}$/u.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 10) === value
	);
}
function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12;
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
}
function text(value: unknown, max = 200): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= max;
}
function ordered(value: { bear: number; base: number; bull: number }): boolean {
	return (
		positive(value.bear) &&
		positive(value.base) &&
		positive(value.bull) &&
		value.bear <= value.base &&
		value.base <= value.bull
	);
}
function validBasis(value: NonNullable<StockTrackerInput["basis"]>): boolean {
	return (
		text(value.summary, 4000) &&
		Array.isArray(value.evidenceIds) &&
		value.evidenceIds.length >= 1 &&
		value.evidenceIds.length <= 20 &&
		value.evidenceIds.every((id) => text(id, 2048))
	);
}
function market(code: string) {
	if (/\.(SH|SZ|BJ)$/u.test(code)) return { timeZone: "Asia/Shanghai", closeMinute: 15 * 60 + 30 };
	if (/\.HK$/u.test(code)) return { timeZone: "Asia/Hong_Kong", closeMinute: 16 * 60 + 30 };
	if (/\.(O|N|A)$/u.test(code)) return { timeZone: "America/New_York", closeMinute: 16 * 60 + 30 };
	throw new ResearchError(400, "Use an exact supported Wind code ending in .SH/.SZ/.BJ/.HK/.O/.N/.A");
}
export function trackingMarketClock(code: string, now = new Date()) {
	const venue = market(code);
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: venue.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(now);
	const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return {
		date: `${p.year}-${p.month}-${p.day}`,
		afterClose: !["Sat", "Sun"].includes(p.weekday) && Number(p.hour) * 60 + Number(p.minute) >= venue.closeMinute,
		minutesAfterClose: Number(p.hour) * 60 + Number(p.minute) - venue.closeMinute,
		timeZone: venue.timeZone,
	};
}
function validateConfig(value: unknown): StockTrackerInput {
	if (!value || typeof value !== "object") invalid("Invalid tracking settings");
	const c = value as StockTrackerInput;
	if (
		!text(c.name) ||
		!text(c.code, 30) ||
		!/^[A-Z0-9][A-Z0-9.-]*\.(SH|SZ|BJ|HK|O|N|A)$/u.test(c.code) ||
		!/^[A-Z]{3}$/u.test(c.currency) ||
		!date(c.startDate) ||
		!date(c.targetDate) ||
		c.startDate > c.targetDate ||
		typeof c.enabled !== "boolean" ||
		(c.id !== undefined && !text(c.id, 100))
	)
		invalid("Invalid name, exact Wind code, currency or tracking dates");
	market(c.code);
	const expectedCurrency = /\.(SH|SZ|BJ)$/u.test(c.code) ? "CNY" : /\.HK$/u.test(c.code) ? "HKD" : "USD";
	if (c.currency !== expectedCurrency) invalid(`Currency for this market must be ${expectedCurrency}`);
	if (
		c.pnlAlertThresholds !== undefined &&
		(!c.pnlAlertThresholds ||
			!positive(c.pnlAlertThresholds.profitPercent) ||
			c.pnlAlertThresholds.profitPercent > 10000 ||
			!positive(c.pnlAlertThresholds.lossPercent) ||
			c.pnlAlertThresholds.lossPercent > 100)
	)
		invalid("盈利提醒阈值须大于 0 且不超过 10000%，亏损提醒阈值须大于 0 且不超过 100%");
	if (Date.parse(c.targetDate) - Date.parse(c.startDate) > 366 * 20 * 86400000)
		invalid("Tracking date range exceeds 20 years");
	const r = c.rule;
	if (!r || typeof r !== "object") invalid("A valuation rule is required");
	if (r.kind === "market") {
		if (!c.basis) invalid("Market tracking requires project evidence identifying the security");
	} else if (r.kind === "target") {
		if (
			!positive(r.base) ||
			!date(r.effectiveDate) ||
			!text(r.evidenceId, 2048) ||
			r.effectiveDate > trackingMarketClock(c.code).date
		)
			invalid("Model target requires a positive source value, citation and non-future source date");
	} else if (r.kind === "fixed") {
		if (!ordered(r)) invalid("Targets must be positive and bear ≤ base ≤ bull");
	} else if (r.kind === "cell") {
		if (
			!text(r.docId, 128) ||
			!text(r.sheet) ||
			!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(r.cell) ||
			!text(r.label) ||
			!text(r.period) ||
			!text(r.unit) ||
			!r.context?.label ||
			!r.context.period ||
			!r.context.unit ||
			!r.multipliers ||
			!ordered(r.multipliers) ||
			!positive(r.minValue) ||
			!positive(r.maxValue) ||
			r.minValue > r.maxValue ||
			(r.maxChangePercent !== undefined && !positive(r.maxChangePercent))
		)
			invalid("Cell binding requires label, period and unit source cells, positive multipliers and value bounds");
		const units: Record<string, string[]> = {
			CNY: ["cny/share", "cny/股", "人民币/股", "人民币元/股", "元/股", "人民币每股", "每股人民币", "每股元"],
			HKD: ["hkd/share", "hkd/股", "港币/股", "港元/股", "港币每股", "港元每股", "每股港币", "每股港元"],
			USD: ["usd/share", "usd/股", "美元/股", "美元每股", "每股美元"],
		};
		const unit = r.unit.normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, "").replace("pershare", "/share");
		if (!units[c.currency]?.includes(unit))
			invalid(
				"Model input must explicitly use the stock currency per share (for example HKD/share); totals or other currencies cannot become a share price",
			);
	} else invalid("Unsupported valuation rule");
	if (
		c.historicalTargets !== undefined &&
		(!Array.isArray(c.historicalTargets) ||
			c.historicalTargets.length > 200 ||
			c.historicalTargets.some(
				(point) =>
					!point ||
					!date(point.date) ||
					!positive(point.price) ||
					!text(point.evidenceId, 2048) ||
					point.date > (r.kind === "target" ? r.effectiveDate : trackingMarketClock(c.code).date),
			))
	)
		invalid("Historical targets require up to 200 source prices and dates no later than the current model");
	if (
		c.valuationEstimates !== undefined &&
		(!Array.isArray(c.valuationEstimates) ||
			c.valuationEstimates.length > 1 ||
			c.valuationEstimates.some(
				(point) =>
					!point ||
					!date(point.date) ||
					point.date < c.startDate ||
					point.date > trackingMarketClock(c.code).date ||
					!positive(point.price) ||
					!point.basis ||
					!validBasis(point.basis),
			) ||
			new Set(c.valuationEstimates.map((point) => point.date)).size !== c.valuationEstimates.length)
	)
		invalid(
			"AI valuation estimates accept only one current analysis point with a positive price and sourced calculation method",
		);
	if (
		c.forecast &&
		(!ordered(c.forecast) || !date(c.forecast.targetDate) || !c.forecast.basis || !validBasis(c.forecast.basis))
	)
		invalid("Forecast requires an ordered range, future target date and research citations");
	if (
		c.referencePrice &&
		(!date(c.referencePrice.date) || !positive(c.referencePrice.price) || c.referencePrice.date > c.targetDate)
	)
		invalid("Invalid historical reference price/date");
	if (c.basis && !validBasis(c.basis)) invalid("Tracking basis requires an explanation and 1–20 source citations");
	return JSON.parse(JSON.stringify(c)) as StockTrackerInput;
}
function rowFor(db: DatabaseSync, datasetId: string, trackerId: string) {
	const row = db.prepare("SELECT * FROM stock_trackers WHERE dataset_id=? AND id=?").get(datasetId, trackerId);
	if (!row) throw new ResearchError(404, "Stock tracker not found");
	return row;
}
function tradesFor(db: DatabaseSync, trackerId: string): SimulatedTrade[] {
	return db
		.prepare("SELECT content_json FROM stock_tracking_trades WHERE tracker_id=? ORDER BY trade_date,created_at,rowid")
		.all(trackerId)
		.map((r) => JSON.parse(String(r.content_json)) as SimulatedTrade);
}
function valuationsFor(db: DatabaseSync, trackerId: string): TrackingValuation[] {
	return db
		.prepare(
			"SELECT content_json FROM stock_tracking_valuations WHERE tracker_id=? ORDER BY json_extract(content_json,'$.effectiveDate'),effective_at,rowid",
		)
		.all(trackerId)
		.map((r) => JSON.parse(String(r.content_json)) as TrackingValuation);
}

/** Long-only simulated ledger; average cost includes buy fees, sell fees reduce realized proceeds. */
export function calculateTrackingPosition(
	trades: SimulatedTradeInput[],
	price: number | null,
	through = "9999-12-31",
): TrackingPosition {
	let quantity = 0,
		cost = 0,
		realizedPnl = 0,
		dividends = 0,
		invested = 0;
	for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
		if (t.date > through) continue;
		if (t.kind === "buy") {
			const amount = t.quantity! * t.price! + (t.fee ?? 0);
			quantity += t.quantity!;
			cost += amount;
			invested += amount;
		} else if (t.kind === "sell") {
			if (t.quantity! > quantity + 1e-8) invalid(`Oversell on ${t.date}: available ${quantity}`);
			const removed = quantity ? (cost * t.quantity!) / quantity : 0;
			realizedPnl += t.quantity! * t.price! - (t.fee ?? 0) - removed;
			quantity -= t.quantity!;
			cost -= removed;
			if (Math.abs(quantity) < 1e-8) {
				quantity = 0;
				cost = 0;
			}
		} else if (t.kind === "dividend") {
			if (quantity <= 0) invalid(`Dividend on ${t.date} requires a position`);
			dividends += t.amount!;
		} else if (t.kind === "split") {
			if (quantity <= 0) invalid(`Split on ${t.date} requires a position`);
			quantity *= t.ratio!;
		}
	}
	const marketValue = quantity === 0 ? 0 : price === null ? null : quantity * price;
	const unrealizedPnl = marketValue === null ? null : marketValue - cost;
	const totalPnl = unrealizedPnl === null ? null : unrealizedPnl + realizedPnl + dividends;
	return {
		quantity,
		cost,
		averageCost: quantity ? cost / quantity : 0,
		realizedPnl,
		dividends,
		marketValue,
		unrealizedPnl,
		totalPnl,
		returnPercent: totalPnl !== null && invested > 0 ? (totalPnl / invested) * 100 : null,
		unrealizedReturnPercent: unrealizedPnl !== null && cost > 0 ? (unrealizedPnl / cost) * 100 : null,
		invested,
	};
}

function splitAfterValuation(
	trades: SimulatedTrade[],
	valuation: Pick<TrackingValuation, "effectiveDate" | "effectiveAt">,
	through: string,
): boolean {
	return trades.some(
		(trade) =>
			trade.kind === "split" &&
			trade.date <= through &&
			(trade.date > valuation.effectiveDate ||
				(trade.date === valuation.effectiveDate && trade.createdAt > valuation.effectiveAt)),
	);
}

function detailFor(db: DatabaseSync, datasetId: string, trackerId: string): StockTrackerDetail {
	const row = rowFor(db, datasetId, trackerId);
	const config = JSON.parse(String(row.config_json)) as StockTrackerInput;
	const trades = tradesFor(db, trackerId);
	// Previous multi-point backfills remain in revision history, not in the active estimate.
	if (config.valuationEstimates) config.valuationEstimates = config.valuationEstimates.slice(-1);
	const valuations = valuationsFor(db, trackerId);
	const quote = row.quote_json ? (JSON.parse(String(row.quote_json)) as TrackingQuote) : null;
	const observations = db
		.prepare(
			"SELECT content_json FROM stock_tracking_observations WHERE tracker_id=? ORDER BY trade_date DESC LIMIT 2000",
		)
		.all(trackerId)
		.map((r) => JSON.parse(String(r.content_json)) as TrackingObservation);
	const today = trackingMarketClock(config.code).date;
	const rule = config.rule;
	const valuation =
		(rule.kind === "market"
			? null
			: rule.kind === "target"
				? [...valuations]
						.reverse()
						.find(
							(entry) =>
								entry.rule.kind === "target" &&
								entry.evidenceId === rule.evidenceId &&
								entry.effectiveDate === rule.effectiveDate &&
								entry.base === rule.base,
						)
				: valuations.at(-1)) ?? null;
	let forecastSplit = false;
	let estimateSplit = false;
	const latestEstimate = config.valuationEstimates?.at(-1);
	if (config.forecast || latestEstimate) {
		let forecastAt: string | undefined;
		let estimateAt: string | undefined;
		let sameForecast = !!config.forecast;
		let sameEstimate = !!latestEstimate;
		for (const version of db
			.prepare("SELECT config_json,created_at FROM stock_tracking_rules WHERE tracker_id=? ORDER BY revision DESC")
			.all(trackerId)) {
			const previous = JSON.parse(String(version.config_json)) as StockTrackerInput;
			sameForecast &&= isDeepStrictEqual(previous.forecast, config.forecast);
			sameEstimate &&= isDeepStrictEqual(
				previous.valuationEstimates?.find((point) => point.date === latestEstimate?.date),
				latestEstimate,
			);
			if (!sameForecast && !sameEstimate) break;
			if (sameForecast) forecastAt = String(version.created_at);
			if (sameEstimate) estimateAt = String(version.created_at);
		}
		if (forecastAt)
			forecastSplit = splitAfterValuation(
				trades,
				{ effectiveAt: forecastAt, effectiveDate: trackingMarketClock(config.code, new Date(forecastAt)).date },
				today,
			);
		if (
			latestEstimate &&
			(!estimateAt || trackingMarketClock(config.code, new Date(estimateAt)).date !== latestEstimate.date)
		)
			config.valuationEstimates = [];
		else if (estimateAt && latestEstimate)
			estimateSplit = splitAfterValuation(
				trades,
				{ effectiveAt: estimateAt, effectiveDate: latestEstimate.date },
				today,
			);
	}
	const valuationStatus =
		rule.kind === "market" && forecastSplit
			? "split_review"
			: !valuation
				? "unavailable"
				: valuation.targetDate < today
					? "expired"
					: splitAfterValuation(trades, valuation, today)
						? "split_review"
						: row.valuation_error
							? "stale"
							: "valid";
	const marketError = row.error && row.error !== row.valuation_error ? String(row.error) : null;
	const warnings = marketError ? [marketError] : [];
	if (row.valuation_error && !warnings.includes(String(row.valuation_error)))
		warnings.push(String(row.valuation_error));
	if (valuationStatus === "expired") warnings.push("目标期限已到期，请设置新期限和规则；旧估值仅供回看");
	if (valuationStatus === "split_review") warnings.push("拆并股后估值每股口径待更新，旧估值暂不可用于空间比较");
	else if (forecastSplit) warnings.push("预测每股口径待复核");
	if (estimateSplit) warnings.push("AI估值每股口径待复核");
	const valuationEstimateNeedsUpdate = !!latestEstimate && !latestEstimate.generatedAt;
	const forecastNeedsUpdate = !!config.forecast && !config.forecast.generatedAt;
	if (forecastNeedsUpdate || (valuationEstimateNeedsUpdate && !config.forecast))
		warnings.push("股价预测待更新；点击更新后将用 Wind 数据重新计算");
	const latest = observations[0];
	const useClose = latest && (!quote || latest.date > quote.tradeDate);
	const markDate = useClose ? latest.date : quote?.tradeDate;
	let mark = useClose ? latest.close : (quote?.price ?? null);
	if (markDate && trades.some((trade) => trade.kind === "split" && trade.date > markDate && trade.date <= today)) {
		mark = null;
		warnings.push("拆并股后尚无有效新价格，市值和浮动盈亏暂不可用");
	}
	if (useClose && quote) warnings.push("截面行情早于最新收盘记录，盈亏使用较新的收盘价");
	const position = calculateTrackingPosition(trades, mark, today);
	const pnlAlertThresholds = config.pnlAlertThresholds ?? { profitPercent: 20, lossPercent: 10 };
	const pnlPercent = position.unrealizedReturnPercent;
	const pnlAlert =
		position.quantity > 0 && pnlPercent !== null
			? pnlPercent >= pnlAlertThresholds.profitPercent
				? "profit"
				: pnlPercent <= -pnlAlertThresholds.lossPercent
					? "loss"
					: null
			: null;
	return {
		id: trackerId,
		revision: Number(row.revision),
		config,
		status: warnings.length || pnlAlert ? "attention" : String(row.status),
		error: warnings.length ? warnings.join("；") : null,
		marketError,
		lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
		quote,
		valuation,
		valuationStatus,
		forecastSplitReview: forecastSplit,
		valuationEstimateSplitReview: estimateSplit,
		valuationEstimateNeedsUpdate,
		forecastNeedsUpdate,
		position,
		pnlAlertThresholds,
		pnlAlert,
		observations,
		trades: [...trades].reverse().slice(0, 2000),
		valuations: [...valuations].reverse().slice(0, 200),
	};
}
export function getStockTracking(cwd: string, datasetId: string, trackerId?: string): StockTrackingState {
	return database(cwd, datasetId, (db) => {
		const rows = db
			.prepare("SELECT id FROM stock_trackers WHERE dataset_id=? ORDER BY created_at,id LIMIT 50")
			.all(datasetId);
		const details = rows.map((row) => detailFor(db, datasetId, String(row.id)));
		if (trackerId && !details.some((d) => d.id === trackerId))
			throw new ResearchError(404, "Stock tracker not found");
		return {
			trackers: details.map(
				({ observations: _observations, trades: _trades, valuations: _valuations, ...summary }) => summary,
			),
			selected: details.find((d) => d.id === trackerId) ?? details[0] ?? null,
		};
	});
}

function validateTargetSource(db: DatabaseSync, datasetId: string, price: number, evidenceId: string): string {
	const reference = parseSourceId(evidenceId);
	if (
		!reference ||
		reference.location.kind !== "excel" ||
		!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(reference.location.range)
	)
		invalid("Model target must cite one exact Excel target-price cell");
	const cell = readExcelCellsInRange(
		db,
		datasetId,
		reference.docId,
		reference.location.sheet,
		reference.location.range,
		1,
	)[0];
	if (
		cell?.is_formula &&
		(cell.formula_cache_status !== "present" ||
			!text(cell.cached_value, 1000) ||
			!positive(Number(cell.cached_value)) ||
			Math.abs(Number(cell.cached_value) - Number(cell.numeric_value)) > Math.max(1, price) * 1e-8)
	)
		invalid("Model target formula requires a matching numeric cache");
	if (!cell || !positive(cell.numeric_value) || Math.abs(cell.numeric_value - price) > Math.max(1, price) * 1e-8)
		invalid("Model target does not match the cited source cell value");
	return reference.docId;
}

function updateValuation(db: DatabaseSync, datasetId: string, trackerId: string, now: string): string | null {
	const row = rowFor(db, datasetId, trackerId);
	const config = JSON.parse(String(row.config_json)) as StockTrackerInput;
	const rule = config.rule;
	if (rule.kind === "market") return null;
	const versions = valuationsFor(db, trackerId);
	const previous =
		rule.kind === "target"
			? [...versions]
					.reverse()
					.find(
						(entry) =>
							entry.rule.kind === "target" &&
							entry.evidenceId === rule.evidenceId &&
							entry.effectiveDate === rule.effectiveDate,
					)
			: versions.at(-1);
	let sourceValue: number | null = null,
		docId: string | null = null,
		evidenceId: string | null = null;
	let targets: { bear: number | null; base: number; bull: number | null };
	const effectiveDate =
		rule.kind === "target" ? rule.effectiveDate : trackingMarketClock(config.code, new Date(now)).date;
	try {
		if (rule.kind === "target") {
			docId = validateTargetSource(db, datasetId, rule.base, rule.evidenceId);
			evidenceId = rule.evidenceId;
			sourceValue = rule.base;
			targets = { bear: null, base: rule.base, bull: null };
		} else if (rule.kind === "fixed") targets = rule;
		else {
			const doc = db
				.prepare(
					"SELECT * FROM documents WHERE dataset_id=? AND logical_doc_id=? AND is_current=1 AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1",
				)
				.get(datasetId, String(row.logical_doc_id));
			if (!doc || !["completed", "completed_with_warnings"].includes(String(doc.status)))
				throw new Error("最新模型尚未完成解析，保留上一有效估值");
			if (!rule.context?.label || !rule.context.period || !rule.context.unit)
				throw new Error("请重新确认模型标签、期间和单位的来源单元格，保留上一有效估值");
			for (const source of [rule.context.label, rule.context.period, rule.context.unit])
				readWorkbookContextSource(db, datasetId, String(doc.doc_id), source);
			const cell = readExcelCellsInRange(db, datasetId, String(doc.doc_id), rule.sheet, rule.cell, 1)[0];
			if (!cell) throw new Error("模型绑定单元格不存在，保留上一有效估值");
			if (cell.is_formula && (cell.formula_cache_status !== "present" || !text(cell.cached_value, 1000)))
				throw new Error("模型公式缺少可用缓存，保留上一有效估值");
			if (!positive(cell.numeric_value)) throw new Error("模型单元格不是有效正数，保留上一有效估值");
			sourceValue = cell.numeric_value;
			if (cell.is_formula) {
				const cached = Number(cell.cached_value);
				if (!positive(cached) || Math.abs(cached - sourceValue) > Math.max(1, sourceValue) * 1e-8)
					throw new Error("模型数值与公式缓存不一致，保留上一有效估值");
			}
			if (sourceValue < rule.minValue || sourceValue > rule.maxValue)
				throw new Error("模型输入超出分析师设置范围，保留上一有效估值");
			if (
				previous?.sourceValue &&
				rule.maxChangePercent !== undefined &&
				Math.abs(sourceValue / previous.sourceValue - 1) * 100 > rule.maxChangePercent
			)
				throw new Error("模型输入变化超过分析师设置幅度，保留上一有效估值");
			docId = String(doc.doc_id);
			evidenceId = sourceId({ docId, location: { kind: "excel", sheet: rule.sheet, range: rule.cell } });
			targets = {
				bear: sourceValue * rule.multipliers.bear,
				base: sourceValue * rule.multipliers.base,
				bull: sourceValue * rule.multipliers.bull,
			};
		}
		if (
			!positive(targets.base) ||
			(targets.bear !== null &&
				targets.bull !== null &&
				!ordered({ ...targets, bear: targets.bear, bull: targets.bull }))
		)
			throw new Error("估值计算结果无效，保留上一有效估值");
		if (
			previous &&
			(rule.kind === "target" || previous.revision === Number(row.revision)) &&
			(rule.kind !== "target" || previous.effectiveDate === effectiveDate) &&
			previous.evidenceId === evidenceId &&
			previous.docId === docId &&
			previous.sourceValue === sourceValue &&
			previous.bear === targets.bear &&
			previous.base === targets.base &&
			previous.bull === targets.bull
		)
			return null;
		const valuation: TrackingValuation = {
			id: randomUUID(),
			revision: Number(row.revision),
			effectiveAt: now,
			effectiveDate,
			targetDate: config.targetDate,
			bear: targets.bear,
			base: targets.base,
			bull: targets.bull,
			sourceValue,
			docId,
			evidenceId,
			rule,
			...(config.basis ? { basis: config.basis } : {}),
		};
		db.prepare("INSERT INTO stock_tracking_valuations VALUES(?,?,?,?,?)").run(
			valuation.id,
			trackerId,
			valuation.revision,
			now,
			JSON.stringify(valuation),
		);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : "模型估值更新失败，保留上一有效估值";
	}
}

export function saveStockTracker(
	cwd: string,
	datasetId: string,
	value: unknown,
	revision: number,
	preparedSources?: ReadonlyMap<string, PeSourcePayload>,
): StockTrackerDetail {
	const config = validateConfig(value);
	if (!Number.isSafeInteger(revision) || revision < 0) invalid("Invalid tracker revision");
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const existing = config.id ? rowFor(db, datasetId, config.id) : undefined;
			if ((existing ? Number(existing.revision) : 0) !== revision)
				throw new ResearchError(409, "Tracking settings changed; reload");
			if (
				!existing &&
				Number(db.prepare("SELECT COUNT(*) AS n FROM stock_trackers WHERE dataset_id=?").get(datasetId)?.n) >= 50
			)
				invalid("At most 50 stocks per project");
			const before = existing ? (JSON.parse(String(existing.config_json)) as StockTrackerInput) : undefined;
			if (config.pnlAlertThresholds === undefined && before?.pnlAlertThresholds)
				config.pnlAlertThresholds = before.pnlAlertThresholds;
			const previousEstimate = before?.valuationEstimates?.at(-1);
			for (const point of config.valuationEstimates ?? []) {
				if (point.date !== trackingMarketClock(config.code).date && !isDeepStrictEqual(point, previousEstimate))
					invalid(
						"New AI valuation estimates must use venue today; backfill historical prices from market data, not AI estimates",
					);
			}
			if (
				config.forecast &&
				config.forecast.targetDate <= trackingMarketClock(config.code).date &&
				!isDeepStrictEqual(config.forecast, before?.forecast)
			)
				invalid("New or changed forecast requires a future target date");
			if (before) {
				if (
					before.code !== config.code ||
					before.currency !== config.currency ||
					before.startDate !== config.startDate
				)
					invalid("Create a new tracker to change security, currency or start date");
			}
			let logicalDocId: string | null = null;
			for (const basis of [
				config.basis,
				config.forecast?.basis,
				...(config.valuationEstimates ?? []).map((point) => point.basis),
			]) {
				for (const id of basis?.evidenceIds ?? []) {
					const reference = parseSourceId(id);
					const source =
						reference &&
						db
							.prepare("SELECT status FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL")
							.get(datasetId, reference.docId);
					const prepared = preparedSources?.get(id);
					if (
						!source ||
						!["completed", "completed_with_warnings"].includes(String(source.status)) ||
						(!resolvePeEvidenceRecord(db, datasetId, id) &&
							!(
								prepared &&
								prepared.dataset_id === datasetId &&
								prepared.doc_id === reference?.docId &&
								prepared.evidence_id === id
							))
					)
						invalid("Tracking basis references an unavailable source or a different project");
				}
			}
			if (config.valuationEstimates === undefined && previousEstimate)
				config.valuationEstimates = [previousEstimate];
			const rule = config.rule;
			if (
				rule.kind === "cell" &&
				config.basis &&
				!config.basis.evidenceIds.some((id) => parseSourceId(id)?.docId === rule.docId)
			)
				invalid("Tracking basis must cite the bound model document");
			if (rule.kind === "target") {
				validateTargetSource(db, datasetId, rule.base, rule.evidenceId);
				if (config.basis && !config.basis.evidenceIds.includes(rule.evidenceId))
					invalid("Tracking basis must cite the model target cell");
			}
			for (const point of config.historicalTargets ?? [])
				validateTargetSource(db, datasetId, point.price, point.evidenceId);
			if (config.rule.kind === "cell") {
				const doc = db
					.prepare(
						"SELECT logical_doc_id,file_type FROM documents WHERE dataset_id=? AND doc_id=? AND deleted_at IS NULL",
					)
					.get(datasetId, config.rule.docId);
				if (!doc || !text(doc.logical_doc_id, 200) || !["xlsx", "xlsm"].includes(String(doc.file_type)))
					invalid("Select an Excel document from this project with a valid document series");
				logicalDocId = String(doc.logical_doc_id);
			}
			const id = config.id ?? randomUUID();
			config.id = id;
			const now = new Date().toISOString();
			for (const point of config.valuationEstimates ?? []) {
				point.generatedAt = isDeepStrictEqual(point, previousEstimate) ? previousEstimate?.generatedAt : now;
			}
			if (config.forecast)
				config.forecast.generatedAt = isDeepStrictEqual(config.forecast, before?.forecast)
					? before?.forecast?.generatedAt
					: now;
			db.prepare(`INSERT INTO stock_trackers(id,dataset_id,revision,config_json,logical_doc_id,status,created_at)
			VALUES(?,?,?,?,?,'ready',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
			config_json=excluded.config_json,logical_doc_id=excluded.logical_doc_id,lease_token=NULL,lease_until=NULL,last_attempt_at=NULL`).run(
				id,
				datasetId,
				revision + 1,
				JSON.stringify(config),
				logicalDocId,
				now,
			);
			db.prepare("INSERT INTO stock_tracking_rules VALUES(?,?,?,?)").run(
				id,
				revision + 1,
				JSON.stringify(config),
				now,
			);
			for (const point of config.historicalTargets ?? []) {
				if (rule.kind === "target" && point.date === rule.effectiveDate && point.evidenceId === rule.evidenceId)
					continue;
				const saved = valuationsFor(db, id).find(
					(entry) => entry.effectiveDate === point.date && entry.evidenceId === point.evidenceId,
				);
				if (saved) {
					if (saved.base !== point.price)
						invalid("Historical model target already records a different source value");
					continue;
				}
				const historical: TrackingValuation = {
					id: randomUUID(),
					revision: revision + 1,
					effectiveAt: now,
					effectiveDate: point.date,
					targetDate: config.targetDate,
					bear: null,
					base: point.price,
					bull: null,
					sourceValue: point.price,
					docId: parseSourceId(point.evidenceId)!.docId,
					evidenceId: point.evidenceId,
					rule: { kind: "target", base: point.price, effectiveDate: point.date, evidenceId: point.evidenceId },
				};
				db.prepare("INSERT INTO stock_tracking_valuations VALUES(?,?,?,?,?)").run(
					historical.id,
					id,
					historical.revision,
					now,
					JSON.stringify(historical),
				);
			}
			const warning = updateValuation(db, datasetId, id, now);
			db.prepare("UPDATE stock_trackers SET status=?,error=?,valuation_error=? WHERE id=?").run(
				warning ? "valuation_error" : config.enabled ? "ready" : "paused",
				null,
				warning,
				id,
			);
			return detailFor(db, datasetId, id);
		}),
	);
}

/** Prepare text/Office citations before the synchronous save transaction, for both tools and web updates. */
export async function saveStockTrackerWithSources(
	cwd: string,
	datasetId: string,
	value: unknown,
	revision: number,
	signal?: AbortSignal,
): Promise<StockTrackerDetail> {
	signal?.throwIfAborted();
	const config = validateConfig(value);
	const textCitations = [
		...new Set([
			...(config.basis?.evidenceIds ?? []),
			...(config.forecast?.basis.evidenceIds ?? []),
			...(config.valuationEstimates ?? []).flatMap((point) => point.basis.evidenceIds),
		]),
	].filter((id) => {
		const kind = parseSourceId(id)?.location.kind;
		return kind === "text" || kind === "block";
	});
	const prepared = await resolvePeEvidenceSources(cwd, textCitations, signal);
	signal?.throwIfAborted();
	return saveStockTracker(cwd, datasetId, config, revision, prepared);
}

function validateTrade(value: unknown, config: StockTrackerInput): SimulatedTradeInput {
	if (!value || typeof value !== "object") invalid("Invalid simulated transaction");
	const t = value as SimulatedTradeInput;
	if (
		!text(t.requestId, 128) ||
		!date(t.date) ||
		t.date < config.startDate ||
		t.date > trackingMarketClock(config.code).date ||
		!["buy", "sell", "dividend", "split"].includes(t.kind) ||
		(t.note !== undefined && (typeof t.note !== "string" || t.note.length > 2000))
	)
		invalid("Invalid transaction date, type or request ID");
	const result: SimulatedTradeInput = {
		requestId: t.requestId,
		date: t.date,
		kind: t.kind,
		...(t.note ? { note: t.note } : {}),
	};
	if (t.kind === "buy" || t.kind === "sell") {
		if (!positive(t.quantity) || !positive(t.price) || !nonnegative(t.fee ?? 0) || t.quantity * t.price > 1e15)
			invalid("Quantity and price must be positive; fees cannot be negative");
		Object.assign(result, { quantity: t.quantity, price: t.price, fee: t.fee ?? 0 });
	} else if (t.kind === "dividend") {
		if (!nonnegative(t.amount)) invalid("Dividend cash must be nonnegative");
		result.amount = t.amount;
	} else {
		if (!positive(t.ratio)) invalid("Split ratio must be positive (new shares / old shares)");
		result.ratio = t.ratio;
	}
	return result;
}
function recalculateObservations(db: DatabaseSync, trackerId: string, trades: SimulatedTrade[]) {
	const valuations = valuationsFor(db, trackerId);
	for (const row of db.prepare("SELECT * FROM stock_tracking_observations WHERE tracker_id=?").all(trackerId)) {
		const observation = JSON.parse(String(row.content_json)) as TrackingObservation;
		observation.position = calculateTrackingPosition(trades, observation.close, observation.date);
		const valuation = valuations.find((v) => v.id === observation.valuationId);
		if (valuation && splitAfterValuation(trades, valuation, observation.date)) {
			observation.bear = null;
			observation.base = null;
			observation.bull = null;
			observation.upsidePercent = null;
			observation.downsidePercent = null;
			observation.rewardRisk = null;
		}
		db.prepare("UPDATE stock_tracking_observations SET content_json=? WHERE tracker_id=? AND trade_date=?").run(
			JSON.stringify(observation),
			trackerId,
			observation.date,
		);
	}
}
export function addSimulatedTrade(
	cwd: string,
	datasetId: string,
	trackerId: string,
	value: unknown,
): StockTrackerDetail {
	return database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const config = JSON.parse(String(rowFor(db, datasetId, trackerId).config_json)) as StockTrackerInput;
			const input = validateTrade(value, config);
			const existing = db
				.prepare("SELECT content_json FROM stock_tracking_trades WHERE tracker_id=? AND request_id=?")
				.get(trackerId, input.requestId);
			if (existing) {
				const {
					id: _id,
					createdAt: _createdAt,
					...saved
				} = JSON.parse(String(existing.content_json)) as SimulatedTrade;
				if (JSON.stringify(saved) !== JSON.stringify(input))
					throw new ResearchError(409, "This request ID already records a different transaction");
				return detailFor(db, datasetId, trackerId);
			}
			const trades = tradesFor(db, trackerId);
			if (trades.length >= 10000) invalid("At most 10000 simulated transactions per tracker");
			const trade: SimulatedTrade = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
			trades.push(trade);
			calculateTrackingPosition(trades, null);
			db.prepare("INSERT INTO stock_tracking_trades VALUES(?,?,?,?,?,?)").run(
				trade.id,
				trackerId,
				trade.requestId,
				trade.date,
				JSON.stringify(trade),
				trade.createdAt,
			);
			recalculateObservations(db, trackerId, trades);
			return detailFor(db, datasetId, trackerId);
		}),
	);
}

export async function refreshStockTracker(
	cwd: string,
	datasetId: string,
	trackerId: string,
	signal: AbortSignal,
	provider: TrackingMarketProvider = fetchTrackingMarketData,
): Promise<StockTrackerDetail> {
	signal.throwIfAborted();
	const claim = database(cwd, datasetId, (db) =>
		researchTransaction(db, () => {
			const row = rowFor(db, datasetId, trackerId);
			if (row.lease_token && Number(row.lease_until) > Date.now())
				throw new ResearchError(409, "Stock tracker is already refreshing");
			const token = randomUUID();
			db.prepare(
				"UPDATE stock_trackers SET lease_token=?,lease_until=?,last_attempt_at=?,status='refreshing' WHERE id=?",
			).run(token, Date.now() + 180000, Date.now(), trackerId);
			return {
				token,
				revision: Number(row.revision),
				config: JSON.parse(String(row.config_json)) as StockTrackerInput,
				latestDate: db
					.prepare("SELECT MAX(trade_date) AS latest FROM stock_tracking_observations WHERE tracker_id=?")
					.get(trackerId)?.latest,
			};
		}),
	);
	try {
		const endDate = trackingMarketClock(claim.config.code).date;
		if (claim.config.startDate > endDate) throw new Error("跟踪开始日期尚未到达");
		const response = await provider(
			cwd,
			{
				symbol: claim.config.code,
				currency: claim.config.currency,
				startDate: claim.latestDate ? String(claim.latestDate) : claim.config.startDate,
				endDate,
			},
			AbortSignal.any([signal, AbortSignal.timeout(150000)]),
		);
		signal.throwIfAborted();
		return database(cwd, datasetId, (db) =>
			researchTransaction(db, () => {
				const row = rowFor(db, datasetId, trackerId);
				if (
					Number(row.revision) !== claim.revision ||
					row.lease_token !== claim.token ||
					Number(row.lease_until) <= Date.now()
				)
					throw new ResearchError(409, "Tracking settings changed or refresh expired; late response ignored");
				const now = new Date().toISOString();
				const warnings = [...response.warnings];
				const valuationWarning = updateValuation(db, datasetId, trackerId, now);
				const valuations = valuationsFor(db, trackerId);
				const trades = tradesFor(db, trackerId);
				const dates = new Set<string>();
				for (const bar of response.bars) {
					if (
						!date(bar.date) ||
						bar.date < claim.config.startDate ||
						bar.date > endDate ||
						!positive(bar.close) ||
						bar.currency !== claim.config.currency ||
						!text(bar.evidenceId, 4096) ||
						dates.has(bar.date)
					)
						throw new Error("Invalid or duplicate historical price row");
					dates.add(bar.date);
					const saved = db
						.prepare("SELECT content_json FROM stock_tracking_observations WHERE tracker_id=? AND trade_date=?")
						.get(trackerId, bar.date);
					// Today can settle on a newer model; previous dates retain the valuation actually recorded then.
					const previous = saved ? (JSON.parse(String(saved.content_json)) as TrackingObservation) : null;
					const candidate =
						previous && bar.date < endDate
							? valuations.find((v) => v.id === previous.valuationId)
							: claim.config.rule.kind === "market"
								? undefined
								: [...valuations]
										.reverse()
										.find((v) => v.effectiveDate <= bar.date && v.targetDate >= bar.date);
					const valuation = candidate && !splitAfterValuation(trades, candidate, bar.date) ? candidate : undefined;
					const observation: TrackingObservation = {
						date: bar.date,
						close: bar.close,
						currency: bar.currency,
						evidenceId: bar.evidenceId,
						valuationId: valuation?.id ?? null,
						bear: valuation?.bear ?? null,
						base: valuation?.base ?? null,
						bull: valuation?.bull ?? null,
						upsidePercent: valuation ? (valuation.base / bar.close - 1) * 100 : null,
						downsidePercent: valuation?.bear != null ? (valuation.bear / bar.close - 1) * 100 : null,
						rewardRisk:
							valuation?.bear != null &&
							valuation.bull !== null &&
							valuation.bear < bar.close &&
							valuation.bull > bar.close
								? (valuation.bull - bar.close) / (bar.close - valuation.bear)
								: null,
						position: calculateTrackingPosition(trades, bar.close, bar.date),
					};
					db.prepare(
						"INSERT INTO stock_tracking_observations VALUES(?,?,?) ON CONFLICT(tracker_id,trade_date) DO UPDATE SET content_json=excluded.content_json",
					).run(trackerId, bar.date, JSON.stringify(observation));
				}
				if (response.quote) {
					const q = response.quote;
					if (
						!positive(q.price) ||
						!date(q.tradeDate) ||
						q.tradeDate > endDate ||
						q.currency !== claim.config.currency ||
						!text(q.evidenceId, 4096) ||
						!Number.isFinite(Date.parse(q.asOf)) ||
						Date.parse(q.asOf) > Date.now() + 60000
					)
						throw new Error("Invalid latest quote");
					const old = row.quote_json ? (JSON.parse(String(row.quote_json)) as TrackingQuote) : null;
					if (!old || Date.parse(q.asOf) >= Date.parse(old.asOf))
						db.prepare("UPDATE stock_trackers SET quote_json=? WHERE id=?").run(JSON.stringify(q), trackerId);
					else warnings.push("本轮行情时间早于已保存行情，保留较新的价格");
				} else warnings.push("最新行情不可用，保留上一有效价格");
				db.prepare(
					"UPDATE stock_trackers SET status=?,error=?,valuation_error=?,last_checked_at=?,lease_token=NULL,lease_until=NULL WHERE id=?",
				).run(
					warnings.length || valuationWarning ? "attention" : "updated",
					warnings.length ? warnings.join("；") : null,
					valuationWarning,
					now,
					trackerId,
				);
				return detailFor(db, datasetId, trackerId);
			}),
		);
	} catch (error) {
		database(cwd, datasetId, (db) =>
			db
				.prepare(
					"UPDATE stock_trackers SET status='error',error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND dataset_id=? AND revision=? AND lease_token=?",
				)
				.run(
					error instanceof Error ? error.message : "Refresh failed",
					trackerId,
					datasetId,
					claim.revision,
					claim.token,
				),
		);
		throw error;
	}
}

/** Weekday close checks use venue time (including US DST); vendor bars determine actual trading days. */
export async function runDueStockTrackers(
	cwd: string,
	datasetId: string,
	signal: AbortSignal,
	provider: TrackingMarketProvider = fetchTrackingMarketData,
): Promise<number> {
	const due = database(cwd, datasetId, (db) =>
		db
			.prepare("SELECT * FROM stock_trackers WHERE dataset_id=? ORDER BY created_at LIMIT 50")
			.all(datasetId)
			.filter((row) => {
				const config = JSON.parse(String(row.config_json)) as StockTrackerInput;
				const clock = trackingMarketClock(config.code);
				if (
					!config.enabled ||
					!clock.afterClose ||
					clock.date < config.startDate ||
					(row.lease_token && Number(row.lease_until) > Date.now())
				)
					return false;
				// ponytail: retry missing bars every 30 minutes for two hours; add a calendar if holiday calls matter.
				if (row.last_attempt_at && Date.now() - Number(row.last_attempt_at) < 1800000) return false;
				const checked = row.last_checked_at
					? trackingMarketClock(config.code, new Date(String(row.last_checked_at)))
					: null;
				if (!checked || checked.date < clock.date || !checked.afterClose) return true;
				return (
					clock.minutesAfterClose <= 120 &&
					!db
						.prepare("SELECT 1 FROM stock_tracking_observations WHERE tracker_id=? AND trade_date=?")
						.get(String(row.id), clock.date)
				);
			})
			.map((row) => String(row.id)),
	);
	let processed = 0;
	for (const id of due) {
		signal.throwIfAborted();
		try {
			await refreshStockTracker(cwd, datasetId, id, signal, provider);
		} catch {
			signal.throwIfAborted();
		}
		processed++;
	}
	return processed;
}
