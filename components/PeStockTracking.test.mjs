import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(path, resolver = require) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, require: resolver });
  return exports;
}
const chart = compile("../lib/stock-tracking-chart.ts");
const exports = compile("./PeStockTracking.tsx", (id) => id.endsWith(".css") ? { default: {} } : id === "@/lib/stock-tracking-chart" ? chart : id === "./visualization/EChart" ? { EChart: ({ ariaLabel, height }) => React.createElement("div", { role: "img", "aria-label": ariaLabel, style: { height } }) } : id === "./PeSourceCitation" ? { PeSourceCitation: ({ children, evidenceId }) => React.createElement("a", { href: `#${evidenceId}` }, children) } : require(id));
const render = (name, props) => renderToStaticMarkup(React.createElement(exports[name], props));
const target = (date, base, id = date) => ({ id, effectiveDate: date, effectiveAt: `${date}T12:00:00Z`, base, bear: null, bull: null, evidenceId: `model-${id}`, targetDate: "2027-09-14", rule: { kind: "target" } });
const estimate = (date, price) => ({ date, price, generatedAt: `${date}T09:00:00Z`, basis: { summary: "AI 根据研究资料补齐", evidenceIds: [`research-${date}`] } });
const tracker = (extra = {}) => ({ config: { code: "0700.HK", currency: "HKD", rule: { kind: "target" } }, observations: [], trades: [], quote: null, valuationStatus: "valid", valuations: [target("2026-06-01", 120), target("2026-09-01", 150)], valuation: target("2026-09-01", 150), ...extra });
const byId = (result, id) => result.option.series.find((value) => value.id === id);
const forecast = { bear: 90, base: 140, bull: 180, targetDate: "2027-09-14", basis: { summary: "研究预测", evidenceIds: ["memo-1"] } };

test("legacy DCF is retained for history but cannot appear as current valuation or forecast", () => {
  const value = tracker({ config: { code: "9660.HK", rule: { kind: "target" }, forecast, valuationEstimates: [estimate("2026-09-14", 10.38)] }, valuationEstimateNeedsUpdate: true, forecastNeedsUpdate: true, quote: { tradeDate: "2026-09-14", price: 4.185 } });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  assert.equal(result.currentEstimate, null);
  assert.equal(result.forecast, null);
  assert.equal(byId(result, "estimate"), undefined);
  assert.equal(byId(result, "forecast-base-point"), undefined);
  assert.equal(byId(result, "market").data[0][1], 4.185);
  assert.ok(byId(result, "model"));
  const legacy = { ...estimate("2026-09-14", 10.38), generatedAt: undefined };
  assert.match(render("TrackingTable", { observations: [], valuations: [], estimates: [legacy], cwd: "/project" }), /10.38<small> 待更新/);
  value.config.forecast = undefined;
  value.forecastNeedsUpdate = false;
  value.valuation = { ...value.valuation, bear: 8, base: 10, bull: 12 };
  assert.equal(chart.stockTrackingChart(value, "2026-09-14").forecast, null, "old model range is not a new forecast");
});

test("one action starts tracking without user input fields or technical setup", () => {
  const html = render("TrackingRunButton", { existing: false, busy: false, unavailable: false, onRun() {} });
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /建立追踪/);
  assert.doesNotMatch(html, /input|textarea|手动|配置/);
  assert.match(render("TrackingRunButton", { existing: true, busy: true, unavailable: false, stage: "补齐历史估值", onRun() {} }), /disabled=""/);
});

test("blue history uses actual market prices and AI is only one current-day marker, even with legacy backfills", () => {
  const value = tracker({ config: { code: "0700.HK", currency: "HKD", rule: { kind: "target" }, valuationEstimates: [estimate("2026-09-10", 150), estimate("2026-09-14", 155)] }, observations: [{ date: "2026-09-14", close: 99 }] });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  assert.deepEqual(Array.from(byId(result, "model").data, (point) => point[1]), [120, 150]);
  assert.equal(byId(result, "model").lineStyle.color, "var(--text)");
  assert.deepEqual(Array.from(byId(result, "estimate").data, (point) => point[1]), [155]);
  assert.equal(byId(result, "estimate").type, "scatter");
  assert.equal(byId(result, "estimate").data[0][2], "2026-09-14");
  assert.equal(byId(result, "market").lineStyle.color, "#3978d4");
  assert.deepEqual(Array.from(byId(result, "market").data, (point) => point[1]), [99]);
  assert.equal(result.currentEstimate.price, 155);
  assert.equal(result.option.tooltip.axisPointer.type, "cross");
  assert.equal(result.option.yAxis.scale, true);
  assert.equal(result.option.yAxis.min, undefined);
  assert.equal(result.option.yAxis.max, undefined);
  assert.match(result.option.tooltip.formatter([{ seriesName: "AI 当日估值", value: byId(result, "estimate").data[0] }]), /2026-09-14 · 当日分析\nAI 当日估值  155 HKD/);
  assert.match(render("TrackingChart", { tracker: value, chart: result }), /height:242px/);
});

