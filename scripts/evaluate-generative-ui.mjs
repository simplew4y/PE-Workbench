import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { evaluateGenerativeUiRun } from "../lib/generative-ui/evaluator.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJsonOrJsonLines(path) {
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  if (content.startsWith("[")) return JSON.parse(content);
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const resultsPath = argument("--results");
const casesPath = argument(
  "--cases",
  "../PE-Workbench-pi/packages/pe-boot/skills/pe-generative-ui/references/evaluation-cases.json",
);
const threshold = Number(argument("--threshold", "80"));

if (!resultsPath) {
  console.error("Usage: npm run eval:generative-ui -- --results <results.json|jsonl> [--cases <cases.json>] [--threshold 80]");
  process.exit(2);
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error("--threshold must be a number from 0 to 100");
  process.exit(2);
}

const cases = readJsonOrJsonLines(resolve(process.cwd(), casesPath));
const results = readJsonOrJsonLines(resolve(process.cwd(), resultsPath));
const report = evaluateGenerativeUiRun(cases, results);

console.log(`Generative UI evaluation: ${report.score}/100 · ${report.passed}/${report.total} cases passed`);
for (const item of report.cases.filter((entry) => !entry.passed)) {
  console.log(`FAIL ${item.caseId} (${item.score}): ${item.issues.join("; ")}`);
}
process.exitCode = report.score >= threshold && report.passed === report.total ? 0 : 1;
