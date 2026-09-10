import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerativeUiSurface } from "./parser.ts";

test("parses a valid financial trend surface", () => {
  const result = parseGenerativeUiSurface({
    version: 1,
    surface_id: "byd-growth",
    component: {
      kind: "financial_trend",
      title: "利润在 2025 年发生反转",
      chart: "line",
      categories: ["2023", "2024", "2025"],
      series: [{ name: "归母净利润", values: [300.41, 402.54, 326.19], unit: "亿元" }],
      insight: "收入仍增长，但利润已经转跌。",
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.success && result.surface.component.kind, "financial_trend");
});

test("parses one JSON-encoded component from compatible tool APIs", () => {
  const component = {
    kind: "kpi_strip",
    title: "经营摘要",
    metrics: [
      { label: "收入", value: "100 亿元" },
      { label: "利润", value: "10 亿元" },
    ],
  };
  const result = parseGenerativeUiSurface({ version: 1, component: JSON.stringify(component) });

  assert.equal(result.success, true);
  assert.deepEqual(result.success && result.surface.component, {
    ...component,
    metrics: component.metrics.map((metric) => ({ ...metric, delta: undefined })),
  });
});

test("rejects malformed and doubly encoded component strings", () => {
  const malformed = parseGenerativeUiSurface({ version: 1, component: "{not valid JSON}" });
  const doublyEncoded = parseGenerativeUiSurface({
    version: 1,
    component: JSON.stringify(JSON.stringify({ kind: "kpi_strip", metrics: [] })),
  });

  assert.equal(malformed.success, false);
  assert.match(malformed.success ? "" : malformed.error, /component must be an object/);
  assert.equal(doublyEncoded.success, false);
  assert.match(doublyEncoded.success ? "" : doublyEncoded.error, /component must be an object/);
});

test("rejects a chart whose values do not align with categories", () => {
  const result = parseGenerativeUiSurface({
    version: 1,
    component: {
      kind: "financial_trend",
      title: "Broken chart",
      chart: "line",
      categories: ["2024", "2025"],
      series: [{ name: "Revenue", values: [1] }],
    },
  });

  assert.equal(result.success, false);
  assert.match(result.success ? "" : result.error, /values/);
});

test("rejects unsafe sources and unknown relationship nodes", () => {
  const unsafeSource = parseGenerativeUiSurface({
    version: 1,
    component: { kind: "source_collection", sources: [{ title: "Bad", url: "javascript:alert(1)" }] },
  });
  const unknownNode = parseGenerativeUiSurface({
    version: 1,
    component: {
      kind: "relationship_map",
      title: "Ownership",
      nodes: [{ id: "parent", label: "Parent" }, { id: "child", label: "Child" }],
      edges: [{ from: "parent", to: "missing" }],
    },
  });

  assert.equal(unsafeSource.success, false);
  assert.equal(unknownNode.success, false);
});

test("parses a research brief with complementary advanced blocks", () => {
  const result = parseGenerativeUiSurface({
    version: 1,
    surface_id: "byd-brief",
    component: {
      kind: "research_brief",
      title: "规模仍在扩张，但盈利质量承压",
      thesis: "营收增长已经明显降速，研发投入和业务规模尚能支撑长期竞争力。",
      blocks: [
        {
          kind: "kpi_strip",
          metrics: [
            { label: "营业收入", value: "8,039.6亿元", delta: "+3.46%", tone: "positive" },
            { label: "归母净利润", value: "326.2亿元", delta: "-18.97%", tone: "negative" },
          ],
        },
        {
          kind: "risk_matrix",
          title: "风险优先级",
          risks: [
            { name: "价格竞争", likelihood: 5, impact: 4 },
            { name: "海外扩张", likelihood: 3, impact: 3 },
          ],
        },
        {
          kind: "segment_breakdown",
          title: "业务结构",
          segments: [
            { name: "汽车相关", value: 80.68, unit: "%" },
            { name: "手机部件", value: 19.31, unit: "%" },
          ],
        },
      ],
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.success && result.surface.component.kind, "research_brief");
});

test("rejects nested briefs and invalid advanced chart values", () => {
  const nested = parseGenerativeUiSurface({
    version: 1,
    component: {
      kind: "research_brief",
      title: "Outer",
      thesis: "Thesis",
      blocks: [
        { kind: "research_brief", title: "Inner", thesis: "Nested", blocks: [] },
        { kind: "kpi_strip", metrics: [{ label: "A", value: "1" }, { label: "B", value: "2" }] },
      ],
    },
  });
  const waterfall = parseGenerativeUiSurface({
    version: 1,
    component: { kind: "waterfall_chart", title: "Bridge", categories: ["A", "B"], values: [1] },
  });

  assert.equal(nested.success, false);
  assert.match(nested.success ? "" : nested.error, /cannot contain/);
  assert.equal(waterfall.success, false);
});

test("parses valuation, peer quadrant, and catalyst components", () => {
  const surfaces = [
    { kind: "valuation_range", title: "目标价存在上行空间", unit: "HKD/share", current: 90, scenarios: [{ label: "悲观", low: 60, high: 75, tone: "downside" }, { label: "基准", low: 95, high: 110, tone: "neutral" }] },
    { kind: "peer_quadrant", title: "增速与回报率领先", xAxis: { label: "收入增速", unit: "%" }, yAxis: { label: "ROE", unit: "%" }, peers: [{ name: "A", x: 3, y: 15, highlight: true }, { name: "B", x: 5, y: 10 }, { name: "C", x: -2, y: 8 }] },
    { kind: "catalyst_calendar", title: "未来催化剂", events: [{ date: "Q1", title: "新车发布", impact: "positive", confidence: "high" }, { date: "Q2", title: "中期业绩", impact: "mixed", confidence: "medium" }] },
  ];
  for (const component of surfaces) {
    const result = parseGenerativeUiSurface({ version: 1, component });
    assert.equal(result.success, true);
  }
});

test("rejects inverted valuation ranges and duplicate peer names", () => {
  const valuation = parseGenerativeUiSurface({ version: 1, component: { kind: "valuation_range", title: "Invalid", unit: "RMB", scenarios: [{ label: "A", low: 3, high: 2 }, { label: "B", low: 1, high: 2 }] } });
  const peers = parseGenerativeUiSurface({ version: 1, component: { kind: "peer_quadrant", title: "Invalid", xAxis: { label: "X" }, yAxis: { label: "Y" }, peers: [{ name: "A", x: 1, y: 1 }, { name: "A", x: 2, y: 2 }, { name: "B", x: 3, y: 3 }] } });
  assert.equal(valuation.success, false);
  assert.equal(peers.success, false);
});