test("research band expands from today's valuation, preserving bear/base/bull endpoints", () => {
  const value = tracker({ config: { code: "0700.HK", rule: { kind: "target" }, forecast, valuationEstimates: [estimate("2026-09-14", 130)] }, quote: { tradeDate: "2026-09-14", price: 999 } });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  assert.equal(result.anchor.price, 130);
  const todayMarker = byId(result, "estimate").markLine;
  assert.equal(todayMarker.data[0].xAxis, byId(result, "forecast-base").data[0][0]);
  assert.equal(todayMarker.label.formatter, "今日 09-14");
  assert.equal(todayMarker.silent, true);
  assert.ok(byId(result, "model"));
  assert.equal(byId(result, "forecast-base").symbolSize, 7);
  assert.equal(byId(result, "forecast-base").data[0][1], 130);
  assert.equal(byId(result, "forecast-floor").data[1][1], 90);
  assert.equal(byId(result, "forecast-bear-band").data[1][1], 50);
  assert.equal(byId(result, "forecast-bull-band").data[1][1], 40);
  assert.match(byId(result, "forecast-bull-band").areaStyle.color.colorStops[1].color, /119,158,57/);
  assert.match(byId(result, "forecast-bear-band").areaStyle.color.colorStops[1].color, /190,96,73/);
  value.config.valuationEstimates = [estimate("2026-09-13", 130)];
  const stale = chart.stockTrackingChart(value, "2026-09-14");
  assert.equal(stale.anchor.price, 999);
  assert.equal(byId(stale, "estimate"), undefined);
  assert.equal(byId(stale, "forecast-base").data[0][1], 999);
  assert.equal(byId(stale, "forecast-base").data[1][1], 140);
});

test("a split-invalid AI estimate cannot appear as today's point or range anchor", () => {
  const value = tracker({ config: { code: "0700.HK", rule: { kind: "target" }, forecast, valuationEstimates: [estimate("2026-09-14", 130)] }, valuationEstimateSplitReview: true });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  assert.equal(byId(result, "estimate"), undefined);
  assert.equal(result.currentEstimate, null);
  assert.equal(result.anchor, null);
  value.forecastSplitReview = true;
  assert.equal(chart.stockTrackingChart(value, "2026-09-14").forecast, null);
});

test("fresh research forecasts and AI valuation remain independent of old model validity", () => {
  for (const valuationStatus of ["expired", "split_review", "stale"]) {
    const value = tracker({ config: { code: "0700.HK", rule: { kind: "target" }, forecast, valuationEstimates: [estimate("2026-09-14", 130)] }, valuationStatus });
    const result = chart.stockTrackingChart(value, "2026-09-14");
    assert.equal(result.forecast, forecast);
    assert.equal(result.currentEstimate.price, 130);
    assert.equal(byId(result, "forecast-base").data[0][1], 130);
    value.valuationEstimateSplitReview = true;
    const split = chart.stockTrackingChart(value, "2026-09-14");
    assert.equal(split.currentEstimate, null);
    assert.equal(split.anchor, null);
    assert.equal(byId(split, "forecast-base"), undefined);
    assert.equal(split.forecast, forecast);
    value.config.forecast = undefined;
    value.valuation = { ...value.valuation, bear: 80, bull: 170 };
    assert.equal(chart.stockTrackingChart(value, "2026-09-14").forecast, null);
  }
});

test("model-only and market-only data do not fabricate AI or a future range", () => {
  const original = chart.stockTrackingChart(tracker(), "2026-09-14");
  assert.ok(byId(original, "model"));
  assert.equal(byId(original, "estimate"), undefined);
  const market = tracker({ config: { code: "NVDA.O", rule: { kind: "market" } }, valuations: [], valuation: null, valuationStatus: "unavailable", observations: [{ date: "2026-09-14", close: 200 }] });
  assert.equal(chart.stockTrackingChart(market, "2026-09-14").anchor.price, 200);
  assert.equal(byId(chart.stockTrackingChart(market, "2026-09-14"), "model"), undefined);
  market.observations = [];
  assert.match(render("TrackingChart", { tracker: market }), /暂无数据/);
  assert.match(render("TrackingChart", { tracker: market, running: true }), /读取估值与行情中/);
});

test("future AI nodes and overwritten model periods are excluded; forecasts expire against today", () => {
  const value = tracker({ config: { code: "0700.HK", rule: { kind: "target" }, forecast: { ...forecast, targetDate: "2026-09-14" }, valuationEstimates: [estimate("2026-08-01", 1), estimate("2026-09-14", 150), estimate("2026-09-15", 999)] } });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  assert.deepEqual(Array.from(result.estimates, (item) => item.price), [150]);
  assert.equal(result.forecast, null);
});

