import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { evaluateGenerativeUiRun } from "../lib/generative-ui/evaluator.ts";
import { auditSelectionSession } from "../lib/generative-ui/selection-audit.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function readJsonOrJsonLines(path) {
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  if (content.startsWith("[")) return JSON.parse(content);
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const resultsPath = argument("--results");
const sessionPath = argument("--session");
const caseMapPath = argument("--case-map");
const casesPath = argument(
  "--cases",
  fileURLToPath(new URL("../../../packages/pe-boot/skills/pe-generative-ui/references/evaluation-cases.json", import.meta.url)),
);
const threshold = Number(argument("--threshold", "80"));

if ((!resultsPath && !(sessionPath && caseMapPath)) || (resultsPath && (sessionPath || caseMapPath))) {
  console.error("Usage: npm run eval:generative-ui -- (--results <results.json|jsonl> | --session <session.jsonl> --case-map <map.json> [--leaf <entryId>]) [--cases <cases.json>] [--threshold 80]");
  process.exit(2);
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error("--threshold must be a number from 0 to 100");
  process.exit(2);
}

const cases = readJsonOrJsonLines(resolve(process.cwd(), casesPath));
let results;
if (sessionPath) {
  // Explicit mapping prevents keyword guesses from masquerading as ground truth.
  const mapping = JSON.parse(readFileSync(resolve(process.cwd(), caseMapPath), "utf8"));
  if (!mapping || Array.isArray(mapping) || typeof mapping !== "object" || Object.values(mapping).some((id) => typeof id !== "string")) throw new Error("case-map must map user turn entry IDs to case IDs");
  const turns = auditSelectionSession(readFileSync(resolve(process.cwd(), sessionPath), "utf8"), argument("--leaf"));
  const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
  results = Object.entries(mapping).map(([turnId, caseId]) => {
    const turn = byId.get(turnId);
    if (!turn) throw new Error(`Mapped turn not found on selected branch: ${turnId}`);
    if (!cases.some((entry) => entry.id === caseId)) throw new Error(`Unknown case ID: ${caseId}`);
    return { caseId, text: turn.text, completion: turn.completion, surfaces: turn.calls.filter((call) => call.status === "success").map((call) => call.input) };
  });
} else {
  results = readJsonOrJsonLines(resolve(process.cwd(), resultsPath));
}
if (results.some((result) => !cases.some((entry) => entry.id === result.caseId))) throw new Error("Results contain unknown case IDs");
const report = evaluateGenerativeUiRun(cases, results);

console.log(`Generative UI evaluation: ${report.score}/100 · ${report.passed}/${report.total} cases passed`);
console.log("Structural selection checks only; factual accuracy, evidence support and visual usefulness still require human review. No equal-frequency target.");
for (const item of report.cases.filter((entry) => !entry.passed)) {
  console.log(`FAIL ${item.caseId} (${item.score}): ${item.issues.join("; ")}`);
}
process.exitCode = report.score >= threshold && report.passed === report.total ? 0 : 1;
