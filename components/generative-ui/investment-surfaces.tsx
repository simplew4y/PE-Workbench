"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { CalendarClock, CircleGauge, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EChart } from "@/components/visualization/EChart";
import { chartDatumName, formatPeerTooltip } from "@/lib/generative-ui/chart-formatters";
import type { CatalystCalendarComponent, PeerQuadrantComponent, ValuationRangeComponent } from "@/lib/generative-ui/protocol";
import { cn } from "@/lib/utils";
import type { SurfaceRendererProps } from "./registry";

const scenarioColor = {
  downside: "#ef4444",
  neutral: "var(--pe-accent)",
  upside: "#16a34a",
} as const;

export function ValuationRange({ component, appearance }: SurfaceRendererProps<ValuationRangeComponent>) {
  const explore = appearance.presentation.interaction === "explore";
  const { scenarios, current, unit } = component;
  const [selectedLabel, setSelectedLabel] = useState(component.scenarios.find((scenario) => scenario.tone === "neutral")?.label ?? component.scenarios[0]?.label);
  const selected = component.scenarios.find((scenario) => scenario.label === selectedLabel) ?? component.scenarios[0];
  const option = useMemo<EChartsCoreOption>(() => ({
    aria: { enabled: true },
    animationDuration: 500,
    grid: { left: 20, right: 26, top: 12, bottom: 18, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value: unknown) => `${value} ${unit}` },
    xAxis: { type: "value", axisLabel: { color: "var(--muted-foreground)", fontSize: 10 }, splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } } },
    yAxis: { type: "category", data: scenarios.map((scenario) => scenario.label), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "var(--foreground)", fontSize: 11 } },
    series: [
      { type: "bar", stack: "range", silent: true, data: scenarios.map((scenario) => scenario.low), itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false } },
      {
        name: "估值区间",
        type: "bar",
        stack: "range",
        barWidth: 18,
        data: scenarios.map((scenario) => ({ value: scenario.high - scenario.low, itemStyle: { color: scenarioColor[scenario.tone ?? "neutral"], borderRadius: 9 } })),
        label: { show: true, position: "inside", color: "#fff", fontSize: 10, formatter: (params: { dataIndex: number }) => { const scenario = scenarios[params.dataIndex]; return scenario ? `${scenario.low}–${scenario.high}` : ""; } },
        ...(current === undefined ? {} : { markLine: { silent: true, symbol: "none", label: { formatter: `当前 ${current}`, color: "var(--foreground)", fontSize: 10 }, lineStyle: { color: "var(--foreground)", type: "dashed", width: 1.5 }, data: [{ xAxis: current }] } }),
      },
    ],
  }), [current, scenarios, unit]);
  return (
    <SurfaceCard title={component.title} icon={Target} insight={component.insight}>
      <EChart option={option} ariaLabel={component.title} height={250} />
      {!explore && <dl className="grid gap-2 px-2 text-xs">{scenarios.map((scenario) => <div key={scenario.label}><dt className="font-medium">{scenario.label} · {scenario.low}–{scenario.high} {unit}</dt>{scenario.rationale && <dd className="m-0 text-muted-foreground">{scenario.rationale}</dd>}</div>)}</dl>}
      {explore && <div className="border-t px-3 py-3">
        <div className="flex flex-wrap gap-1.5">{component.scenarios.map((scenario) => <Button key={scenario.label} type="button" size="xs" variant={scenario.label === selected?.label ? "default" : "outline"} className="rounded-full" onClick={() => setSelectedLabel(scenario.label)}>{scenario.label}</Button>)}</div>
        {selected && <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-muted/55 px-3 py-2"><strong className="text-sm tabular-nums">{selected.low}–{selected.high} {component.unit}</strong>{selected.rationale && <span className="text-[11px] text-muted-foreground">{selected.rationale}</span>}</div>}
      </div>}
    </SurfaceCard>
  );
}

