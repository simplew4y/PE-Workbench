"use client";

import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { EChart } from "@/components/visualization/EChart";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { resolveLocalFilePath } from "@/lib/file-links";
import { parsePeUiBlock, type PeUiBlock as PeUiBlockSpec, type PeUiSeries } from "@/lib/pe-ui";
import { cn } from "@/lib/utils";
import { CodeBlock } from "../MermaidBlock";

interface PeUiBlockProps {
  code: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

const chartColors = [
  "var(--pe-series-0, var(--accent))",
  "var(--pe-series-1, #8b5cf6)",
  "var(--pe-series-2, #0891b2)",
  "var(--pe-series-3, #d97706)",
];

const entityLabels = { company: "公司", product: "产品", person: "人物", place: "地点" } as const;
const surfaceClass = "my-3 overflow-hidden rounded-[var(--pe-radius,0.875rem)] border-border/80 bg-card/90 text-card-foreground shadow-sm";

export function PeUiBlock({ code, isStreaming, cwd, onOpenFile }: PeUiBlockProps) {
  const result = useMemo(() => parsePeUiBlock(code), [code]);
  if (!result.success) {
    if (isStreaming) return <Card role="status" aria-label="正在生成界面" className={cn(surfaceClass, "h-24 animate-pulse bg-muted/60")} />;
    return <CodeBlock code={code} lang="pe-ui" />;
  }

  switch (result.block.type) {
    case "entity-card": return <EntityCard block={result.block} />;
    case "chart": return <ChartBlock block={result.block} />;
    case "timeline": return <TimelineBlock block={result.block} />;
    case "gallery": return <GalleryBlock block={result.block} cwd={cwd} onOpenFile={onOpenFile} />;
    case "source-list": return <SourceListBlock block={result.block} cwd={cwd} onOpenFile={onOpenFile} />;
  }
}

function EntityCard({ block }: { block: Extract<PeUiBlockSpec, { type: "entity-card" }> }) {
  return (
    <Card aria-label={`${block.entity}: ${block.name}`} className={cn(surfaceClass, "relative gap-0 py-0 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-gradient-to-b before:from-[var(--pe-accent)] before:to-[var(--pe-series-1)]")}>
      <CardHeader className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-4">
        <div aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--pe-accent)_13%,var(--card))] text-base font-bold text-[var(--pe-accent)]">{block.name.slice(0, 1)}</div>
        <div className="min-w-0">
          <CardTitle className="truncate text-lg">{block.name}</CardTitle>
          {block.subtitle && <CardDescription className="mt-0.5 text-xs">{block.subtitle}</CardDescription>}
        </div>
        <Badge variant="outline" className="text-[10px] text-[var(--pe-accent)]">{entityLabels[block.entity]}</Badge>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {block.description && <p className="m-0 text-xs leading-6 text-muted-foreground">{block.description}</p>}
        {block.metrics?.length ? <MetricTiles metrics={block.metrics} /> : null}
      </CardContent>
    </Card>
  );
}

