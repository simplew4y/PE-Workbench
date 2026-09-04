"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { EChart } from "@/components/visualization/EChart";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { calculateScenario } from "@/lib/generative-ui/extended-contract";
import type {
  Gallery,
  Entities,
  Places,
  Calculator,
  Sankey,
  Radar,
  Candlestick,
} from "@/lib/generative-ui/extended-contract";
import type { SurfaceRendererProps } from "./registry";

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="my-3 min-w-0 overflow-hidden" aria-label={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">{children}</CardContent>
    </Card>
  );
}
function Collection({
  carousel,
  children,
}: {
  carousel: boolean;
  children: ReactNode[];
}) {
  if (!carousel)
    return (
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    );
  return (
    <div className="px-10">
      <Carousel opts={{ align: "start" }}>
        <CarouselContent>
          {children.map((child, i) => (
            <CarouselItem key={i} className="basis-full md:basis-1/2">
              {child}
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  );
}
function Media({ src, title }: { src: string; title: string }) {
  const [allowed, setAllowed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const local = src.startsWith("/");
  const url = local
    ? "/api/files/" + encodeFilePathForApi(src) + "?type=read"
    : src;
  if (failed)
    return (
      <p role="status" className="rounded border p-4 text-sm">
        图片无法加载：{title}
      </p>
    );
  if (!local && !allowed)
    return (
      <button
        type="button"
        className="w-full rounded border p-6 text-sm"
        onClick={() => setAllowed(true)}
      >
        加载外部图片：{title}
        <span className="block text-xs text-muted-foreground">
          将连接图片所在网站
        </span>
      </button>
    );
  // Local media uses the existing authorized file endpoint. No arbitrary server-side URL fetch.
  return (
    <button
      type="button"
      aria-label={expanded ? "缩小图片：" + title : "放大图片：" + title}
      aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}
      className="block w-full"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={
          expanded
            ? "max-h-[75vh] w-full object-contain"
            : "h-48 w-full rounded object-contain"
        }
      />
    </button>
  );
}
export function ImageGallery({ component }: SurfaceRendererProps<Gallery>) {
  return (
    <Frame title={component.title}>
      <Collection carousel={component.layout === "carousel"}>
        {component.images.map((item, i) => (
          <figure key={i} className="m-0 min-w-0 space-y-2">
            <Media key={item.src} src={item.src} title={item.title} />
            <figcaption className="text-sm">
              <strong>{item.title}</strong>
              {item.caption && (
                <p className="text-muted-foreground">{item.caption}</p>
              )}
            </figcaption>
          </figure>
        ))}
      </Collection>
    </Frame>
  );
}
export function EntityCards({ component }: SurfaceRendererProps<Entities>) {
  return (
    <Frame title={component.title}>
      <Collection carousel={component.layout === "carousel"}>
        {component.entities.map((entity, i) => (
          <article
            key={i}
            className="min-w-0 space-y-3 rounded border p-4 [overflow-wrap:anywhere]"
          >
            {entity.image && (
              <Media
                key={entity.image}
                src={entity.image}
                title={entity.name}
              />
            )}
            <span className="text-xs text-[var(--pe-accent)]">
              {entity.category}
            </span>
            <h4 className="text-lg font-semibold">{entity.name}</h4>
            <p className="text-sm text-muted-foreground">
              {entity.description}
            </p>
            <dl className="space-y-2 text-sm">
              {entity.facts.map((fact, j) => (
                <div key={j}>
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
            {entity.url && (
              <a
                href={entity.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline"
              >
                查看来源
              </a>
            )}
          </article>
        ))}
      </Collection>
    </Frame>
  );
}
export function PlaceMap({ component }: SurfaceRendererProps<Places>) {
  const [selected, setSelected] = useState(0);
  const [loadMap, setLoadMap] = useState(false);
  const place =
    component.places[Math.min(selected, component.places.length - 1)];
  const bounds = [
    Math.max(-180, place.longitude - 0.2),
    Math.max(-90, place.latitude - 0.15),
    Math.min(180, place.longitude + 0.2),
    Math.min(90, place.latitude + 0.15),
  ].join(",");
  const url =
    "https://www.openstreetmap.org/export/embed.html?bbox=" +
    encodeURIComponent(bounds) +
    "&layer=mapnik&marker=" +
    encodeURIComponent(place.latitude + "," + place.longitude);
  const option = useMemo(
    () => ({
      tooltip: { trigger: "item", renderMode: "richText" },
      xAxis: { type: "value", name: "经度", min: -180, max: 180 },
      yAxis: { type: "value", name: "纬度", min: -90, max: 90 },
      grid: { left: 48, right: 36, top: 30, bottom: 40 },
      series: [
        {
          type: "scatter",
          symbolSize: 14,
          itemStyle: { color: "var(--pe-accent)" },
          label: {
            show: true,
            formatter: "{b}",
            position: "top",
            color: "var(--text-muted)",
          },
          data: component.places.map((p) => ({
            name: p.name,
            value: [p.longitude, p.latitude],
          })),
        },
      ],
    }),
    [component],
  );
  return (
    <Frame title={component.title}>
      <EChart
        option={option}
        ariaLabel={component.title + " 经纬度分布"}
        height={260}
      />
      <p className="text-xs text-muted-foreground">
        上图为经纬度分布，不代表距离或行政边界。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {component.places.map((p, i) => (
          <button
            type="button"
            key={i}
            onClick={() => setSelected(i)}
            aria-pressed={i === selected}
            className="rounded border p-3 text-left aria-pressed:border-[var(--pe-accent)]"
          >
            <strong>{p.name}</strong>
            <p className="text-sm text-muted-foreground">{p.description}</p>
            <span className="text-xs">
              {p.latitude}, {p.longitude}
            </span>
          </button>
        ))}
      </div>
      {loadMap ? (
        <iframe
          key={url}
          title={place.name + "地图"}
          src={url}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-80 w-full rounded border"
        />
      ) : (
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm"
          onClick={() => setLoadMap(true)}
        >
          加载交互地图（将向 OpenStreetMap 发送所选坐标）
        </button>
      )}
    </Frame>
  );
}
export function ScenarioCalculator({
  component,
}: SurfaceRendererProps<Calculator>) {
  // Keyed child resets edited assumptions when a streaming tool replaces its data.
  return (
    <CalculatorInputs key={JSON.stringify(component)} component={component} />
  );
}
function CalculatorInputs({ component }: { component: Calculator }) {
  const [values, setValues] = useState(
    component.inputs.map((input) => input.value),
  );
  const result = calculateScenario(component.operation, values);
  const formula =
    component.operation === "compound"
      ? "本金 × (1 + 增长率% ÷ 100) ^ 期数"
      : component.inputs
          .map((input) => input.label)
          .join(
            component.operation === "product"
              ? " × "
              : component.operation === "sum"
                ? " + "
                : " ÷ ",
          );
  return (
    <Frame title={component.title}>
      <p className="text-sm text-muted-foreground">{component.description}</p>
      <p className="text-xs font-mono">{formula}</p>
      {component.inputs.map((input, i) => (
        <label key={input.id} className="block space-y-2">
          <span className="flex justify-between text-sm">
            <span>{input.label}</span>
            <span>
              {values[i].toLocaleString()}
              {input.unit}
            </span>
          </span>
          <input
            aria-label={input.label}
            type="range"
            min={input.min}
            max={input.max}
            step={input.step}
            value={values[i]}
            onChange={(event) =>
              setValues(
                values.map((v, j) =>
                  j === i ? Number(event.target.value) : v,
                ),
              )
            }
            className="w-full accent-[var(--pe-accent)]"
          />
          <span className="flex justify-between text-xs text-muted-foreground">
            <span>
              {input.min}
              {input.unit}
            </span>
            <span>
              {input.max}
              {input.unit}
            </span>
          </span>
        </label>
      ))}
      <div role="status" aria-live="polite" className="border-t pt-4">
        <span className="text-sm">{component.resultLabel}</span>
        <div className="text-3xl font-semibold text-[var(--pe-accent)]">
          {result === null
            ? "无法计算（除零或数值溢出）"
            : result.toLocaleString(undefined, { maximumFractionDigits: 4 }) +
              " " +
              component.resultUnit}
        </div>
        <p className="text-xs text-muted-foreground">
          交互结果为假设测算，不代表已发生事实。
        </p>
      </div>
      <button
        type="button"
        onClick={() => setValues(component.inputs.map((input) => input.value))}
        className="rounded border px-3 py-1 text-sm"
      >
        重置假设
      </button>
    </Frame>
  );
}
export function ExtendedChart({
  component,
}: SurfaceRendererProps<Sankey | Radar | Candlestick>) {
  const option = useMemo(() => {
    const common = {
      color: Array.from({ length: 5 }, (_, i) => "var(--pe-series-" + i + ")"),
      tooltip: { trigger: "item", renderMode: "richText" },
      aria: {
        enabled: true,
        label: { description: component.title + "。精确数值见下方数据表。" },
      },
      textStyle: { color: "var(--text-muted)" },
    };
    if (component.kind === "sankey_chart")
      return {
        ...common,
        series: [
          {
            type: "sankey",
            data: component.nodes.map((name) => ({ name })),
            links: component.links,
            left: 10,
            right: 120,
            top: 20,
            bottom: 20,
            emphasis: { focus: "adjacency" },
            label: { color: "var(--text-muted)" },
            lineStyle: { color: "gradient", curveness: 0.5 },
          },
        ],
      };
    if (component.kind === "radar_chart")
      return {
        ...common,
        legend: { bottom: 0, textStyle: { color: "var(--text-muted)" } },
        radar: {
          indicator: component.indicators,
          radius: "60%",
          axisName: { color: "var(--text-muted)" },
        },
        series: [
          {
            type: "radar",
            data: component.series.map((series) => ({
              name: series.name,
              value: series.values,
            })),
            areaStyle: { opacity: 0.12 },
          },
        ],
      };
    return {
      ...common,
      tooltip: { trigger: "axis", renderMode: "richText" },
      grid: { left: 65, right: 25, top: 20, bottom: 70 },
      xAxis: { type: "category", data: component.candles.map((c) => c.date) },
      yAxis: { type: "value", scale: true, name: component.unit },
      dataZoom: [{ type: "inside" }, { type: "slider", bottom: 5 }],
      series: [
        {
          type: "candlestick",
          data: component.candles.map((c) => [c.open, c.close, c.low, c.high]),
          itemStyle: {
            color: "#ef4444",
            color0: "#16a34a",
            borderColor: "#ef4444",
            borderColor0: "#16a34a",
          },
        },
      ],
    };
  }, [component]);
  const headers =
    component.kind === "sankey_chart"
      ? ["来源", "去向", "数值 (" + component.unit + ")"]
      : component.kind === "radar_chart"
        ? ["对象", ...component.indicators.map((i) => i.name)]
        : ["日期", "开盘", "收盘", "最低", "最高"];
  const rows =
    component.kind === "sankey_chart"
      ? component.links.map((l) => [l.source, l.target, l.value])
      : component.kind === "radar_chart"
        ? component.series.map((s) => [s.name, ...s.values])
        : component.candles.map((c) => [
            c.date,
            c.open,
            c.close,
            c.low,
            c.high,
          ]);
  return (
    <Frame title={component.title}>
      <EChart option={option} ariaLabel={component.title} height={360} />
      {component.kind === "candlestick_chart" && (
        <p className="text-xs text-muted-foreground">
          红色：收盘高于开盘；绿色：收盘低于开盘。可缩放查看区间。
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">查看数据</summary>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th className="p-2" key={i}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="p-2" key={j}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Frame>
  );
}
