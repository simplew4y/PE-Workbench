"use client";

import type { ComponentType } from "react";
import type { SurfaceAppearance } from "@/lib/generative-ui/appearance";
import type { LeafGenerativeUiComponent } from "@/lib/generative-ui/protocol";
import { KpiStrip, RiskMatrix, SegmentBreakdown, WaterfallChart } from "./advanced-surfaces";
import { CatalystCalendar, PeerQuadrant, ValuationRange } from "./investment-surfaces";
import { CompanyOverview, FinancialTrend, ResearchTimeline, SourceCollection } from "./standard-surfaces";
import { InsightCallout, MetricComparison, RelationshipMap } from "./research-surfaces";
import { ImageGallery, EntityCards, PlaceMap, ScenarioCalculator, ExtendedChart } from "./extended-surfaces";

export interface SurfaceRendererProps<T extends LeafGenerativeUiComponent = LeafGenerativeUiComponent> {
  component: T;
  appearance: SurfaceAppearance;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

type SurfaceRegistry = {
  [K in LeafGenerativeUiComponent["kind"]]: ComponentType<SurfaceRendererProps<Extract<LeafGenerativeUiComponent, { kind: K }>>>;
};

export const surfaceRegistry: SurfaceRegistry = {
  image_gallery: ImageGallery,
  entity_cards: EntityCards,
  place_map: PlaceMap,
  scenario_calculator: ScenarioCalculator,
  sankey_chart: ExtendedChart,
  radar_chart: ExtendedChart,
  candlestick_chart: ExtendedChart,
  company_overview: CompanyOverview,
  financial_trend: FinancialTrend,
  metric_comparison: MetricComparison,
  research_timeline: ResearchTimeline,
  insight_callout: InsightCallout,
  source_collection: SourceCollection,
  relationship_map: RelationshipMap,
  kpi_strip: KpiStrip,
  waterfall_chart: WaterfallChart,
  risk_matrix: RiskMatrix,
  segment_breakdown: SegmentBreakdown,
  valuation_range: ValuationRange,
  peer_quadrant: PeerQuadrant,
  catalyst_calendar: CatalystCalendar,
};
