"use client";

import { useEffect, useRef } from "react";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart, TreemapChart, SankeyChart, RadarChart, CandlestickChart } from "echarts/charts";
import {
  AriaComponent,
  RadarComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { cn } from "@/lib/utils";
import { updateChart } from "@/lib/generative-ui/chart-update";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  SankeyChart,
  RadarChart,
  CandlestickChart,
  AriaComponent,
  RadarComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

interface EChartProps {
  option: EChartsCoreOption;
  ariaLabel: string;
  className?: string;
  height?: number;
  onClick?: (params: unknown) => void;
}

function resolveCssValue(value: unknown, style: CSSStyleDeclaration): unknown {
  if (typeof value === "string") {
    let resolved = value;
    for (let depth = 0; depth < 6 && resolved.includes("var("); depth++) {
      resolved = resolved.replace(/var\((--[^,\s)]+)(?:,\s*([^()]+))?\)/g, (_match, token: string, fallback?: string) => {
        return style.getPropertyValue(token).trim() || fallback?.trim() || "transparent";
      });
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveCssValue(item, style));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveCssValue(item, style)]));
  }
  return value;
}

export function EChart({ option, ariaLabel, className, height = 300, onClick }: EChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const chart = chartRef.current;
    if (!host || !chart) return;

    const render = () => {
      const style = getComputedStyle(host);
      const themedOption = resolveCssValue(option, style) as EChartsCoreOption;
      updateChart(chart, themedOption);
    };

    render();
    const themeObserver = new MutationObserver(render);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => themeObserver.disconnect();
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onClick) return;
    const handler = (params: unknown) => onClick(params);
    chart.on("click", handler);
    return () => {
      chart.off("click", handler);
    };
  }, [onClick]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={ariaLabel}
      className={cn("w-full min-w-0", className)}
      style={{ height }}
    />
  );
}
