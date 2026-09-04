"use client";

import type { ComponentType } from "react";
import { appearanceFrame, getSurfaceAppearance, type SurfaceAppearance } from "@/lib/generative-ui/appearance";
import { parseGenerativeUiSurface } from "@/lib/generative-ui/parser";
import type { LeafGenerativeUiComponent, ResearchBriefComponent } from "@/lib/generative-ui/protocol";
import { cn } from "@/lib/utils";
import { surfaceRegistry, type SurfaceRendererProps } from "./registry";

interface GenerativeSurfaceProps {
  input: unknown;
  isStreaming?: boolean;
  isError?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

export function GenerativeSurface({ input, isStreaming, isError, cwd, onOpenFile }: GenerativeSurfaceProps) {
  const parsed = parseGenerativeUiSurface(input);
  if (!parsed.success) {
    if (isStreaming) return <SurfaceSkeleton />;
    return (
      <div role="alert" style={{ margin: "10px 0", padding: "9px 11px", border: "1px solid rgba(248,113,113,0.35)", borderRadius: 9, background: "rgba(248,113,113,0.06)", color: "var(--text-muted)", fontSize: 11 }}>
        界面数据无效：{parsed.error}
      </div>
    );
  }
  if (isError) return <div role="alert" style={{ color: "#ef4444", fontSize: 12 }}>界面生成失败</div>;
  const component = parsed.surface.component;
  const appearance = getSurfaceAppearance(parsed.surface);
  if (component.kind === "research_brief") {
    return (
      <div data-pe-palette={appearance.palette.name} data-pe-variant={appearance.variant} style={appearanceFrame(appearance)}>
        <ResearchBrief component={component} appearance={appearance} cwd={cwd} onOpenFile={onOpenFile} />
      </div>
    );
  }
  return <LeafSurface component={component} appearance={appearance} cwd={cwd} onOpenFile={onOpenFile} />;
}

function LeafSurface({ component, appearance, cwd, onOpenFile }: SurfaceRendererProps<LeafGenerativeUiComponent>) {
  const Renderer = surfaceRegistry[component.kind] as ComponentType<SurfaceRendererProps>;
  return (
    <div className="pe-surface" data-pe-treatment={appearance.presentation.treatment} data-pe-density={appearance.presentation.density} data-pe-placement={appearance.presentation.placement} data-pe-theme={appearance.presentation.theme} data-pe-palette={appearance.palette.name} data-pe-variant={appearance.variant} style={appearanceFrame(appearance)}>
      <Renderer component={component} appearance={appearance} cwd={cwd} onOpenFile={onOpenFile} />
    </div>
  );
}

const wideKinds = new Set<LeafGenerativeUiComponent["kind"]>([
  "image_gallery",
  "place_map",
  "scenario_calculator",
  "sankey_chart",
  "radar_chart",
  "candlestick_chart",
  "financial_trend",
  "relationship_map",
  "waterfall_chart",
  "segment_breakdown",
  "kpi_strip",
  "valuation_range",
  "peer_quadrant",
]);

function ResearchBrief({ component, appearance, cwd, onOpenFile }: {
  component: ResearchBriefComponent;
  appearance: SurfaceAppearance;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  return (
    <section aria-label={component.title} className="my-3">
      <header className="mb-4 border-b pb-3">
        <h3 className="m-0 text-xl font-semibold tracking-tight">{component.title}</h3>
        <p className="mb-0 mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">{component.thesis}</p>
      </header>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {component.blocks.map((block, index) => {
          const childAppearance = getSurfaceAppearance({ version: 1, presentation: appearance.presentation, component: block });
          childAppearance.palette = appearance.palette;
          return (
            <div key={`${block.kind}:${index}`} className={cn("min-w-0", wideKinds.has(block.kind) && "lg:col-span-2")}>
              <LeafSurface component={block} appearance={childAppearance} cwd={cwd} onOpenFile={onOpenFile} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SurfaceSkeleton() {
  return (
    <div role="status" aria-label="正在组织研究界面" style={{ margin: "12px 0", minHeight: 112, padding: 16, border: "1px solid var(--border)", borderRadius: 14, background: "var(--bg-panel)", opacity: 0.78 }}>
      <div style={{ width: "32%", height: 10, borderRadius: 6, background: "var(--bg-hover)" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 16 }}>
        {[0, 1, 2].map((item) => <div key={item} style={{ height: 54, borderRadius: 9, background: "color-mix(in srgb, var(--bg-hover) 70%, transparent)" }} />)}
      </div>
    </div>
  );
}
