import type { EChartsCoreOption } from "echarts/core";
import type { StockTrackerDetail, TrackingObservation, TrackingValuation } from "@earendil-works/pe-boot";

export const trackingChartColors = { model: "var(--text)", estimate: "#8c6bb1", market: "#3978d4", bull: "#779e39", bear: "#be6049", buy: "#23877b", sell: "#be6049" };
const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function trackingMarketDate(code: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: /\.(O|N|A)$/.test(code) ? "America/New_York" : "Asia/Shanghai" }).format(new Date());
}
export function latestMarketPoint(tracker: StockTrackerDetail) {
  const bar = tracker.observations.reduce<TrackingObservation | undefined>((latest, value) => !latest || value.date > latest.date ? value : latest, undefined);
  return tracker.quote && (!bar || tracker.quote.tradeDate >= bar.date) ? { date: tracker.quote.tradeDate, close: tracker.quote.price, asOf: tracker.quote.asOf } : bar ? { date: bar.date, close: bar.close, asOf: null } : null;
}
export function modelHistory(valuations: TrackingValuation[]) {
  const dates = new Map<string, TrackingValuation>();
  for (const value of [...valuations].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))) dates.set(value.effectiveDate, value);
  return [...dates.values()].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}
export function stockTrackingChart(tracker: StockTrackerDetail, today = trackingMarketDate(tracker.config.code)) {
  const models = modelHistory(tracker.config.rule.kind === "target" ? tracker.valuations.filter((value) => value.rule.kind === "target") : tracker.valuations).filter((value) => value.effectiveDate <= today);
  const lastModel = models.at(-1);
  const latestEstimate = tracker.valuationEstimateSplitReview || tracker.valuationEstimateNeedsUpdate ? null : [...(tracker.config.valuationEstimates ?? [])].filter((value) => value.date <= today).sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null;
  const currentEstimate = latestEstimate?.date === today ? latestEstimate : null;
  const estimates = currentEstimate ? [currentEstimate] : [];
  const quote = latestMarketPoint(tracker);
  const anchor = currentEstimate ? { date: currentEstimate.date, price: currentEstimate.price } : lastModel?.effectiveDate === today && tracker.valuationStatus === "valid" ? { date: today, price: lastModel.base } : quote ? { date: quote.date, price: quote.close } : null;
  const forecastBlocked = tracker.forecastSplitReview || tracker.forecastNeedsUpdate;
  let forecast = forecastBlocked ? null : tracker.config.forecast ?? null;
  if (!forecastBlocked && !forecast && tracker.valuationStatus === "valid" && tracker.valuation?.effectiveDate === today && tracker.valuation.bear != null && tracker.valuation.bull != null) forecast = { bear: tracker.valuation.bear, base: tracker.valuation.base, bull: tracker.valuation.bull, targetDate: tracker.valuation.targetDate, basis: tracker.valuation.basis ?? { summary: "模型情景", evidenceIds: [] } };
  if (forecast && forecast.targetDate <= today) forecast = null;
  const market = [...tracker.observations].sort((a, b) => a.date.localeCompare(b.date)).map((value) => ({ date: value.date, price: value.close }));
  if (quote) {
    if (market.at(-1)?.date === quote.date) market.pop();
    market.push({ date: quote.date, price: quote.close });
  }
  const trades = tracker.trades.filter((trade) => (trade.kind === "buy" || trade.kind === "sell") && trade.date <= today);
  const historyDates = [...models.map((value) => value.effectiveDate), ...estimates.map((value) => value.date), ...market.map((value) => value.date), ...trades.map((trade) => trade.date)];
  const hasData = historyDates.length > 0 || !!forecast;
  const todayTime = Date.parse(today);
  const start = Math.min(...historyDates.map(Date.parse), todayTime - 86400000);
  const end = forecast ? Date.parse(forecast.targetDate) : todayTime;
  const boundary = forecast ? .76 : 1;
  const x = (date: string) => Date.parse(date) <= todayTime ? (Date.parse(date) - start) / (todayTime - start) * boundary : boundary + (Date.parse(date) - todayTime) / (end - todayTime) * (1 - boundary);
  const dateAt = (value: number) => new Date(value <= boundary ? start + value / boundary * (todayTime - start) : todayTime + (value - boundary) / (1 - boundary) * (end - todayTime)).toISOString().slice(0, 10);
  const point = (date: string, price: number, source: string) => [x(date), price, date, source];
  const series: Record<string, unknown>[] = [];
  if (forecast && anchor) {
    const gradient = (color: string) => ({ type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "rgba(255,255,255,0)" }, { offset: 1, color }] });
    for (const [id, values, fill] of [
      ["forecast-floor", [anchor.price, forecast.bear], "transparent"],
      ["forecast-bear-band", [0, forecast.base - forecast.bear], gradient("rgba(190,96,73,.34)")],
      ["forecast-bull-band", [0, forecast.bull - forecast.base], gradient("rgba(119,158,57,.34)")],
    ] as const) series.push({ id, type: "line", stack: "forecast-band", data: [[x(anchor.date), values[0]], [1, values[1]]], symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: fill }, silent: true, tooltip: { show: false }, z: 0 });
    series.push({ id: "forecast-base", name: "基准预测", type: "line", data: [point(anchor.date, anchor.price, currentEstimate ? "当前估值" : "预测起点"), point(forecast.targetDate, forecast.base, "研究预测")], lineStyle: { color: trackingChartColors.model, type: "dotted", width: 1.8 }, itemStyle: { color: trackingChartColors.model }, symbol: "circle", symbolSize: 7, z: 3 });
  }
  if (market.length) series.push({ id: "market", name: "实际股价", type: "line", data: market.map((value) => point(value.date, value.price, "Wind 行情")), showSymbol: market.length === 1, symbolSize: 4, lineStyle: { color: trackingChartColors.market, width: 1.8 }, itemStyle: { color: trackingChartColors.market }, z: 1 });
  if (models.length) series.push({ id: "model", name: "原模型目标价", type: "line", data: models.map((value) => point(value.effectiveDate, value.base, "原估值模型")), showSymbol: models.length < 8, symbol: "circle", symbolSize: 5, lineStyle: { color: trackingChartColors.model, width: 2.4 }, itemStyle: { color: trackingChartColors.model }, z: 4 });
  if (currentEstimate) series.push({ id: "estimate", name: "AI 当日估值", type: "scatter", data: [point(currentEstimate.date, currentEstimate.price, "当日分析")], symbol: "diamond", symbolSize: 10, itemStyle: { color: trackingChartColors.estimate }, z: 5 });
  for (const [kind, label] of [["buy", "买入"], ["sell", "卖出"]] as const) {
    const entries = trades.filter((trade) => trade.kind === kind);
    if (entries.length) series.push({ id: `trade-${kind}`, name: `模拟${label}`, type: "scatter", data: entries.map((trade) => point(trade.date, trade.price!, `${number(trade.quantity!)} 股 · 手续费 ${number(trade.fee ?? 0)} ${tracker.config.currency}`)), symbol: "triangle", symbolRotate: kind === "sell" ? 180 : 0, symbolSize: 13, itemStyle: { color: trackingChartColors[kind], borderColor: "var(--bg)", borderWidth: 1.5 }, label: { show: true, formatter: label, position: kind === "buy" ? "bottom" : "top", color: trackingChartColors[kind], fontSize: 10 }, labelLayout: { hideOverlap: true }, z: 7 });
  }
  if (forecast) for (const [key, label] of [["bull", "乐观预测"], ["base", "基准预测"], ["bear", "悲观预测"]] as const) series.push({ id: `forecast-${key}-point`, name: label, type: "scatter", data: [point(forecast.targetDate, forecast[key], "研究预测")], symbolSize: key === "base" ? 7 : 4, itemStyle: { color: key === "base" ? trackingChartColors.model : trackingChartColors[key] }, z: 4 });
  if (forecast) {
    const boundarySeries = series.find((value) => value.id === "estimate") ?? series.find((value) => value.id === "model") ?? series.find((value) => value.id === "market") ?? series.find((value) => value.id === "forecast-base-point");
    if (boundarySeries) boundarySeries.markLine = { silent: true, symbol: "none", tooltip: { show: false }, lineStyle: { color: "var(--border)", type: "solid", width: 1 }, label: { position: "end", formatter: `今日 ${today.slice(5)}`, rotate: 0, color: "var(--text-muted)", fontSize: 10, distance: 6 }, data: [{ xAxis: boundary }] };
  }
  const option: EChartsCoreOption = {
    animation: false,
    aria: { enabled: true },
    grid: { top: 24, right: 9, bottom: 27, left: 49 },
    tooltip: { trigger: "axis", renderMode: "richText", confine: true, backgroundColor: "var(--bg-panel)", borderColor: "var(--border)", textStyle: { color: "var(--text)", fontSize: 11 }, axisPointer: { type: "cross", label: { show: false }, lineStyle: { color: "var(--text-muted)", width: .6 } }, formatter: (input: unknown) => {
      const entries = (Array.isArray(input) ? input : [input]) as Array<{ seriesName?: string; value?: unknown[] }>;
      return entries.filter((entry) => typeof entry.value?.[2] === "string").map((entry) => `${entry.value![2]} · ${entry.value![3]}\n${entry.seriesName}  ${number(Number(entry.value![1]))} ${tracker.config.currency}`).join("\n\n");
    } },
    xAxis: { type: "value", min: 0, max: 1, interval: .25, axisLine: { lineStyle: { color: "var(--border)" } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { color: "var(--text-muted)", fontSize: 10, hideOverlap: true, formatter: (value: number) => dateAt(value).slice(0, 7) }, axisPointer: { label: { formatter: (params: { value: number }) => dateAt(params.value) } } },
    yAxis: { type: "value", scale: true, boundaryGap: ["10%", "10%"], splitNumber: 4, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { color: "var(--text-muted)", fontSize: 10, formatter: (value: number) => number(value) } },
    series,
  };
  return { option, hasData, forecast, anchor, currentEstimate, latestEstimate, models, estimates, quote, today, trades };
}
