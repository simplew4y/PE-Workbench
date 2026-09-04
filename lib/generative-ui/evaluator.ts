import { parseGenerativeUiSurface } from "./parser.ts";
import type { GenerativeUiComponent, GenerativeUiSurface } from "./protocol.ts";

export type PresentationAlternative = {
  mode: "prose" | "leaf" | "brief" | "mixed";
  /** All observed leaf kinds must belong to this set. Omit to allow any. */
  kinds?: string[];
};

export type GenerativeUiEvaluationCase = {
  id: string;
  prompt: string;
  relation?: string;
  expected: "prose" | "leaf" | "brief" | "adaptive" | "safe-alternative";
  acceptedPresentations?: PresentationAlternative[];
  maxVisuals?: number;
  allowInteraction?: boolean;
  required: string[];
  forbidden: string[];
};

export type GenerativeUiEvaluationResult = {
  caseId: string;
  surface?: unknown;
  /** Every successful UI call in the answer, not just its first block. */
  surfaces?: unknown[];
  text?: string;
  completion?: "complete" | "pending" | "error";
};

export type GenerativeUiCaseReport = {
  caseId: string;
  score: number;
  passed: boolean;
  kinds: string[];
  issues: string[];
};

export type GenerativeUiEvaluationReport = {
  score: number;
  passed: number;
  total: number;
  cases: GenerativeUiCaseReport[];
};

function leaves(component: GenerativeUiComponent) {
  return component.kind === "research_brief" ? component.blocks : [component];
}

function hasInteraction(surface: GenerativeUiSurface): boolean {
  return surface.presentation?.interaction === "explore" || leaves(surface.component).some((component) => (
    component.kind === "scenario_calculator"
    || ((component.kind === "image_gallery" || component.kind === "entity_cards") && component.layout === "carousel")
  ));
}

function evaluateCase(expectation: GenerativeUiEvaluationCase, result: GenerativeUiEvaluationResult | undefined): GenerativeUiCaseReport {
  const issues: string[] = [];
  const report = (score: number, kinds: string[] = []): GenerativeUiCaseReport => ({
    caseId: expectation.id, score: Math.max(0, score), passed: issues.length === 0, kinds, issues,
  });
  if (!result) {
    issues.push("missing result");
    return report(0);
  }
  if (result.completion && result.completion !== "complete") {
    issues.push(`incomplete response: ${result.completion}`);
    return report(0);
  }
  if (result.surfaces !== undefined && !Array.isArray(result.surfaces)) {
    issues.push("surfaces must be an array");
    return report(0);
  }
  if (result.surface != null && result.surfaces !== undefined) {
    issues.push("provide surface or surfaces, not both");
    return report(0);
  }
  const inputs = result.surfaces ?? (result.surface == null ? [] : [result.surface]);
  const surfaces: GenerativeUiSurface[] = [];
  for (const input of inputs) {
    const parsed = parseGenerativeUiSurface(input);
    if (!parsed.success) {
      issues.push(`invalid protocol: ${parsed.error}`);
      return report(0);
    }
    surfaces.push(parsed.surface);
  }
  const leafKinds = surfaces.flatMap((surface) => leaves(surface.component).map((component) => component.kind));
  const kinds = surfaces.flatMap((surface) => surface.component.kind === "research_brief"
    ? ["research_brief", ...surface.component.blocks.map((block) => block.kind)]
    : [surface.component.kind]);
  const mode = surfaces.length === 0 ? "prose"
    : surfaces.length > 1 ? "mixed"
    : surfaces[0].component.kind === "research_brief" ? "brief" : "leaf";
  if (!surfaces.length && !(typeof result.text === "string" && result.text.trim())) {
    issues.push("empty response");
    return report(0);
  }
  let score = 100;
  const defaults: PresentationAlternative[] = expectation.expected === "adaptive"
    ? [{ mode: "prose" }, { mode: "leaf" }]
    : expectation.expected === "safe-alternative"
      ? [{ mode: "prose" }, { mode: "leaf" }]
      : [{ mode: expectation.expected }];
  const alternatives = expectation.acceptedPresentations ?? defaults;
  const modeMatches = alternatives.some((alternative) => alternative.mode === mode);
  const choiceMatches = alternatives.some((alternative) => alternative.mode === mode
    && (!alternative.kinds || leafKinds.every((kind) => alternative.kinds?.includes(kind))));
  if (!modeMatches) {
    issues.push(mode === "prose" ? "missed visual: expected a UI surface"
      : expectation.expected === "prose" ? "unnecessary UI: prose is sufficient"
        : `unexpected composition: received ${mode}`);
    score -= 40;
  } else if (!choiceMatches) {
    issues.push(`wrong relationship encoding: received ${leafKinds.join(", ")}`);
    score -= 40;
  }
  const missing = expectation.required.filter((kind) => !kinds.includes(kind));
  if (missing.length) {
    issues.push(`missing required kinds: ${missing.join(", ")}`);
    score -= 25;
  }
  const forbidden = expectation.forbidden.filter((kind) => kinds.includes(kind));
  if (forbidden.length) {
    issues.push(`used forbidden kinds: ${forbidden.join(", ")}`);
    score -= 25;
  }
  // Count brief children as well as separate tool calls: call splitting cannot evade the budget.
  if (expectation.maxVisuals !== undefined && leafKinds.length > expectation.maxVisuals) {
    issues.push(`visual overuse: ${leafKinds.length} exceeds ${expectation.maxVisuals}`);
    score -= 25;
  }
  if (!expectation.allowInteraction && surfaces.some(hasInteraction)) {
    issues.push("unnecessary interaction: static presentation is sufficient for this case");
    score -= 20;
  }
  // Repeated kinds may serve different datasets/tasks. Frequency alone is NOT an error.
  return report(score, kinds);
}

export function evaluateGenerativeUiRun(
  cases: GenerativeUiEvaluationCase[],
  results: GenerativeUiEvaluationResult[],
): GenerativeUiEvaluationReport {
  const resultByCase = new Map(results.map((result) => [result.caseId, result]));
  const reports = cases.map((expectation) => {
    if (results.filter((result) => result.caseId === expectation.id).length > 1) {
      return { caseId: expectation.id, score: 0, passed: false, kinds: [], issues: ["duplicate result id; evaluate reruns separately"] };
    }
    return evaluateCase(expectation, resultByCase.get(expectation.id));
  });
  const score = reports.length === 0 ? 0 : reports.reduce((sum, report) => sum + report.score, 0) / reports.length;
  return {
    score: Math.round(score * 10) / 10,
    passed: reports.filter((report) => report.passed).length,
    total: reports.length,
    cases: reports,
  };
}