export function PeerQuadrant({ component, appearance }: SurfaceRendererProps<PeerQuadrantComponent>) {
  const explore = appearance.presentation.interaction === "explore";
  const initial = component.peers.find((peer) => peer.highlight) ?? component.peers[0];
  const [selectedName, setSelectedName] = useState(initial?.name);
  const selected = component.peers.find((peer) => peer.name === selectedName) ?? initial;
  const selectFromChart = useCallback((params: unknown) => { const name = chartDatumName(params); if (name) setSelectedName(name); }, []);
  const option = useMemo<EChartsCoreOption>(() => ({
    aria: { enabled: true },
    animationDuration: 500,
    grid: { left: 32, right: 28, top: 22, bottom: 34, containLabel: true },
    tooltip: { trigger: "item", formatter: formatPeerTooltip },
    xAxis: { type: "value", name: `${component.xAxis.label}${component.xAxis.unit ? ` (${component.xAxis.unit})` : ""} →`, nameLocation: "middle", nameGap: 25, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 }, splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } } },
    yAxis: { type: "value", name: `${component.yAxis.label}${component.yAxis.unit ? ` (${component.yAxis.unit})` : ""} →`, axisLabel: { color: "var(--muted-foreground)", fontSize: 10 }, splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } } },
    series: [{
      type: "scatter",
      data: component.peers.map((peer) => ({ name: peer.name, value: [peer.x, peer.y], description: peer.description, symbolSize: peer.highlight ? 24 : 16, itemStyle: { color: peer.highlight ? "var(--pe-accent)" : "var(--pe-series-1)", borderColor: "var(--card)", borderWidth: 2 } })),
      label: { show: true, formatter: "{b}", position: "top", color: "var(--foreground)", fontSize: 10 },
    }],
  }), [component]);
  return (
    <SurfaceCard title={component.title} icon={CircleGauge} insight={component.insight}>
      <EChart option={option} ariaLabel={component.title} height={300} onClick={explore ? selectFromChart : undefined} />
      {!explore && <dl className="grid gap-2 text-xs sm:grid-cols-2">{component.peers.map((peer) => <div key={peer.name}><dt className="font-medium">{peer.name} · {component.xAxis.label} {peer.x}{component.xAxis.unit} · {component.yAxis.label} {peer.y}{component.yAxis.unit}</dt>{peer.description && <dd className="m-0 text-muted-foreground">{peer.description}</dd>}</div>)}</dl>}
      {explore && <div className="flex flex-wrap gap-1.5 border-t px-3 py-3">
        {component.peers.map((peer) => <Button key={peer.name} type="button" size="xs" variant={peer.name === selected?.name ? "default" : "ghost"} className="rounded-full" onClick={() => setSelectedName(peer.name)}>{peer.name}</Button>)}
        {selected && <div className="w-full rounded-lg bg-muted/55 px-3 py-2 text-[11px]"><strong>{component.xAxis.label} {selected.x}{component.xAxis.unit} · {component.yAxis.label} {selected.y}{component.yAxis.unit}</strong>{selected.description && <span className="ml-2 text-muted-foreground">{selected.description}</span>}</div>}
      </div>}
    </SurfaceCard>
  );
}

const impactStyle = {
  positive: "border-emerald-500/50 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
  negative: "border-red-500/50 bg-red-500/8 text-red-700 dark:text-red-300",
  mixed: "border-amber-500/50 bg-amber-500/8 text-amber-700 dark:text-amber-300",
  neutral: "border-border bg-muted/50 text-foreground",
} as const;

const confidenceLabel = { high: "高确定性", medium: "中等确定性", low: "低确定性" } as const;

export function CatalystCalendar({ component }: SurfaceRendererProps<CatalystCalendarComponent>) {
  return (
    <section aria-label={component.title} className="my-3">
      <div className="mb-3 flex items-center gap-2"><CalendarClock className="size-4 text-[var(--pe-accent)]" /><h3 className="m-0 text-sm font-semibold">{component.title}</h3></div>
      <div className="relative grid gap-2 before:absolute before:bottom-3 before:left-[4.65rem] before:top-3 before:w-px before:bg-border">
        {component.events.map((event, index) => (
          <article key={`${event.date}:${event.title}:${index}`} className="relative grid grid-cols-[4rem_1fr] gap-4">
            <time className="pt-3 text-right text-[10px] font-medium text-muted-foreground">{event.date}</time>
            <div className={cn("relative rounded-[var(--pe-radius)] border px-3 py-3 before:absolute before:-left-[1.15rem] before:top-4 before:size-2 before:rounded-full before:bg-[var(--pe-accent)] before:ring-4 before:ring-background", impactStyle[event.impact])}>
              <div className="flex flex-wrap items-start justify-between gap-2"><strong className="text-xs">{event.title}</strong><Badge variant="outline" className="h-5 text-[9px]">{confidenceLabel[event.confidence]}</Badge></div>
              {event.description && <p className="mb-0 mt-1 text-[11px] leading-5 opacity-80">{event.description}</p>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SurfaceCard({ title, icon: Icon, insight, children }: { title: string; icon: typeof Target; insight?: string; children: ReactNode }) {
  return <Card aria-label={title} className="my-3 overflow-hidden rounded-[var(--pe-radius)] py-0"><CardHeader className="flex-row items-center gap-2 border-b px-4 py-3"><Icon className="size-4 text-[var(--pe-accent)]" /><CardTitle className="text-sm">{title}</CardTitle></CardHeader><CardContent className="px-2 py-2">{children}</CardContent>{insight && <p className="m-0 border-t px-4 py-3 text-xs leading-5 text-muted-foreground">{insight}</p>}</Card>;
}
