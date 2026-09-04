import { readFileSync } from "node:fs";
import process from "node:process";
import { auditSelectionSession, summarizeSelectionTurns } from "../lib/generative-ui/selection-audit.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

try {
  const session = argument("--session");
  if (!session) throw new Error("Usage: node --experimental-strip-types scripts/audit-generative-ui.mjs --session <file.jsonl> [--leaf <entryId>] [--include-content]");
  const turns = auditSelectionSession(readFileSync(session, "utf8"), argument("--leaf"));
  const report = summarizeSelectionTurns(turns);
  if (process.argv.includes("--include-content")) {
    console.error("Includes private prompt/answer/UI data. Keep this output local; thinking and tool-result bodies are excluded.");
    console.log(JSON.stringify({ ...report, content: turns.map((turn) => ({ turnId: turn.turnId, prompt: turn.prompt, text: turn.text, surfaces: turn.calls.filter((call) => call.status === "success").map((call) => call.input) })) }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Audit failed");
  process.exitCode = 2;
}