test("history table keeps original target, AI estimate and market price in separate sourced columns", () => {
  const observations = [{ date: "2026-06-01", close: 105, evidenceId: "quote-1", valuationId: null, base: null }];
  const html = render("TrackingTable", { observations, valuations: [target("2026-06-01", 120)], estimates: [estimate("2026-06-01", 130)], cwd: "/project" });
  assert.match(html, /2026-06-01<\/time><\/td><td>120<\/td><td>130<\/td><td>105/);
  assert.match(html, /href="#model-2026-06-01"/);
  assert.match(html, /href="#research-2026-06-01"/);
  assert.match(html, /href="#quote-1"/);
});

test("newer daily close takes precedence over stale quote", () => {
  const value = tracker({ observations: [{ date: "2026-09-14", close: 105 }], quote: { tradeDate: "2026-09-11", price: 999 } });
  assert.equal(chart.latestMarketPoint(value).close, 105);
  assert.equal(byId(chart.stockTrackingChart(value, "2026-09-14"), "market").data[0][1], 105);
});

test("trade form saves the selected historical date, quantity and price with idempotent retries", () => {
  const props = { busy: false, currency: "USD", code: "NVDA.O", startDate: "2026-01-01", onSave() {}, onCancel() {} };
  const html = render("TradeForm", props);
  assert.equal((html.match(/required=""/g) ?? []).length, 3);
  assert.match(html, /type="date".*min="2026-01-01"/);
  assert.match(html, /<details><summary>可选信息/);
  assert.match(html, /留空按 0 计算/);
  assert.match(html, /保存模拟买入/);
  let today = "2026-09-14";
  const calls = [];
  const request = { current: { body: "", id: "" } };
  const source = readFileSync(new URL("./PeStockTracking.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = {};
  runInNewContext(compiled, { exports: module, FormData: class { constructor(data) { return data; } }, crypto: { randomUUID: () => `request-${calls.length}` }, require: (id) => id === "react" ? { ...React, useState: () => ["buy", () => {}], useRef: () => request } : id === "@/lib/stock-tracking-chart" ? { ...chart, trackingMarketDate: () => today } : id.endsWith(".css") ? { default: {} } : id.startsWith("./") ? {} : require(id) });
  const form = module.TradeForm({ ...props, onSave: (trade) => calls.push(trade) });
  today = "2026-09-15";
  const data = new Map([["date", "2026-09-12"], ["price", "12.5"], ["quantity", "4"], ["fee", ""]]);
  const submit = () => form.props.onSubmit({ preventDefault() {}, currentTarget: data });
  submit(); submit();
  assert.equal(calls[0].date, "2026-09-12");
  assert.equal(calls[0].fee, 0);
  assert.equal(calls[0].price, 12.5);
  assert.equal(calls[0].quantity, 4);
  assert.equal(calls[0].requestId, calls[1].requestId);
  data.set("fee", "2.5"); submit();
  assert.equal(calls[2].fee, 2.5);
  assert.notEqual(calls[2].requestId, calls[0].requestId);
});

test("buy and sell markers use the entered dates and prices and show quantity without changing Wind history", () => {
  const value = tracker({ observations: [{ date: "2026-09-14", close: 105 }], trades: [
    { kind: "buy", date: "2026-09-12", price: 100, quantity: 1000, fee: 5 },
    { kind: "sell", date: "2026-09-14", price: 106, quantity: 200 },
  ] });
  const result = chart.stockTrackingChart(value, "2026-09-14");
  const buy = byId(result, "trade-buy");
  assert.equal(buy.data[0][1], 100);
  assert.equal(buy.data[0][2], "2026-09-12");
  assert.ok(buy.data[0][0] < byId(result, "trade-sell").data[0][0]);
  assert.match(result.option.tooltip.formatter([{ seriesName: buy.name, value: buy.data[0] }]), /1,000 股 · 手续费 5 HKD\n模拟买入  100 HKD/);
  assert.equal(byId(result, "market").data[0][1], 105);
  assert.match(render("TrackingChart", { tracker: value, chart: result }), /模拟买入/);
  assert.equal(chart.stockTrackingChart(tracker({ valuations: [], valuation: null, trades: value.trades }), "2026-09-14").hasData, true);
});

test("the position panel shows editable alert thresholds and warnings only when triggered", () => {
  const value = tracker({ pnlAlertThresholds: { profitPercent: 20, lossPercent: 10 }, pnlAlert: null,
    position: { quantity: 1000, cost: 100000, averageCost: 100, unrealizedPnl: -12000, unrealizedReturnPercent: -12, totalPnl: -12000 } });
  const props = { tracker: value, busy: false, onTrade() {}, onSaveThresholds() {} };
  const normal = render("PositionSummary", props);
  assert.match(normal, /模拟持仓 · 1,000 股/);
  assert.match(normal, /name="profitPercent".*value="20"/);
  assert.match(normal, /name="lossPercent".*value="10"/);
  assert.doesNotMatch(normal, /role="alert"/);
  value.pnlAlert = "loss";
  assert.match(render("PositionSummary", props), /role="alert".*亏损已达到提醒阈值 10%/);
  value.pnlAlert = "profit";
  assert.match(render("PositionSummary", props), /盈利已达到提醒阈值 20%/);
});
