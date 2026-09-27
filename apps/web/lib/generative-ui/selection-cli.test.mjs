import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t, completion = "stop") {
  const directory = mkdtempSync(join(tmpdir(), "pe-selection-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = join(directory, "session.jsonl");
  const cases = join(directory, "cases.json");
  const mapping = join(directory, "mapping.json");
  writeFileSync(session, [
    { type: "session", version: 3, id: "s" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "Private question" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", stopReason: completion, content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "Private answer" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(cases, JSON.stringify([{ id: "simple", prompt: "definition", expected: "prose", required: [], forbidden: [], maxVisuals: 0 }]));
  writeFileSync(mapping, JSON.stringify({ u: "simple" }));
  return { session, cases, mapping };
}

function cli(name, args) {
  return spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", name), ...args], { cwd: root, encoding: "utf8" });
}

test("audit CLI defaults to metadata; content export is explicit and excludes thinking", (t) => {
  const { session } = fixture(t);
  const plain = cli("audit-generative-ui.mjs", ["--session", session]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).turns[0].completion, "complete");
  assert.doesNotMatch(plain.stdout, /Private|SECRET/);
  const content = cli("audit-generative-ui.mjs", ["--session", session, "--include-content"]);
  assert.equal(content.status, 0, content.stderr);
  assert.match(content.stdout, /Private answer/);
  assert.doesNotMatch(content.stdout, /SECRET/);
});

test("evaluation CLI reads actual mapped session results without making model requests", (t) => {
  const { session, mapping, cases } = fixture(t);
  const result = cli("evaluate-generative-ui.mjs", ["--session", session, "--case-map", mapping, "--cases", cases]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /100\/100.*1\/1/);
  assert.doesNotMatch(result.stdout, /Private/);
});

test("evaluation CLI fails an aborted answer instead of crediting its partial text", (t) => {
  const { session, mapping, cases } = fixture(t, "aborted");
  const result = cli("evaluate-generative-ui.mjs", ["--session", session, "--case-map", mapping, "--cases", cases]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /incomplete response/);
});
