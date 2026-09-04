"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EChart } from "@/components/visualization/EChart";
import type {
  KpiStripComponent,
  RiskMatrixComponent,
  SegmentBreakdownComponent,
  WaterfallChartComponent,
} from "@/lib/generative-ui/protocol";
import { chartDatumName, formatRiskTooltip, formatTreemapLabel, formatTreemapTooltip } from "@/lib/generative-ui/chart-formatters";
import { cn } from "@/lib/utils";
import type { SurfaceRendererProps } from "./registry";

const metricTone = {
  positive: { className: "text-emerald-600 dark:text-emerald-400", icon: ArrowUpRight },
  negative: { className: "text-red-600 dark:text-red-400", icon: ArrowDownRight },
  neutral: { className: "text-muted-foreground", icon: Minus },
} as const;

export function KpiStrip({ component, appearance }: SurfaceRendererProps<KpiStripComponent>) {
  return (
    <section aria-label={component.title ?? "核心指标"} className="my-3">
      {component.title && <h3 className="mb-2 text-sm font-semibold tracking-tight">{component.title}</h3>}
      <div className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-[var(--pe-radius)] border bg-border sm:grid-cols-3",
        component.metrics.length > 4 && "lg:grid-cols-6",
        appearance.variant === 1 && "gap-2 overflow-visible border-0 bg-transparent",
      )}>
        {component.metrics.map((metric, index) => {
          const tone = metricTone[metric.tone ?? "neutral"];
          const Icon = tone.icon;
          return (
            <div
              key={`${metric.label}:${metric.value}`}
              className={cn(
                "min-w-0 bg-card px-4 py-3",
                appearance.variant === 1 && "rounded-2xl border shadow-sm",
                appearance.variant === 2 && index === 0 && "col-span-2 bg-[color-mix(in_srgb,var(--pe-accent)_12%,var(--card))] sm:col-span-1",
              )}
            >
              <div className="text-[10px] text-muted-foreground">{metric.label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums tracking-tight [overflow-wrap:anywhere]">{metric.value}</div>
              {metric.delta && <div className={cn("mt-1 flex items-center gap-1 text-[10px]", tone.className)}><Icon className="size-3" />{metric.delta}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function WaterfallChart({ component }: SurfaceRendererProps<WaterfallChartComponent>) {
  const option = useMemo<EChartsCoreOption>(() => {
    let running = 0;
    const base: number[] = [];
    const gains: Array<number | string> = [];
    const losses: Array<number | string> = [];
    for (const value of component.values) {
      base.push(value >= 0 ? running : running + value);
      gains.push(value >= 0 ? value : "-");
      losses.push(value < 0 ? -value : "-");
      running += value;
    }
    return {
      aria: { enabled: true },
      animationDuration: 500,
      grid: { left: 18, right: 14, top: 20, bottom: 20, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value: unknown) => `${value}${component.unit ?? ""}` },
      xAxis: { type: "category", data: component.categories, axisTick: { show: false }, axisLine: { lineStyle: { color: "var(--border)" } }, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } }, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 } },
      series: [
        { type: "bar", stack: "bridge", data: base, itemStyle: { color: "transparent", borderColor: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false } },
        { name: "增加", type: "bar", stack: "bridge", data: gains, itemStyle: { color: "#16a34a", borderRadius: [4, 4, 0, 0] }, label: { show: true, position: "top", fontSize: 10 } },
        { name: "减少", type: "bar", stack: "bridge", data: losses, itemStyle: { color: "#ef4444", borderRadius: [0, 0, 4, 4] }, label: { show: true, position: "bottom", formatter: (params: { value: number }) => `-${params.value}`, fontSize: 10 } },
      ],
    };
  }, [component]);
  return <ChartCard title={component.title} insight={component.insight}><EChart option={option} ariaLabel={component.title} height={280} /></ChartCard>;
}

export function RiskMatrix({ component, appearance }: SurfaceRendererProps<RiskMatrixComponent>) {
  const explore = appearance.presentation.interaction === "explore";
  const [selectedName, setSelectedName] = useState(component.risks[0]?.name);
  const selected = component.risks.find((risk) => risk.name === selectedName) ?? component.risks[0];
  const selectFromChart = useCallback((params: unknown) => {
    const name = chartDatumName(params);
    if (name) setSelectedName(name);
  }, []);
  const option = useMemo<EChartsCoreOption>(() => ({
    aria: { enabled: true },
    animationDuration: 500,
    grid: { left: 34, right: 22, top: 18, bottom: 30, containLabel: true },
    tooltip: {
      trigger: "item",
      formatter: formatRiskTooltip,
    },
    xAxis: { type: "value", name: "发生可能性 →", min: 0.5, max: 5.5, interval: 1, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 }, splitLine: { lineStyle: { color: "var(--border)" } } },
    yAxis: { type: "value", name: "影响程度 →", min: 0.5, max: 5.5, interval: 1, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 }, splitLine: { lineStyle: { color: "var(--border)" } } },
    visualMap: { show: false, min: 2, max: 10, dimension: 2, inRange: { color: ["#22c55e", "#f59e0b", "#ef4444"] } },
    series: [{
      type: "scatter",
      symbolSize: (value: number[]) => 16 + value[2] * 1.5,
      data: component.risks.map((risk) => ({ name: risk.name, value: [risk.likelihood, risk.impact, risk.likelihood + risk.impact], description: risk.description })),
      label: { show: true, formatter: "{b}", position: "top", color: "var(--foreground)", fontSize: 10 },
      itemStyle: { borderColor: "var(--card)", borderWidth: 2 },
    }],
  }), [component]);
  return (
    <ChartCard title={component.title} insight={component.insight}>
      <EChart option={option} ariaLabel={component.title} height={300} onClick={explore ? selectFromChart : undefined} />
      {!explore && <dl className="grid gap-2 text-xs sm:grid-cols-2">{component.risks.map((risk) => <div key={risk.name}><dt className="font-medium">{risk.name} · {risk.likelihood}/5 可能性 · {risk.impact}/5 影响</dt>{risk.description && <dd className="m-0 text-muted-foreground">{risk.description}</dd>}</div>)}</dl>}
      {explore && <div className="border-t px-2 py-2">
        <div className="flex flex-wrap gap-1.5">
          {component.risks.map((risk) => <Button key={risk.name} type="button" variant={risk.name === selected?.name ? "default" : "outline"} size="xs" className="h-6 rounded-full text-[10px]" onClick={() => setSelectedName(risk.name)}>{risk.name}</Button>)}
        </div>
        {selected && <div className="mt-2 rounded-lg bg-muted/55 px-3 py-2 text-[11px] leading-5"><span className="font-semibold">可能性 {selected.likelihood}/5 · 影响 {selected.impact}/5</span>{selected.description && <span className="ml-2 text-muted-foreground">{selected.description}</span>}</div>}
      </div>}
    </ChartCard>
  );
}

