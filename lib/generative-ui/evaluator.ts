import { parseGenerativeUiSurface } from "./parser.ts";
import type { GenerativeUiComponent, GenerativeUiSurface } from "./protocol.ts";

export type GenerativeUiEvaluationCase = {
  id: string;
  prompt: string;
  expected: "prose" | "leaf" | "brief" | "adaptive" | "safe-alternative";
  allowInteraction?: boolean;
  required: string[];
  forbidden: string[];
};

export type GenerativeUiEvaluationResult = {
  caseId: string;
  surface?: unknown;
  text?: string;
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

function componentKinds(component: GenerativeUiComponent): string[] {
  return component.kind === "research_brief"
    ? [component.kind, ...component.blocks.map((block) => block.kind)]
    : [component.kind];
}

function evaluateCase(expectation: GenerativeUiEvaluationCase, result: GenerativeUiEvaluationResult | undefined): GenerativeUiCaseReport {
  const issues: string[] = [];
  if (!result) return { caseId: expectation.id, score: 0, passed: false, kinds: [], issues: ["missing result"] };

  if (result.surface === undefined || result.surface === null) {
    const acceptsProse = expectation.expected === "prose" || expectation.expected === "safe-alternative" || expectation.expected === "adaptive";
    const hasText = typeof result.text === "string" && result.text.trim().length > 0;
    return {
      caseId: expectation.id,
      score: acceptsProse && hasText ? 100 : 0,
      passed: acceptsProse && hasText,
      kinds: [],
      issues: !hasText ? ["empty response"] : acceptsProse ? [] : ["expected a UI surface"],
    };
  }

  const parsed = parseGenerativeUiSurface(result.surface);
  if (!parsed.success) return { caseId: expectation.id, score: 0, passed: false, kinds: [], issues: [`invalid protocol: ${parsed.error}`] };

  const surface = parsed.surface as GenerativeUiSurface;
  const kinds = componentKinds(surface.component);
  let score = 30;

  const modeMatches =
    expectation.expected === "safe-alternative"
    || (expectation.expected === "brief" && surface.component.kind === "research_brief")
    || (expectation.expected === "leaf" && surface.component.kind !== "research_brief")
    || (expectation.expected === "adaptive" && surface.component.kind !== "research_brief");
  if (modeMatches) score += 20;
  else issues.push(`expected ${expectation.expected}, received ${surface.component.kind}`);

  if (surface.presentation?.interaction === "explore" && !expectation.allowInteraction) {
    issues.push("unnecessary interaction: static presentation is sufficient for this case");
    score -= 20;
  }

  const missing = expectation.required.filter((kind) => !kinds.includes(kind));
  if (missing.length === 0) score += 25;
  else issues.push(`missing required kinds: ${missing.join(", ")}`);

  const forbidden = expectation.forbidden.filter((kind) => kinds.includes(kind));
  if (forbidden.length === 0) score += 15;
  else issues.push(`used forbidden kinds: ${forbidden.join(", ")}`);

  if (surface.component.kind === "research_brief") {
    const leafKinds = surface.component.blocks.map((block) => block.kind);
    if (new Set(leafKinds).size === leafKinds.length) score += 10;
    else issues.push("research brief repeats a component kind");
  } else if (expectation.expected !== "brief") {
    score += 10;
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  return { caseId: expectation.id, score: boundedScore, passed: boundedScore >= 80 && issues.length === 0, kinds, issues };
}

export function evaluateGenerativeUiRun(
  cases: GenerativeUiEvaluationCase[],
  results: GenerativeUiEvaluationResult[],
): GenerativeUiEvaluationReport {
  const resultByCase = new Map(results.map((result) => [result.caseId, result]));
  const reports = cases.map((expectation) => evaluateCase(expectation, resultByCase.get(expectation.id)));
  const score = reports.length === 0 ? 0 : reports.reduce((sum, report) => sum + report.score, 0) / reports.length;
  return {
    score: Math.round(score * 10) / 10,
    passed: reports.filter((report) => report.passed).length,
    total: reports.length,
    cases: reports,
  };
}
