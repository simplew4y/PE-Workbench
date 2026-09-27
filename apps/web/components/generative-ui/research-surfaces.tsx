"use client";

import { AlertTriangle, ArrowRight, CircleAlert, TrendingUp } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RelationshipFlow } from "@/components/visualization/RelationshipFlow";
import type { InsightCalloutComponent, MetricComparisonComponent, RelationshipMapComponent } from "@/lib/generative-ui/protocol";
import { cn } from "@/lib/utils";
import type { SurfaceRendererProps } from "./registry";

const surfaceClass = "my-3 overflow-hidden rounded-[var(--pe-radius)] border-border/80 bg-card/90 shadow-sm";

export function MetricComparison({ component, appearance }: SurfaceRendererProps<MetricComparisonComponent>) {
  if (appearance.variant === 1) return <ComparisonCards component={component} />;
  return (
    <Card aria-label={component.title} className={cn(surfaceClass, appearance.variant === 2 && "rounded-none border-x-0 border-b-0 border-t-4 border-t-[var(--pe-accent)] bg-transparent shadow-none")}>
      <CardHeader className="pb-2"><CardTitle>{component.title}</CardTitle></CardHeader>
      <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/55 hover:bg-muted/55">
                <TableHead className="min-w-32 px-4 text-xs">指标</TableHead>
                {/* Columns and row values share positional identity; labels may repeat. */}
                {component.columns.map((column, columnIndex) => <TableHead key={columnIndex} className="min-w-24 px-3 text-right text-xs">{column}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {component.rows.map((row, rowIndex) => (
                <TableRow key={`${row.label}:${rowIndex}`}>
                  <TableHead className="px-4 text-xs font-semibold">{row.label}</TableHead>
                  {row.values.map((value, index) => (
                    <TableCell key={index} className={cn("px-3 text-right text-xs tabular-nums", row.highlight === index && "font-bold text-[var(--pe-accent)]")}>{formatValue(value)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {component.insight && <><Separator /><p className="m-0 px-4 py-3 text-xs leading-5 text-muted-foreground">{component.insight}</p></>}
      </CardContent>
    </Card>
  );
}

function ComparisonCards({ component }: { component: MetricComparisonComponent }) {
  return (
    <section aria-label={component.title} className="my-3">
      <h3 className="mb-3 text-base font-semibold tracking-tight">{component.title}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
        {component.rows.map((row, rowIndex) => (
          <Card key={`${row.label}:${rowIndex}`} className={cn("gap-2 py-4", rowIndex % 2 && "translate-y-1.5")}>
            <CardHeader><Badge variant="outline" className="w-fit text-[10px] text-[var(--pe-accent)]">{row.label}</Badge></CardHeader>
            <CardContent className="space-y-0">
              {row.values.map((value, index) => (
                <div key={index} className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
                  <span className="text-[10px] text-muted-foreground">{component.columns[index]}</span>
                  <span className={cn("text-xs font-medium", row.highlight === index && "font-bold text-[var(--pe-accent)]")}>{formatValue(value)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      {component.insight && <p className="ml-auto mt-4 max-w-2xl text-right text-xs leading-5 text-muted-foreground">{component.insight}</p>}
    </section>
  );
}

const calloutTone = {
  positive: { color: "#16a34a", label: "积极信号", icon: TrendingUp },
  risk: { color: "#dc2626", label: "核心风险", icon: AlertTriangle },
  watch: { color: "#d97706", label: "重点观察", icon: CircleAlert },
  neutral: { color: "var(--pe-accent)", label: "研究判断", icon: ArrowRight },
} as const;

export function InsightCallout({ component, appearance }: SurfaceRendererProps<InsightCalloutComponent>) {
  const tone = calloutTone[component.tone];
  const Icon = tone.icon;
  return (
    <Alert
      aria-label={`${tone.label}: ${component.title}`}
      className={cn(
        "my-3 border-l-4 py-4",
        appearance.variant === 1 && "rounded-[1.5rem_0.35rem_1.5rem_0.35rem] border-y-0 border-r-0 shadow-none",
        appearance.variant === 2 && "rounded-none border-x-0 bg-transparent shadow-none",
      )}
      style={{ borderLeftColor: tone.color, borderTopColor: appearance.variant === 2 ? tone.color : undefined, borderBottomColor: appearance.variant === 2 ? tone.color : undefined }}
    >
      <Icon className="size-4" style={{ color: tone.color }} />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[9px]" style={{ color: tone.color, borderColor: tone.color }}>{tone.label}</Badge>
        <span>{component.title}</span>
      </AlertTitle>
      <AlertDescription className="text-xs leading-6 text-muted-foreground">
        <p className="m-0">{component.body}</p>
        {component.evidence?.length ? <ul className="mb-0 mt-2 list-disc space-y-1 pl-4 text-[11px]">{component.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
      </AlertDescription>
    </Alert>
  );
}

export function RelationshipMap({ component, appearance }: SurfaceRendererProps<RelationshipMapComponent>) {
  return (
    <Card aria-label={component.title} className={cn(surfaceClass, appearance.variant === 2 && "rounded-none border-x-0 border-b-0 border-t-4 border-t-[var(--pe-accent)] bg-transparent shadow-none")}>
      <CardHeader className="pb-2"><CardTitle>{component.title}</CardTitle></CardHeader>
      <CardContent><RelationshipFlow component={component} interactive={appearance.presentation.interaction === "explore"} /></CardContent>
    </Card>
  );
}

function formatValue(value: string | number | null): string {
  if (value === null) return "—";
  return typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value;
}
