import type {
  GenerativeUiComponent,
  GenerativeUiParseResult,
  GenerativeUiSurface,
  LeafGenerativeUiComponent,
  UiTone,
  PresentationIntent,
} from "./protocol";

import { extendedKinds, parseExtendedComponent } from "./extended-contract.ts";

const MAX_TEXT = 500;
const MAX_ITEMS = 20;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseStringifiedComponent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function text(value: unknown, field: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function list(value: unknown, field: string, min = 1, max = MAX_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} has an invalid item count`);
  return value;
}

function stringList(value: unknown, field: string, min = 1, max = MAX_ITEMS): string[] {
  return list(value, field, min, max).map((item, index) => text(item, `${field}[${index}]`) as string);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function parseCompany(value: Record<string, unknown>): GenerativeUiComponent {
  const tones = new Set<UiTone>(["positive", "negative", "neutral"]);
  return {
    kind: "company_overview",
    name: text(value.name, "name") as string,
    subtitle: text(value.subtitle, "subtitle", true),
    description: text(value.description, "description", true),
    metrics: list(value.metrics, "metrics", 3, 8).map((item, index) => {
      const metric = record(item, `metrics[${index}]`);
      const tone = metric.tone;
      if (tone !== undefined && (typeof tone !== "string" || !tones.has(tone as UiTone))) throw new Error(`metrics[${index}].tone is invalid`);
      return { label: text(metric.label, `metrics[${index}].label`) as string, value: text(metric.value, `metrics[${index}].value`) as string, ...(tone ? { tone: tone as UiTone } : {}) };
    }),
  };
}

function parseTrend(value: Record<string, unknown>): GenerativeUiComponent {
  const chart = value.chart;
  if (chart !== "line" && chart !== "bar" && chart !== "pie") throw new Error("chart is invalid");
  const categories = stringList(value.categories, "categories", 2, MAX_ITEMS);
  const series = list(value.series, "series", 1, 4).map((item, index) => {
    const entry = record(item, `series[${index}]`);
    const values = list(entry.values, `series[${index}].values`, categories.length, categories.length).map((number, valueIndex) => {
      if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`series[${index}].values[${valueIndex}] is invalid`);
      return number;
    });
    return { name: text(entry.name, `series[${index}].name`) as string, values, unit: text(entry.unit, `series[${index}].unit`, true) };
  });
  if (chart === "pie" && (series.length !== 1 || series[0].values.some((number) => number < 0))) throw new Error("pie data is invalid");
  return { kind: "financial_trend", title: text(value.title, "title") as string, chart, categories, series, insight: text(value.insight, "insight", true) };
}

function parseComparison(value: Record<string, unknown>): GenerativeUiComponent {
  const columns = stringList(value.columns, "columns", 2, 8);
  return {
    kind: "metric_comparison",
    title: text(value.title, "title") as string,
    columns,
    rows: list(value.rows, "rows").map((item, index) => {
      const row = record(item, `rows[${index}]`);
      const values = list(row.values, `rows[${index}].values`, columns.length, columns.length).map((cell, cellIndex) => {
        if (cell !== null && typeof cell !== "string" && (typeof cell !== "number" || !Number.isFinite(cell))) throw new Error(`rows[${index}].values[${cellIndex}] is invalid`);
        if (typeof cell === "string" && cell.length > MAX_TEXT) throw new Error(`rows[${index}].values[${cellIndex}] is too long`);
        return cell as string | number | null;
      });
      const highlight = row.highlight;
      if (highlight !== undefined && (!Number.isInteger(highlight) || (highlight as number) < 0 || (highlight as number) >= columns.length)) throw new Error(`rows[${index}].highlight is invalid`);
      return { label: text(row.label, `rows[${index}].label`) as string, values, ...(highlight !== undefined ? { highlight: highlight as number } : {}) };
    }),
    insight: text(value.insight, "insight", true),
  };
}

function parseTimeline(value: Record<string, unknown>): GenerativeUiComponent {
  return {
    kind: "research_timeline",
    title: text(value.title, "title") as string,
    events: list(value.events, "events", 3).map((item, index) => {
      const event = record(item, `events[${index}]`);
      return { date: text(event.date, `events[${index}].date`) as string, title: text(event.title, `events[${index}].title`) as string, description: text(event.description, `events[${index}].description`, true) };
    }),
  };
}

function parseCallout(value: Record<string, unknown>): GenerativeUiComponent {
  const tone = value.tone;
  if (tone !== "positive" && tone !== "risk" && tone !== "watch" && tone !== "neutral") throw new Error("tone is invalid");
  return { kind: "insight_callout", tone, title: text(value.title, "title") as string, body: text(value.body, "body") as string, evidence: value.evidence === undefined ? undefined : stringList(value.evidence, "evidence", 0, 4) };
}

function parseSources(value: Record<string, unknown>): GenerativeUiComponent {
  return {
    kind: "source_collection",
    title: text(value.title, "title", true),
    sources: list(value.sources, "sources").map((item, index) => {
      const source = record(item, `sources[${index}]`);
      const url = text(source.url, `sources[${index}].url`, true);
      const filePath = text(source.filePath, `sources[${index}].filePath`, true);
      if (!url && !filePath) throw new Error(`sources[${index}] requires url or filePath`);
      if (url && !/^https?:\/\//i.test(url)) throw new Error(`sources[${index}].url is unsafe`);
      return { title: text(source.title, `sources[${index}].title`) as string, url, filePath, description: text(source.description, `sources[${index}].description`, true) };
    }),
  };
}

function parseMap(value: Record<string, unknown>): GenerativeUiComponent {
  const nodes = list(value.nodes, "nodes", 2, 16).map((item, index) => {
    const node = record(item, `nodes[${index}]`);
    const id = text(node.id, `nodes[${index}].id`) as string;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`nodes[${index}].id is invalid`);
    return { id, label: text(node.label, `nodes[${index}].label`) as string, group: text(node.group, `nodes[${index}].group`, true) };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = list(value.edges, "edges", 1, 24).map((item, index) => {
    const edge = record(item, `edges[${index}]`);
    const from = text(edge.from, `edges[${index}].from`) as string;
    const to = text(edge.to, `edges[${index}].to`) as string;
    if (!ids.has(from) || !ids.has(to)) throw new Error(`edges[${index}] references an unknown node`);
    return { from, to, label: text(edge.label, `edges[${index}].label`, true) };
  });
  return { kind: "relationship_map", title: text(value.title, "title") as string, nodes, edges };
}

function parseKpiStrip(value: Record<string, unknown>): LeafGenerativeUiComponent {
  const tones = new Set<UiTone>(["positive", "negative", "neutral"]);
  return {
    kind: "kpi_strip",
    title: text(value.title, "title", true),
    metrics: list(value.metrics, "metrics", 2, 6).map((item, index) => {
      const metric = record(item, `metrics[${index}]`);
      const tone = metric.tone;
      if (tone !== undefined && (typeof tone !== "string" || !tones.has(tone as UiTone))) throw new Error(`metrics[${index}].tone is invalid`);
      return {
        label: text(metric.label, `metrics[${index}].label`) as string,
        value: text(metric.value, `metrics[${index}].value`) as string,
        delta: text(metric.delta, `metrics[${index}].delta`, true),
        ...(tone ? { tone: tone as UiTone } : {}),
      };
    }),
  };
}

function parseWaterfall(value: Record<string, unknown>): LeafGenerativeUiComponent {
  const categories = stringList(value.categories, "categories", 2, 12);
  const values = list(value.values, "values", categories.length, categories.length).map((item, index) => finiteNumber(item, `values[${index}]`));
  return {
    kind: "waterfall_chart",
    title: text(value.title, "title") as string,
    categories,
    values,
    unit: text(value.unit, "unit", true),
    insight: text(value.insight, "insight", true),
  };
}

function parseRiskMatrix(value: Record<string, unknown>): LeafGenerativeUiComponent {
  return {
    kind: "risk_matrix",
    title: text(value.title, "title") as string,
    risks: list(value.risks, "risks", 2, 12).map((item, index) => {
      const risk = record(item, `risks[${index}]`);
      const likelihood = finiteNumber(risk.likelihood, `risks[${index}].likelihood`);
      const impact = finiteNumber(risk.impact, `risks[${index}].impact`);
      if (!Number.isInteger(likelihood) || likelihood < 1 || likelihood > 5) throw new Error(`risks[${index}].likelihood must be an integer from 1 to 5`);
      if (!Number.isInteger(impact) || impact < 1 || impact > 5) throw new Error(`risks[${index}].impact must be an integer from 1 to 5`);
      return {
        name: text(risk.name, `risks[${index}].name`) as string,
        likelihood,
        impact,
        description: text(risk.description, `risks[${index}].description`, true),
      };
    }),
    insight: text(value.insight, "insight", true),
  };
}

function parseSegmentBreakdown(value: Record<string, unknown>): LeafGenerativeUiComponent {
  return {
    kind: "segment_breakdown",
    title: text(value.title, "title") as string,
    segments: list(value.segments, "segments", 2, 12).map((item, index) => {
      const segment = record(item, `segments[${index}]`);
      const segmentValue = finiteNumber(segment.value, `segments[${index}].value`);
      if (segmentValue < 0) throw new Error(`segments[${index}].value must be non-negative`);
      return {
        name: text(segment.name, `segments[${index}].name`) as string,
        value: segmentValue,
        unit: text(segment.unit, `segments[${index}].unit`, true),
        change: text(segment.change, `segments[${index}].change`, true),
      };
    }),
    insight: text(value.insight, "insight", true),
  };
}

function parseValuationRange(value: Record<string, unknown>): LeafGenerativeUiComponent {
  const current = value.current === undefined ? undefined : finiteNumber(value.current, "current");
  return {
    kind: "valuation_range",
    title: text(value.title, "title") as string,
    unit: text(value.unit, "unit") as string,
    current,
    scenarios: list(value.scenarios, "scenarios", 2, 5).map((item, index) => {
      const scenario = record(item, `scenarios[${index}]`);
      const low = finiteNumber(scenario.low, `scenarios[${index}].low`);
      const high = finiteNumber(scenario.high, `scenarios[${index}].high`);
      if (low > high) throw new Error(`scenarios[${index}].low must not exceed high`);
      const tone = scenario.tone;
      if (tone !== undefined && tone !== "downside" && tone !== "neutral" && tone !== "upside") throw new Error(`scenarios[${index}].tone is invalid`);
      return {
        label: text(scenario.label, `scenarios[${index}].label`) as string,
        low,
        high,
        ...(tone ? { tone } : {}),
        rationale: text(scenario.rationale, `scenarios[${index}].rationale`, true),
      };
    }),
    insight: text(value.insight, "insight", true),
  };
}

function parsePeerQuadrant(value: Record<string, unknown>): LeafGenerativeUiComponent {
  const xAxis = record(value.xAxis, "xAxis");
  const yAxis = record(value.yAxis, "yAxis");
  const peers = list(value.peers, "peers", 3, 12).map((item, index) => {
    const peer = record(item, `peers[${index}]`);
    if (peer.highlight !== undefined && typeof peer.highlight !== "boolean") throw new Error(`peers[${index}].highlight is invalid`);
    return {
      name: text(peer.name, `peers[${index}].name`) as string,
      x: finiteNumber(peer.x, `peers[${index}].x`),
      y: finiteNumber(peer.y, `peers[${index}].y`),
      ...(peer.highlight === true ? { highlight: true } : {}),
      description: text(peer.description, `peers[${index}].description`, true),
    };
  });
  if (new Set(peers.map((peer) => peer.name)).size !== peers.length) throw new Error("peer names must be unique");
  return {
    kind: "peer_quadrant",
    title: text(value.title, "title") as string,
    xAxis: { label: text(xAxis.label, "xAxis.label") as string, unit: text(xAxis.unit, "xAxis.unit", true) },
    yAxis: { label: text(yAxis.label, "yAxis.label") as string, unit: text(yAxis.unit, "yAxis.unit", true) },
    peers,
    insight: text(value.insight, "insight", true),
  };
}

function parseCatalystCalendar(value: Record<string, unknown>): LeafGenerativeUiComponent {
  return {
    kind: "catalyst_calendar",
    title: text(value.title, "title") as string,
    events: list(value.events, "events", 2, 12).map((item, index) => {
      const event = record(item, `events[${index}]`);
      const impact = event.impact;
      const confidence = event.confidence;
      if (impact !== "positive" && impact !== "negative" && impact !== "mixed" && impact !== "neutral") throw new Error(`events[${index}].impact is invalid`);
      if (confidence !== "high" && confidence !== "medium" && confidence !== "low") throw new Error(`events[${index}].confidence is invalid`);
      return {
        date: text(event.date, `events[${index}].date`) as string,
        title: text(event.title, `events[${index}].title`) as string,
        impact,
        confidence,
        description: text(event.description, `events[${index}].description`, true),
      };
    }),
  };
}

function parseComponent(value: unknown, allowBrief = true): GenerativeUiComponent {
  const component = record(value, "component");
  if (extendedKinds.includes(component.kind as string)) return parseExtendedComponent(component);
  switch (component.kind) {
    case "company_overview": return parseCompany(component);
    case "financial_trend": return parseTrend(component);
    case "metric_comparison": return parseComparison(component);
    case "research_timeline": return parseTimeline(component);
    case "insight_callout": return parseCallout(component);
    case "source_collection": return parseSources(component);
    case "relationship_map": return parseMap(component);
    case "kpi_strip": return parseKpiStrip(component);
    case "waterfall_chart": return parseWaterfall(component);
    case "risk_matrix": return parseRiskMatrix(component);
    case "segment_breakdown": return parseSegmentBreakdown(component);
    case "valuation_range": return parseValuationRange(component);
    case "peer_quadrant": return parsePeerQuadrant(component);
    case "catalyst_calendar": return parseCatalystCalendar(component);
    case "research_brief": {
      if (!allowBrief) throw new Error("research_brief cannot contain another research_brief");
      const blocks = list(component.blocks, "blocks", 2, 4).map((block) => parseComponent(block, false) as LeafGenerativeUiComponent);
      return {
        kind: "research_brief",
        title: text(component.title, "title") as string,
        thesis: text(component.thesis, "thesis") as string,
        blocks,
      };
    }
    default: throw new Error("unsupported component kind");
  }
}

export function parseGenerativeUiSurface(value: unknown): GenerativeUiParseResult {
  try {
    const input = record(value, "surface");
    if (input.version !== 1) throw new Error("version must be 1");
    const surface: GenerativeUiSurface = {
      version: 1,
      surface_id: text(input.surface_id, "surface_id", true),
      component: parseComponent(parseStringifiedComponent(input.component)),
      ...(input.presentation === undefined ? {} : { presentation: parsePresentation(input.presentation) }),
    };
    return { success: true, surface };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Invalid generative UI surface" };
  }
}

function parsePresentation(value: unknown): PresentationIntent {
  const input = record(value, "presentation");
  const allowed = {
    placement: ["inline", "standalone"],
    treatment: ["minimal", "divider", "soft", "card", "paper", "glass", "outline", "spotlight"],
    density: ["compact", "comfortable"],
    theme: ["neutral", "cool", "warm", "ink", "lagoon", "orchid", "forest", "ember", "berry", "cobalt", "gold", "slate"],
    interaction: ["static", "explore"],
  };
  for (const [key, entry] of Object.entries(input)) {
    if (key === "palette") {
      const palette = record(entry, "presentation.palette");
      const colors = [palette.accent, ...list(palette.series, "presentation.palette.series", 2, 5)];
      if (Object.keys(palette).some(name => name !== "accent" && name !== "series") || colors.some(color => typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color))) throw new Error("presentation.palette requires six-digit hex colors");
      continue;
    }
    const choices = allowed[key as keyof typeof allowed];
    if (!choices || typeof entry !== "string" || !choices.includes(entry)) throw new Error(`presentation.${key} is invalid`);
  }
  return input as PresentationIntent;
}
