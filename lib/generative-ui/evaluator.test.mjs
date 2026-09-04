import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGenerativeUiRun } from "./evaluator.ts";

const cases = [
  { id: "simple", prompt: "definition", expected: "prose", required: [], forbidden: ["research_brief"] },
  { id: "brief", prompt: "diagnosis", expected: "brief", required: ["research_brief", "valuation_range", "catalyst_calendar"], forbidden: [] },
  { id: "unsafe", prompt: "unsupported valuation", expected: "safe-alternative", required: [], forbidden: ["valuation_range"] },
];

test("scores valid prose, composed UI, and safe alternatives", () => {
  const report = evaluateGenerativeUiRun(cases, [
    { caseId: "simple", text: "A concise definition." },
    {
      caseId: "brief",
      surface: {
        version: 1,
        component: {
          kind: "research_brief",
          title: "Investment case",
          thesis: "Valuation is attractive if the next two catalysts arrive on schedule.",
          blocks: [
            { kind: "valuation_range", title: "Scenario valuation", unit: "HKD/share", current: 90, scenarios: [{ label: "Bear", low: 60, high: 75 }, { label: "Base", low: 95, high: 110 }] },
            { kind: "catalyst_calendar", title: "Catalysts", events: [{ date: "Q1", title: "Launch", impact: "positive", confidence: "high" }, { date: "Q2", title: "Results", impact: "mixed", confidence: "medium" }] },
          ],
        },
      },
    },
    { caseId: "unsafe", text: "There is insufficient evidence for a valuation range." },
  ]);

  assert.equal(report.score, 100);
  assert.equal(report.passed, 3);
});

test("rejects unnecessary UI, interaction and empty prose; permits adaptive prose", () => {
  const surface = { version: 1, component: { kind: "insight_callout", tone: "neutral", title: "Definition", body: "A definition." } };
  const checks = [
    { id: "simple", prompt: "definition", expected: "prose", required: [], forbidden: [] },
    { id: "adaptive", prompt: "analysis", expected: "adaptive", required: [], forbidden: [] },
    { id: "empty", prompt: "definition", expected: "prose", required: [], forbidden: [] },
    { id: "controls", prompt: "analysis", expected: "adaptive", required: [], forbidden: [] },
  ];
  const report = evaluateGenerativeUiRun(checks, [
    { caseId: "simple", surface },
    { caseId: "adaptive", text: "A detailed but natural explanation." },
    { caseId: "empty" },
    { caseId: "controls", surface: { ...surface, presentation: { interaction: "explore" } } },
  ]);
  assert.equal(report.passed, 1);
  assert.equal(report.cases[1].passed, true);
  assert.match(report.cases[2].issues[0], /empty/);
  assert.ok(report.cases[3].issues.some((issue) => issue.includes("unnecessary interaction")));
});

test("reports invalid protocols, forbidden components, duplicates, and missing cases", () => {
  const report = evaluateGenerativeUiRun(cases, [
    { caseId: "simple", surface: { version: 2 } },
    { caseId: "unsafe", surface: { version: 1, component: { kind: "valuation_range", title: "Made up", unit: "RMB", scenarios: [{ label: "A", low: 1, high: 2 }, { label: "B", low: 2, high: 3 }] } } },
  ]);

  assert.equal(report.passed, 0);
  assert.match(report.cases[0].issues[0], /invalid protocol/);
  assert.match(report.cases[1].issues[0], /missing result/);
  assert.ok(report.cases[2].issues.some((issue) => issue.includes("forbidden")));
});

const trend = { version: 1, component: { kind: "financial_trend", title: "Trend", chart: "bar", categories: ["A", "B"], series: [{ name: "Revenue", values: [20, 80] }] } };
const segment = { version: 1, component: { kind: "segment_breakdown", title: "Mix", segments: [{ name: "A", value: 20 }, { name: "B", value: 80 }] } };
const choice = { id: "choice", prompt: "composition", expected: "leaf", required: [], forbidden: [], maxVisuals: 1, acceptedPresentations: [{ mode: "leaf", kinds: ["segment_breakdown", "financial_trend"] }] };

test("accepts multiple suitable encodings without a component frequency target", () => {
  for (const surface of [trend, segment]) assert.equal(evaluateGenerativeUiRun([choice], [{ caseId: "choice", surface }]).passed, 1);
  const report = evaluateGenerativeUiRun([choice, { ...choice, id: "again" }], [{ caseId: "choice", surface: trend }, { caseId: "again", surface: trend }]);
  assert.equal(report.passed, 2);
});

test("separately detects missed visuals, wrong encoding and split-call overuse", () => {
  const missed = evaluateGenerativeUiRun([choice], [{ caseId: "choice", text: "A=20 B=80" }]);
  assert.match(missed.cases[0].issues[0], /missed visual/);
  const wrong = evaluateGenerativeUiRun([choice], [{ caseId: "choice", surface: { version: 1, component: { kind: "insight_callout", title: "Mix", body: "A=20 B=80", tone: "neutral" } } }]);
  assert.match(wrong.cases[0].issues[0], /wrong relationship/);
  const excessive = evaluateGenerativeUiRun([choice], [{ caseId: "choice", surfaces: [trend, segment] }]);
  assert.ok(excessive.cases[0].issues.some((issue) => issue.includes("visual overuse")));
});

test("checks every surface, including later invalid blocks and brief child budget", () => {
  const invalid = evaluateGenerativeUiRun([choice], [{ caseId: "choice", surfaces: [trend, { version: 3 }] }]);
  assert.match(invalid.cases[0].issues[0], /invalid protocol/);
  const brief = { version: 1, component: { kind: "research_brief", title: "Brief", thesis: "Mixed", blocks: [trend.component, segment.component] } };
  const report = evaluateGenerativeUiRun([{ ...choice, expected: "brief", acceptedPresentations: [{ mode: "brief" }] }], [{ caseId: "choice", surface: brief }]);
  assert.ok(report.cases[0].issues.some((issue) => issue.includes("visual overuse")));
});

test("detects built-in carousel interaction even when presentation says static", () => {
  const gallery = { version: 1, presentation: { interaction: "static" }, component: { kind: "image_gallery", title: "Photos", layout: "carousel", images: [{ src: "/tmp/a.png", title: "A" }, { src: "/tmp/b.png", title: "B" }] } };
  const galleryCase = { ...choice, acceptedPresentations: [{ mode: "leaf", kinds: ["image_gallery"] }] };
  const report = evaluateGenerativeUiRun([galleryCase], [{ caseId: "choice", surface: gallery }]);
  assert.ok(report.cases[0].issues.some((issue) => issue.includes("unnecessary interaction")), report.cases[0].issues.join(", "));
  assert.equal(evaluateGenerativeUiRun([{ ...galleryCase, allowInteraction: true }], [{ caseId: "choice", surface: gallery }]).passed, 1);
});

test("rejects duplicate case results, ambiguous inputs and unfinished responses", () => {
  assert.match(evaluateGenerativeUiRun([choice], [{ caseId: "choice", surface: trend }, { caseId: "choice", surface: segment }]).cases[0].issues[0], /duplicate result/);
  assert.match(evaluateGenerativeUiRun([choice], [{ caseId: "choice", surface: trend, surfaces: [segment] }]).cases[0].issues[0], /not both/);
  assert.match(evaluateGenerativeUiRun([choice], [{ caseId: "choice", surface: trend, completion: "pending" }]).cases[0].issues[0], /incomplete response/);
});
