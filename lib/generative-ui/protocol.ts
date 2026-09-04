import type { ExtendedComponent } from "./extended-contract";
export type UiTone = "positive" | "negative" | "neutral";

export type CompanyOverviewComponent = {
  kind: "company_overview";
  name: string;
  subtitle?: string;
  description?: string;
  metrics: Array<{ label: string; value: string; tone?: UiTone }>;
};

export type FinancialTrendComponent = {
  kind: "financial_trend";
  title: string;
  chart: "line" | "bar" | "pie";
  categories: string[];
  series: Array<{ name: string; values: number[]; unit?: string }>;
  insight?: string;
};

export type MetricComparisonComponent = {
  kind: "metric_comparison";
  title: string;
  columns: string[];
  rows: Array<{ label: string; values: Array<string | number | null>; highlight?: number }>;
  insight?: string;
};

export type ResearchTimelineComponent = {
  kind: "research_timeline";
  title: string;
  events: Array<{ date: string; title: string; description?: string }>;
};

export type InsightCalloutComponent = {
  kind: "insight_callout";
  tone: "positive" | "risk" | "watch" | "neutral";
  title: string;
  body: string;
  evidence?: string[];
};

export type SourceCollectionComponent = {
  kind: "source_collection";
  title?: string;
  sources: Array<{ title: string; url?: string; filePath?: string; description?: string }>;
};

export type RelationshipMapComponent = {
  kind: "relationship_map";
  title: string;
  nodes: Array<{ id: string; label: string; group?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
};

export type KpiStripComponent = {
  kind: "kpi_strip";
  title?: string;
  metrics: Array<{ label: string; value: string; delta?: string; tone?: UiTone }>;
};

export type WaterfallChartComponent = {
  kind: "waterfall_chart";
  title: string;
  categories: string[];
  values: number[];
  unit?: string;
  insight?: string;
};

export type RiskMatrixComponent = {
  kind: "risk_matrix";
  title: string;
  risks: Array<{ name: string; likelihood: number; impact: number; description?: string }>;
  insight?: string;
};

export type SegmentBreakdownComponent = {
  kind: "segment_breakdown";
  title: string;
  segments: Array<{ name: string; value: number; unit?: string; change?: string }>;
  insight?: string;
};

export type ValuationRangeComponent = {
  kind: "valuation_range";
  title: string;
  unit: string;
  current?: number;
  scenarios: Array<{
    label: string;
    low: number;
    high: number;
    tone?: "downside" | "neutral" | "upside";
    rationale?: string;
  }>;
  insight?: string;
};

export type PeerQuadrantComponent = {
  kind: "peer_quadrant";
  title: string;
  xAxis: { label: string; unit?: string };
  yAxis: { label: string; unit?: string };
  peers: Array<{ name: string; x: number; y: number; highlight?: boolean; description?: string }>;
  insight?: string;
};

export type CatalystCalendarComponent = {
  kind: "catalyst_calendar";
  title: string;
  events: Array<{
    date: string;
    title: string;
    impact: "positive" | "negative" | "mixed" | "neutral";
    confidence: "high" | "medium" | "low";
    description?: string;
  }>;
};

export type LeafGenerativeUiComponent =
  | ExtendedComponent
  | CompanyOverviewComponent
  | FinancialTrendComponent
  | MetricComparisonComponent
  | ResearchTimelineComponent
  | InsightCalloutComponent
  | SourceCollectionComponent
  | RelationshipMapComponent
  | KpiStripComponent
  | WaterfallChartComponent
  | RiskMatrixComponent
  | SegmentBreakdownComponent
  | ValuationRangeComponent
  | PeerQuadrantComponent
  | CatalystCalendarComponent;

export type ResearchBriefComponent = {
  kind: "research_brief";
  title: string;
  thesis: string;
  blocks: LeafGenerativeUiComponent[];
};

export type GenerativeUiComponent = LeafGenerativeUiComponent | ResearchBriefComponent;

export type GenerativeUiSurface = {
  version: 1;
  presentation?: PresentationIntent;
  surface_id?: string;
  component: GenerativeUiComponent;
};

export type GenerativeUiParseResult =
  | { success: true; surface: GenerativeUiSurface }
  | { success: false; error: string };

export type PresentationIntent = {
  placement?: "inline" | "standalone";
  treatment?: "minimal" | "divider" | "soft" | "card" | "paper" | "glass" | "outline" | "spotlight";
  density?: "compact" | "comfortable";
  theme?: "neutral" | "cool" | "warm" | "ink" | "lagoon" | "orchid" | "forest" | "ember" | "berry" | "cobalt" | "gold" | "slate";
  palette?: { accent: string; series: string[] };
  interaction?: "static" | "explore";
};