function MetricTiles({ metrics }: { metrics: Array<{ label: string; value: string }> }) {
  return (
    <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
      {metrics.map((metric) => (
        <div key={`${metric.label}:${metric.value}`} className="min-w-0 rounded-lg bg-muted/70 px-3 py-2.5">
          <dt className="text-[10px] text-muted-foreground">{metric.label}</dt>
          <dd className="mt-1 text-base font-semibold tracking-tight [overflow-wrap:anywhere]">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChartBlock({ block }: { block: Extract<PeUiBlockSpec, { type: "chart" }> }) {
  const option = useMemo(() => buildChartOption(block), [block]);
  return (
    <Card aria-label={block.title} className={surfaceClass}>
      <CardHeader className="pb-1"><CardTitle>{block.title}</CardTitle></CardHeader>
      <CardContent>
        {block.chart !== "pie" && <ChartSummary series={block.series} />}
        <EChart option={option} ariaLabel={block.chart === "bar" ? "条形图" : block.chart === "line" ? "折线图" : "饼图"} height={block.chart === "pie" ? 310 : 300} />
      </CardContent>
    </Card>
  );
}

function ChartSummary({ series }: { series: PeUiSeries[] }) {
  return (
    <div className="mb-1 flex flex-wrap gap-x-6 gap-y-2">
      {series.map((item, index) => {
        const latest = item.values.at(-1) ?? 0;
        const previous = item.values.at(-2);
        const delta = previous === undefined ? null : latest - previous;
        return (
          <div key={item.name} className="min-w-24">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className="size-2 rounded-full" style={{ background: chartColors[index % chartColors.length] }} />{item.name}</div>
            <div className="mt-0.5 text-lg font-semibold tracking-tight">{formatNumber(latest)} <span className="text-[10px] font-normal text-muted-foreground">{item.unit}</span></div>
            {delta !== null && <div className="text-[10px] text-muted-foreground">{delta > 0 ? "↗" : delta < 0 ? "↘" : "→"} 较上期 {delta > 0 ? "+" : ""}{formatNumber(delta)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function buildChartOption(block: Extract<PeUiBlockSpec, { type: "chart" }>): EChartsCoreOption {
  const common = {
    animationDuration: 520,
    color: chartColors,
    aria: { show: true, decal: { show: false } },
    textStyle: { color: "var(--text-muted)", fontFamily: "inherit" },
    tooltip: { trigger: block.chart === "pie" ? "item" : "axis", confine: true, borderWidth: 1, borderColor: "var(--border)", backgroundColor: "var(--bg)", textStyle: { color: "var(--text)" } },
  } as EChartsCoreOption;

  if (block.chart === "pie") {
    const first = block.series[0];
    return {
      ...common,
      legend: { type: "scroll", bottom: 0, textStyle: { color: "var(--text-muted)", fontSize: 10 } },
      series: [{
        name: first?.name ?? block.title,
        type: "pie",
        radius: ["42%", "70%"],
        center: ["50%", "45%"],
        padAngle: 2,
        itemStyle: { borderRadius: 5, borderColor: "var(--card)", borderWidth: 2 },
        label: { color: "var(--text-muted)", formatter: "{b}\n{d}%", fontSize: 10 },
        data: block.categories.map((name, index) => ({ name, value: Math.max(0, first?.values[index] ?? 0) })),
      }],
    };
  }

  const units = [...new Set(block.series.map((item) => item.unit ?? ""))].slice(0, 2);
  const yAxes = units.map((unit, index) => ({
    type: "value",
    name: unit,
    position: index === 0 ? "left" : "right",
    splitLine: { show: index === 0, lineStyle: { color: "var(--border)", opacity: 0.65 } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: "var(--text-dim)", fontSize: 10 },
    nameTextStyle: { color: "var(--text-dim)", fontSize: 10 },
  }));

  return {
    ...common,
    grid: { left: 10, right: units.length > 1 ? 18 : 10, top: 24, bottom: 36, containLabel: true },
    legend: { bottom: 0, textStyle: { color: "var(--text-muted)", fontSize: 10 } },
    xAxis: { type: "category", data: block.categories, boundaryGap: block.chart === "bar", axisLine: { lineStyle: { color: "var(--border)" } }, axisTick: { show: false }, axisLabel: { color: "var(--text-dim)", fontSize: 10, hideOverlap: true } },
    yAxis: yAxes.length ? yAxes : [{ type: "value" }],
    series: block.series.map((item, index) => ({
      name: item.name,
      type: block.chart,
      data: item.values,
      yAxisIndex: Math.max(0, units.indexOf(item.unit ?? "")),
      smooth: block.chart === "line" ? 0.32 : undefined,
      symbolSize: block.chart === "line" ? 7 : undefined,
      showSymbol: block.chart === "line",
      lineStyle: block.chart === "line" ? { width: 3 } : undefined,
      areaStyle: block.chart === "line" && index === 0 ? { opacity: 0.08 } : undefined,
      barMaxWidth: block.chart === "bar" ? 34 : undefined,
      itemStyle: { borderRadius: block.chart === "bar" ? [5, 5, 0, 0] : undefined },
      emphasis: { focus: "series" },
    })),
  };
}

function TimelineBlock({ block }: { block: Extract<PeUiBlockSpec, { type: "timeline" }> }) {
  return (
    <Card aria-label={block.title ?? "时间线"} className={surfaceClass}>
      {block.title && <CardHeader className="pb-1"><CardTitle>{block.title}</CardTitle></CardHeader>}
      <CardContent>
        <ol className="m-0 list-none p-0">
          {block.events.map((event, index) => (
            <li key={`${event.date}:${event.title}`} className="grid grid-cols-[88px_16px_1fr] gap-2.5">
              <Badge variant="outline" className="h-fit justify-self-start px-2 py-0.5 text-[10px] text-[var(--pe-accent)]">{event.date}</Badge>
              <span aria-hidden="true" className="relative flex justify-center"><span className="mt-1.5 size-2 rounded-full bg-[var(--pe-accent)] ring-4 ring-[color-mix(in_srgb,var(--pe-accent)_12%,transparent)]" />{index < block.events.length - 1 && <Separator orientation="vertical" className="absolute top-4 bottom-0 h-auto" />}</span>
              <div className="pb-5"><div className="text-sm font-semibold">{event.title}</div>{event.description && <div className="mt-1 text-xs leading-5 text-muted-foreground">{event.description}</div>}</div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function GalleryBlock({ block, cwd, onOpenFile }: { block: Extract<PeUiBlockSpec, { type: "gallery" }>; cwd?: string; onOpenFile?: (path: string) => void }) {
  const files = block.files.map((file) => ({ ...file, resolved: resolveLocalFilePath(file.path, cwd) })).filter((file) => file.resolved);
  if (!files.length) return null;
  return (
    <section aria-label={block.title ?? "图片画廊"} className="my-3">
      {block.title && <h3 className="mb-3 text-base font-semibold">{block.title}</h3>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
        {files.map((file) => {
          const resolved = file.resolved as string;
          return (
            <Card key={resolved} className="overflow-hidden py-0 transition-transform hover:-translate-y-0.5">
              <button type="button" onClick={() => onOpenFile?.(resolved)} disabled={!onOpenFile} className="w-full cursor-pointer border-0 bg-transparent p-0 text-left text-inherit disabled:cursor-default">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/files/${encodeFilePathForApi(resolved)}?type=read`} alt={file.alt ?? file.caption ?? ""} loading="lazy" className="h-40 w-full object-cover" />
                {file.caption && <span className="block px-3 py-2 text-xs leading-5 text-muted-foreground">{file.caption}</span>}
              </button>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function SourceListBlock({ block, cwd, onOpenFile }: { block: Extract<PeUiBlockSpec, { type: "source-list" }>; cwd?: string; onOpenFile?: (path: string) => void }) {
  return (
    <Card aria-label={block.title ?? "来源"} className={surfaceClass}>
      <CardHeader className="pb-1"><CardTitle>{block.title ?? "来源"}</CardTitle></CardHeader>
      <CardContent>
        <ScrollArea className="max-h-80">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {block.sources.map((source, index) => {
              const filePath = source.filePath ? resolveLocalFilePath(source.filePath, cwd) : null;
              const content = <SourceContent index={index} title={source.title} description={source.description} linked={Boolean(source.url || filePath)} />;
              return <li key={`${source.title}:${source.url ?? source.filePath}`} className="rounded-lg odd:bg-muted/45">{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="block p-2 text-inherit no-underline">{content}</a> : filePath && onOpenFile ? <button type="button" onClick={() => onOpenFile(filePath)} className="w-full cursor-pointer border-0 bg-transparent p-2 text-left text-inherit">{content}</button> : <div className="p-2">{content}</div>}</li>;
            })}
          </ul>
          <ScrollBar orientation="vertical" />
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function SourceContent({ index, title, description, linked }: { index: number; title: string; description?: string; linked: boolean }) {
  return <span className="grid grid-cols-[24px_1fr_auto] items-start gap-2"><Badge variant="secondary" className="grid size-5 place-items-center p-0 text-[9px]">{index + 1}</Badge><span><span className="block text-xs font-semibold">{title}</span>{description && <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">{description}</span>}</span>{linked && <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />}</span>;
}

function formatNumber(value: number): string {
  return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
