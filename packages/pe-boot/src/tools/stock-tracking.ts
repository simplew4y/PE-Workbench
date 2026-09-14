import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	addSimulatedTrade,
	getStockTracking,
	refreshStockTracker,
	type StockTrackerSummary,
	saveStockTrackerWithSources,
} from "../tracking.ts";
import { openPeDataset } from "./database.ts";

const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "An absolute calendar date, YYYY-MM-DD." });
const value = Type.Number({ exclusiveMinimum: 0, maximum: 1e12 });
const scenarios = { bear: value, base: value, bull: value };
const citation = Type.String({ minLength: 1, maxLength: 2048 });
const basis = Type.Object({
	summary: Type.String({
		minLength: 1,
		maxLength: 4000,
		description: "Brief source basis. Distinguish model facts from analytical forecast assumptions.",
	}),
	evidenceIds: Type.Array(citation, {
		minItems: 1,
		maxItems: 20,
		description: "Resolvable source: citations from this project's documents, including memo and research reports.",
	}),
});
const config = Type.Object({
	id: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 100,
			description: "Existing tracker ID when updating; omit when creating.",
		}),
	),
	name: Type.String({ minLength: 1, maxLength: 200 }),
	code: Type.String({
		minLength: 1,
		maxLength: 30,
		description: "Exact, document-verified Wind code, such as 0700.HK or AAPL.O.",
	}),
	currency: Type.Union([Type.Literal("CNY"), Type.Literal("HKD"), Type.Literal("USD")]),
	startDate: date,
	targetDate: date,
	enabled: Type.Boolean({
		description:
			"Enable ongoing automatic price and model tracking when the user asks to track. Routine setup needs no extra confirmation.",
	}),
	pnlAlertThresholds: Type.Optional(
		Type.Object(
			{
				profitPercent: Type.Number({ exclusiveMinimum: 0, maximum: 10000 }),
				lossPercent: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
			},
			{
				description:
					"User-set unrealized P&L alerts. Defaults: profit >= 20%, loss >= 10% of remaining cost including buy fees. Enter positive percentages; preserve user settings when updating forecasts.",
			},
		),
	),
	referencePrice: Type.Optional(
		Type.Object(
			{ date, price: value },
			{
				description:
					"Optional model historical market-price reference, only when source-supported; never substitute a target price.",
			},
		),
	),
	rule: Type.Union([
		Type.Object(
			{ kind: Type.Literal("market") },
			{
				description:
					"Track verified market prices when the project has no verifiable model target. Cite the company cover/input or other identity evidence in basis. Leave targets absent; do not invent a substitute value.",
			},
		),
		Type.Object({
			kind: Type.Literal("target"),
			base: value,
			effectiveDate: date,
			evidenceId: Type.String({
				minLength: 1,
				maxLength: 2048,
				description:
					"Exact Excel target-price cell. Value must match its numeric value and formula cache. effectiveDate is the source model date, never today's extraction date unless the source says so.",
			}),
		}),
		Type.Object({ kind: Type.Literal("fixed"), ...scenarios }),
		Type.Object({
			kind: Type.Literal("cell"),
			docId: Type.String({ minLength: 1, maxLength: 128 }),
			sheet: Type.String({ minLength: 1, maxLength: 200 }),
			cell: Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" }),
			label: Type.String({ minLength: 1, maxLength: 200 }),
			period: Type.String({ minLength: 1, maxLength: 200 }),
			unit: Type.String({
				minLength: 1,
				maxLength: 200,
				description:
					"Exact source-cell unit, explicitly the stock currency per share; e.g. HKD/share. Unknown currency or total earnings cannot be guessed.",
			}),
			multipliers: Type.Object(scenarios),
			minValue: value,
			maxValue: value,
			maxChangePercent: Type.Optional(value),
		}),
	]),
	historicalTargets: Type.Optional(
		Type.Array(Type.Object({ date, price: value, evidenceId: citation }), {
			maxItems: 200,
			description:
				"Historical model target-price observations, each with the true model/observation date and exact source cell. Do not manufacture dated targets from today's model. Market-price history belongs to refresh, never here.",
		}),
	),
	valuationEstimates: Type.Optional(
		Type.Array(Type.Object({ date, price: value, basis }), {
			maxItems: 1,
			description:
				"One AI valuation for the current analysis day only. New or changed points must use venue today; never generate historical AI nodes. Fill historical gaps with verified market prices via refresh. basis.summary states calculation method, factual inputs, assumptions and per-share basis. Each update replaces the active estimate; previous analyses remain in configuration revisions. Omit to preserve the latest estimate.",
		}),
	),
	forecast: Type.Optional(
		Type.Object(
			{ ...scenarios, targetDate: date, basis },
			{
				description:
					"Optional forward price range derived from current memo, research reports and model assumptions. Separate from the model target; omit when establishing target-only tracking. Preserve until a sourced update is available.",
			},
		),
	),
	basis,
});
const trade = Type.Object({
	requestId: Type.String({
		minLength: 1,
		maxLength: 128,
		description: "Stable ID for this user transaction; reuse for retries to avoid duplicate simulated fills.",
	}),
	date,
	kind: Type.Union([Type.Literal("buy"), Type.Literal("sell"), Type.Literal("dividend"), Type.Literal("split")]),
	quantity: Type.Optional(value),
	price: Type.Optional(value),
	fee: Type.Optional(Type.Number({ minimum: 0, maximum: 1e12 })),
	amount: Type.Optional(
		Type.Number({ minimum: 0, maximum: 1e12, description: "Dividend total cash, not cash per share." }),
	),
	ratio: Type.Optional(value),
	note: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const peStockTrackingTool = defineTool({
	name: "pe_stock_tracking",
	label: "股票追踪",
	description:
		"Establish tracking directly from this project with no user form. Start with context for historical model versions and current research documents. Use available valuation-model skills and pe_workbook_inspect, pe_valuation_output_locate, pe_valuation_date_resolve, pe_excel_range, pe_formula_trace and pe_source_detail to identify the stock and look for the model TARGET PRICE itself, not EPS or a market quote. If verified, configure rule.kind=target with base, the true source effectiveDate and exact Excel cell citation; import genuinely dated historical targets. If the model has no verifiable target, configure rule.kind=market immediately using the verified stock identity and a real company cover/input or other project citation in basis. Leave targets absent: a missing target must not block tracking or cause repeated searches for invented substitutes. Save first, then refresh to fill MARKET price history through today's latest available trading date. Market prices and financial metrics never substitute for model targets. On updates, inspect model, memo and research reports; save any supported research forecast separately in config.forecast with its horizon and cited rationale, even in market mode. Do not invent a range when research is insufficient. When a target becomes available, update the same tracker to target mode so its price history and simulated trades remain intact. Existing fixed/cell rules remain available for established formulas. Configure uses revision 0 for a new tracker or the latest read revision. Set enabled=true for ongoing tracking, choose routine lookback/horizon defaults yourself, and ask only about critical identity/currency/model ambiguity. Never invent formula caches, dates or prices. Keep results concise. Refresh uses paid Wind quota. Trade only records user-instructed simulated transactions, never inferred fills or quantities.",
	promptSnippet:
		"Stock tracking: identify security → configure → refresh Wind market prices → read valuation-pricing-framework skill from Alice Market → fetch current financial/valuation data with pe_trusted_source → save a sourced future bear/base/bull forecast. analytics maps to get_financial_data for custom valuation calculations. History is actual Wind data, never backdated AI prices. An optional current-day estimate is separate from original model targets. Do not require an extra research review form or stop solely because interim actuals differ from full-year forecasts. Preserve original targets and simulated trades. Trade only on explicit user instructions.",
	parameters: Type.Object({
		operation: Type.Union([
			Type.Literal("context"),
			Type.Literal("read"),
			Type.Literal("configure"),
			Type.Literal("trade"),
			Type.Literal("refresh"),
		]),
		tracker_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
		revision: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Required for configure: zero for a new tracker, otherwise the current revision from read/context.",
			}),
		),
		config: Type.Optional(config),
		trade: Type.Optional(trade),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		const connection = openPeDataset(ctx.cwd);
		const { datasetId, workspaceRoot } = connection;
		let project: { dataset_id: string; name: string } | undefined;
		let documents: Array<Record<string, unknown>> | undefined;
		let documentsTruncated = false;
		try {
			if (params.operation === "context") {
				const metadata = connection.database
					.prepare("SELECT dataset_id,name FROM project_metadata WHERE dataset_id=?")
					.get(datasetId);
				project = { dataset_id: datasetId, name: String(metadata?.name ?? "") };
				const rows = connection.database
					.prepare(`SELECT doc_id,logical_doc_id,version_no,is_current,original_filename,title,file_type,status,parser_name,
					company_name,company_ticker,document_date,target_price,updated_at FROM documents
					WHERE dataset_id=? AND (is_current=1 OR file_type IN ('xlsx','xlsm')) AND deleted_at IS NULL AND (parser_name IS NULL OR parser_name<>'wind_snapshot')
					ORDER BY is_current DESC,updated_at DESC,doc_id LIMIT 101`)
					.all(datasetId);
				documentsTruncated = rows.length > 100;
				documents = rows.slice(0, 100);
			}
		} finally {
			connection.database.close();
		}
		let trackerId = params.tracker_id;
		let mutation: "configured" | "trade_recorded" | null = null;
		if (params.operation === "configure") {
			if (!params.config?.basis || params.revision === undefined)
				throw new Error(
					"Configure requires a complete config, source basis and current revision; inspect project context and documents first",
				);
			if (trackerId && trackerId !== params.config.id)
				throw new Error("tracker_id must match config.id when updating");
			const saved = await saveStockTrackerWithSources(
				workspaceRoot,
				datasetId,
				params.config,
				params.revision,
				signal,
			);
			trackerId = saved.id;
			mutation = "configured";
		} else if (params.operation === "trade") {
			if (!trackerId || !params.trade)
				throw new Error("Trade requires tracker_id and the user's simulated transaction details");
			addSimulatedTrade(workspaceRoot, datasetId, trackerId, params.trade);
			mutation = "trade_recorded";
		} else if (params.operation === "refresh") {
			if (!trackerId) throw new Error("Refresh requires a tracker_id returned by read/context/configure");
			await refreshStockTracker(workspaceRoot, datasetId, trackerId, signal ?? new AbortController().signal);
		}
		const state = getStockTracking(workspaceRoot, datasetId, trackerId);
		const limit = params.limit ?? 30;
		const boundedTracker = (tracker: StockTrackerSummary) => ({
			...tracker,
			config: {
				...tracker.config,
				...(tracker.config.valuationEstimates
					? { valuationEstimates: tracker.config.valuationEstimates.slice(-limit) }
					: {}),
			},
			valuationEstimatesTotal: tracker.config.valuationEstimates?.length ?? 0,
			valuationEstimatesTruncated: (tracker.config.valuationEstimates?.length ?? 0) > limit,
		});
		const result = {
			kind: "pe_stock_tracking",
			operation: params.operation,
			mutation,
			datasetId,
			trackerId: trackerId ?? state.selected?.id ?? null,
			...(project ? { project, documents, documentsTruncated } : {}),
			trackers: state.trackers.map(boundedTracker),
			selected: state.selected
				? {
						...boundedTracker(state.selected),
						observations: state.selected.observations.slice(0, limit),
						trades: state.selected.trades.slice(0, limit),
						valuations: state.selected.valuations.slice(0, limit),
						truncated: [
							state.selected.observations,
							state.selected.trades,
							state.selected.valuations,
							state.selected.config.valuationEstimates ?? [],
						].some((rows) => rows.length > limit),
					}
				: null,
		};
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