export function SegmentBreakdown({ component, appearance }: SurfaceRendererProps<SegmentBreakdownComponent>) {
  const explore = appearance.presentation.interaction === "explore";
  const [selectedName, setSelectedName] = useState(component.segments[0]?.name);
  const selected = component.segments.find((segment) => segment.name === selectedName) ?? component.segments[0];
  const selectFromChart = useCallback((params: unknown) => {
    const name = chartDatumName(params);
    if (name) setSelectedName(name);
  }, []);
  const option = useMemo<EChartsCoreOption>(() => ({
    aria: { enabled: true },
    animationDuration: 550,
    tooltip: { formatter: formatTreemapTooltip },
    series: [{
      type: "treemap",
      left: 0,
      right: 0,
      top: 8,
      bottom: 8,
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      label: { show: true, formatter: formatTreemapLabel, rich: { name: { fontSize: 11, lineHeight: 18 }, value: { fontSize: 15, fontWeight: "bold", lineHeight: 22 }, change: { fontSize: 9, opacity: 0.8 } } },
      upperLabel: { show: false },
      itemStyle: { borderColor: "var(--card)", borderWidth: 3, gapWidth: 2, borderRadius: 5 },
      color: ["var(--pe-accent)", "var(--pe-series-1)", "var(--pe-series-2)", "var(--pe-series-3)", "var(--pe-series-4)"],
      data: component.segments.map((segment, index) => ({ ...segment, itemStyle: { color: `var(--pe-series-${index % 5})` }, label: { color: `var(--pe-on-series-${index % 5})` } })),
    }],
  }), [component]);
  return (
    <ChartCard title={component.title} insight={component.insight}>
      <EChart option={option} ariaLabel={component.title} height={290} onClick={explore ? selectFromChart : undefined} />
      {!explore && <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">{component.segments.map((segment) => <div key={segment.name} className="flex gap-2"><dt className="text-muted-foreground">{segment.name}</dt><dd className="m-0">{segment.value.toLocaleString()}{segment.unit}{segment.change ? ` · ${segment.change}` : ""}</dd></div>)}</dl>}
      {explore && <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-2">
        {component.segments.map((segment) => <Button key={segment.name} type="button" variant={segment.name === selected?.name ? "default" : "ghost"} size="xs" className="h-6 rounded-full text-[10px]" onClick={() => setSelectedName(segment.name)}>{segment.name}</Button>)}
        {selected && <span className="ml-auto text-[11px] font-semibold tabular-nums">{selected.value.toLocaleString()}{selected.unit}{selected.change ? ` · ${selected.change}` : ""}</span>}
      </div>}
    </ChartCard>
  );
}

function ChartCard({ title, insight, children }: { title: string; insight?: string; children: ReactNode }) {
  return (
    <Card aria-label={title} className="my-3 overflow-hidden rounded-[var(--pe-radius)] py-0">
      <CardHeader className="flex-row items-center justify-between border-b px-4 py-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-2 py-2">{children}</CardContent>
      {insight && <p className="m-0 border-t px-4 py-3 text-xs leading-5 text-muted-foreground">{insight}</p>}
    </Card>
  );
}
