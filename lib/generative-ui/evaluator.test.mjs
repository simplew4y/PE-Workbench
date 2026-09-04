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
