import type { GenerativeUiSurface, PresentationIntent } from "./protocol";
import type { CSSProperties } from "react";

export type SurfacePalette = {
  name: string;
  accent: string;
  secondary: string;
  tertiary: string;
  warning: string;
  wash: string;
};

export type SurfaceAppearance = {
  palette: SurfacePalette;
  variant: number;
  radius: number;
  presentation: Required<Omit<PresentationIntent, "palette">> & Pick<PresentationIntent, "palette">;
};

const palettes: SurfacePalette[] = [
  { name: "lagoon", accent: "#0891b2", secondary: "#14b8a6", tertiary: "#2563eb", warning: "#f59e0b", wash: "#ecfeff" },
  { name: "orchid", accent: "#7c3aed", secondary: "#c026d3", tertiary: "#4f46e5", warning: "#f97316", wash: "#faf5ff" },
  { name: "forest", accent: "#15803d", secondary: "#65a30d", tertiary: "#0f766e", warning: "#d97706", wash: "#f0fdf4" },
  { name: "ember", accent: "#ea580c", secondary: "#dc2626", tertiary: "#d97706", warning: "#ca8a04", wash: "#fff7ed" },
  { name: "berry", accent: "#be185d", secondary: "#e11d48", tertiary: "#9333ea", warning: "#f59e0b", wash: "#fdf2f8" },
  { name: "ink", accent: "#475569", secondary: "#0f766e", tertiary: "#6366f1", warning: "#d97706", wash: "#f8fafc" },
  { name: "cobalt", accent: "#1d4ed8", secondary: "#0284c7", tertiary: "#6d28d9", warning: "#ea580c", wash: "#eff6ff" },
  { name: "gold", accent: "#b45309", secondary: "#ca8a04", tertiary: "#9a3412", warning: "#dc2626", wash: "#fffbeb" },
];

export function getSurfaceAppearance(surface: GenerativeUiSurface): SurfaceAppearance {
  const presentation: SurfaceAppearance["presentation"] = {
    placement: "inline", treatment: "minimal", density: "compact", theme: "neutral", interaction: "static",
    ...surface.presentation,
  };
  const palette = palettes.find(item => item.name === presentation.theme)
    ?? (presentation.theme === "cool" ? palettes[6] : presentation.theme === "warm" ? palettes[7] : palettes[5]);
  const component = surface.component;
  // Content and intent drive layout. Changing a number must not reshuffle the answer.
  const variant = component.kind === "company_overview"
    ? presentation.treatment === "minimal" || presentation.treatment === "divider" ? 2 : component.metrics.length > 5 ? 1 : 0
    : component.kind === "research_timeline" && presentation.interaction === "explore" ? 1 : 0;
  return {
    palette: presentation.palette
      ? { name: "custom", accent: presentation.palette.accent, secondary: presentation.palette.series[0], tertiary: presentation.palette.series[1], warning: presentation.palette.series[2] ?? palette.warning, wash: palette.wash }
      : presentation.theme === "ink" ? { name: "ink", accent: "#818cf8", secondary: "#22d3ee", tertiary: "#c084fc", warning: "#fbbf24", wash: "#1e293b" } : { ...palette, name: presentation.theme },
    variant,
    radius: presentation.treatment === "card" ? 16 : 8,
    presentation,
  };
}

export function appearanceFrame(appearance: SurfaceAppearance) {
  const series = appearance.presentation.palette?.series ?? [appearance.palette.accent, appearance.palette.secondary, appearance.palette.tertiary, appearance.palette.warning, "#94a3b8"];
  const tokens: Record<string, string> = {};
  for (const [name, color] of [["accent", appearance.palette.accent], ...Array.from({length:5}, (_, index) => [`series-${index}`, series[index % series.length]])]) {
    const light = accessibleColor(color, "#ffffff", 3);
    const dark = accessibleColor(color, "#0f172a", 3);
    tokens[`--pe-${name}-light`] = light;
    tokens[`--pe-${name}-dark`] = dark;
    tokens[`--pe-on-${name}-light`] = contrastRatio(light, "#ffffff") >= contrastRatio(light, "#111827") ? "#ffffff" : "#111827";
    tokens[`--pe-on-${name}-dark`] = contrastRatio(dark, "#ffffff") >= contrastRatio(dark, "#111827") ? "#ffffff" : "#111827";
  }
  return {
    ...tokens,
    width: "100%",
    minWidth: 0,
    "--pe-wash": appearance.palette.wash,
    "--pe-radius": `${appearance.radius}px`,
  } as CSSProperties;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function accessibleColor(color: string, background: string, minimum: number): string {
  if (contrastRatio(color, background) >= minimum) return color;
  const target = luminance(background) > 0.5 ? 0 : 255;
  for (let step = 1; step <= 20; step++) {
    const adjusted = "#" + [1, 3, 5].map(index => Math.round(parseInt(color.slice(index, index + 2), 16) * (1 - step / 20) + target * step / 20).toString(16).padStart(2, "0")).join("");
    if (contrastRatio(adjusted, background) >= minimum) return adjusted;
  }
  return target === 0 ? "#000000" : "#ffffff";
}
