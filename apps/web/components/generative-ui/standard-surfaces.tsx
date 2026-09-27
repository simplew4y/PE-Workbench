"use client";

import { ArrowUpRight } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { Separator } from "@/components/ui/separator";
import type { CompanyOverviewComponent, FinancialTrendComponent, ResearchTimelineComponent, SourceCollectionComponent } from "@/lib/generative-ui/protocol";
import { cn } from "@/lib/utils";
import { PeUiBlock } from "../pe-ui/PeUiBlock";
import type { SurfaceRendererProps } from "./registry";

const toneClass = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-red-600 dark:text-red-400",
  neutral: "text-foreground",
} as const;

export function CompanyOverview({ component, appearance }: SurfaceRendererProps<CompanyOverviewComponent>) {
  if (appearance.variant === 1) return <CompanyMosaic component={component} />;
  if (appearance.variant === 2) return <CompanyRail component={component} />;
  return <CompanyProfile component={component} />;
}

function CompanyProfile({ component }: { component: CompanyOverviewComponent }) {
  return (
    <Card aria-label={`company: ${component.name}`} className="my-3 grid gap-0 overflow-hidden rounded-[var(--pe-radius)] py-0 md:grid-cols-[minmax(220px,0.9fr)_minmax(320px,1.3fr)]">
      <CardHeader className="justify-center bg-gradient-to-br from-[color-mix(in_srgb,var(--pe-accent)_18%,var(--card))] to-[color-mix(in_srgb,var(--pe-series-1)_8%,var(--card))] px-6 py-6">
        <Avatar className="size-12 rounded-2xl">
          <AvatarFallback className="rounded-2xl bg-[var(--pe-accent)] text-lg font-bold text-white">{component.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <CardTitle className="mt-2 text-xl tracking-tight">{component.name}</CardTitle>
        {component.subtitle && <CardDescription className="text-xs">{component.subtitle}</CardDescription>}
        {component.description && <p className="mt-2 text-xs leading-6 text-muted-foreground">{component.description}</p>}
      </CardHeader>
      <MetricMatrix metrics={component.metrics} />
    </Card>
  );
}

function CompanyMosaic({ component }: { component: CompanyOverviewComponent }) {
  return (
    <section aria-label={`company: ${component.name}`} className="my-3">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="m-0 text-2xl font-semibold tracking-tight">{component.name}</h3>
        </div>
        {component.subtitle && <span className="text-xs text-muted-foreground">{component.subtitle}</span>}
      </header>
      {component.description && <p className="mb-3 max-w-3xl text-xs leading-6 text-muted-foreground">{component.description}</p>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        {component.metrics.map((metric, index) => (
          <Card key={`${metric.label}:${metric.value}`} className={cn("gap-0 rounded-[var(--pe-radius)] py-0", index === 0 && "col-span-full bg-gradient-to-r from-[color-mix(in_srgb,var(--pe-accent)_16%,var(--card))] to-card")}>
            <CardContent className={cn("p-4", index === 0 && "py-5")}>
              <div className="text-[10px] text-muted-foreground">{metric.label}</div>
              <div className={cn("mt-2 font-semibold tracking-tight", index === 0 ? "text-2xl" : "text-base", toneClass[metric.tone ?? "neutral"])}>{metric.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function CompanyRail({ component }: { component: CompanyOverviewComponent }) {
  return (
    <Card aria-label={`company: ${component.name}`} className="my-3 gap-0 overflow-hidden rounded-[var(--pe-radius)] border-0 border-l-4 border-l-[var(--pe-accent)] bg-transparent py-1 shadow-none">
      <CardHeader className="px-5 py-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <CardTitle className="text-xl">{component.name}</CardTitle>
          {component.subtitle && <CardDescription className="text-xs">{component.subtitle}</CardDescription>}
        </div>
        {component.description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{component.description}</p>}
      </CardHeader>
      <CardContent className="px-5 pb-2">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] gap-x-6 gap-y-2 pb-2">
          {component.metrics.map((metric, index) => (
            <Card key={`${metric.label}:${metric.value}`} size="sm" className={cn("min-w-0 gap-0 rounded-none border-0 border-t py-0 shadow-none", index === 0 && "border-[var(--pe-accent)]")}>
              <CardContent className="px-4 py-3"><div className="text-[10px] text-muted-foreground">{metric.label}</div><div className={cn("mt-1 text-sm font-semibold", toneClass[metric.tone ?? "neutral"])}>{metric.value}</div></CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricMatrix({ metrics }: { metrics: CompanyOverviewComponent["metrics"] }) {
  return (
    <CardContent className="grid grid-cols-2 p-3">
      {metrics.map((metric, index) => (
        <div key={`${metric.label}:${metric.value}`} className={cn("min-w-0 px-4 py-3", index % 2 === 0 && "border-r", index < metrics.length - 2 && "border-b")}>
          <div className="text-[10px] text-muted-foreground">{metric.label}</div>
          <div className={cn("mt-1 text-base font-semibold tracking-tight [overflow-wrap:anywhere]", toneClass[metric.tone ?? "neutral"])}>{metric.value}</div>
        </div>
      ))}
    </CardContent>
  );
}

export function FinancialTrend({ component, appearance }: SurfaceRendererProps<FinancialTrendComponent>) {
  const chart = <PeUiBlock code={JSON.stringify({ version: 1, type: "chart", chart: component.chart, title: component.title, categories: component.categories, series: component.series })} />;
  if (appearance.variant === 1 && component.insight) {
    return (
      <div className="grid items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_240px]">
        {chart}
        <Card className="my-3 border-0 bg-gradient-to-br from-[var(--pe-accent)] to-[var(--pe-series-1)] text-white">
          <CardHeader><Badge className="w-fit bg-white/15 text-[9px] text-white">WHAT MATTERS</Badge><CardTitle className="text-base">趋势解读</CardTitle></CardHeader>
          <CardContent className="text-xs leading-6 text-white/90">{component.insight}</CardContent>
        </Card>
      </div>
    );
  }
  if (appearance.variant === 2) return <div className="border-t-4 border-[var(--pe-accent)] pt-0.5">{chart}{component.insight && <p className="-mt-1 ml-auto max-w-2xl px-3 pb-3 text-right text-xs leading-5 text-muted-foreground">{component.insight}</p>}</div>;
  return <div>{chart}{component.insight && <p className="-mt-1 px-4 pb-3 text-xs leading-5 text-muted-foreground">{component.insight}</p>}</div>;
}

export function ResearchTimeline({ component, appearance }: SurfaceRendererProps<ResearchTimelineComponent>) {
  if (appearance.variant !== 1) return <PeUiBlock code={JSON.stringify({ version: 1, type: "timeline", title: component.title, events: component.events })} />;
  return (
    <section aria-label={component.title} className="my-3 px-10">
      <h3 className="mb-3 text-base font-semibold">{component.title}</h3>
      <Carousel opts={{ align: "start" }}>
        <CarouselContent>
          {component.events.map((event, index) => (
            <CarouselItem key={`${event.date}:${event.title}`} className="basis-[85%] sm:basis-1/2 lg:basis-1/3">
              <Card className={cn("h-full gap-2 py-4", index % 2 ? "rounded-3xl" : "rounded-lg")}>
                <CardHeader><Badge variant="outline" className="w-fit text-[10px] text-[var(--pe-accent)]">{event.date}</Badge><CardTitle className="text-sm">{event.title}</CardTitle></CardHeader>
                {event.description && <CardContent className="text-xs leading-5 text-muted-foreground">{event.description}</CardContent>}
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious /><CarouselNext />
      </Carousel>
    </section>
  );
}

export function SourceCollection({ component, appearance, cwd, onOpenFile }: SurfaceRendererProps<SourceCollectionComponent>) {
  const sources = <PeUiBlock code={JSON.stringify({ version: 1, type: "source-list", title: component.title, sources: component.sources })} cwd={cwd} onOpenFile={onOpenFile} />;
  if (appearance.variant !== 2) return sources;
  return <div className="my-3 grid grid-cols-[4px_1fr] gap-3"><Separator orientation="vertical" className="h-full w-1 bg-[var(--pe-accent)]" /><div>{sources}<div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">查看原始依据 <ArrowUpRight className="size-3" /></div></div></div>;
}
