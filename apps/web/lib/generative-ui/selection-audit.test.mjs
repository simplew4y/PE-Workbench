import assert from "node:assert/strict";
import test from "node:test";
import { auditSelectionSession, summarizeSelectionTurns } from "./selection-audit.ts";

const surface = { version: 1, component: { kind: "insight_callout", title: "Private title", body: "Private body", tone: "risk" } };
const msg = (id, parentId, message) => ({ type: "message", id, parentId, message });
const user = (id, parentId) => msg(id, parentId, { role: "user", content: "Private prompt" });
const call = (id, parentId, callId = "call-1", input = surface) => msg(id, parentId, { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "SECRET THINKING" }, { type: "toolCall", name: "mcp__pe_render_ui", id: callId, arguments: input }] });
const result = (id, parentId, isError = false, callId = "call-1") => msg(id, parentId, { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text: "PRIVATE TOOL RESULT" }] });
const stop = (id, parentId) => msg(id, parentId, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Private answer [证据](#pe-source?evidence_id=123)" }] });
const jsonl = (...entries) => [{ type: "session", id: "session-1", version: 3 }, ...entries].map((entry) => JSON.stringify(entry)).join("\n");

test("observes actual successful choices without leaking text or thinking in summary", () => {
  const turns = auditSelectionSession(jsonl(user("u", null), call("a", "u"), result("r", "a"), stop("s", "r")));
  assert.equal(turns[0].completion, "complete");
  assert.equal(turns[0].calls[0].status, "success");
  assert.match(turns[0].text, /#pe-source\?evidence_id=123/);
  assert.doesNotMatch(JSON.stringify(turns), /SECRET THINKING|PRIVATE TOOL RESULT/);
  const summary = summarizeSelectionTurns(turns);
  assert.equal(summary.successfulKindCounts.insight_callout, 1);
  assert.doesNotMatch(JSON.stringify(summary), /Private prompt|Private answer|Private title|Private body/);
});

test("failed and pending calls are distinct, retries do not count as two successful renderings", () => {
  const turns = auditSelectionSession(jsonl(user("u", null), call("a", "u"), result("r", "a", true), call("a2", "r", "retry"), result("r2", "a2", false, "retry"), stop("s", "r2")));
  assert.deepEqual(turns[0].calls.map((item) => item.status), ["error", "success"]);
  assert.equal(summarizeSelectionTurns(turns).successfulKindCounts.insight_callout, 1);
  const pending = auditSelectionSession(jsonl(user("u", null), call("a", "u")));
  assert.equal(pending[0].completion, "pending");
  assert.deepEqual(Object.keys(summarizeSelectionTurns(pending).successfulKindCounts), []);
});

test("reads one parent chain, supports an explicit leaf and never mixes branches", () => {
  const log = jsonl(user("u", null), call("a", "u"), result("r", "a"), stop("s", "r"), stop("branch", "u"));
  assert.equal(auditSelectionSession(log)[0].calls.length, 0);
  assert.equal(auditSelectionSession(log, "s")[0].calls.length, 1);
});

test("keeps multiple turns, plain text and tool calls with normalized field names", () => {
  const normalized = msg("a", "u", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", toolName: "ns:pe_render_ui", toolCallId: "call-1", input: surface }] });
  const turns = auditSelectionSession(jsonl(user("u", null), normalized, result("r", "a"), stop("s", "r"), user("u2", "s"), stop("s2", "u2")));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].calls.length, 1);
  assert.equal(turns[1].calls.length, 0);
  assert.equal(turns[1].completion, "complete");
});

test("incomplete/aborted messages are not treated as complete prose answers", () => {
  const aborted = msg("a", "u", { role: "assistant", stopReason: "aborted", content: [] });
  assert.equal(auditSelectionSession(jsonl(user("u", null), aborted))[0].completion, "error");
  assert.equal(auditSelectionSession(jsonl(user("u", null), call("a", "u"), stop("s", "a")))[0].completion, "pending");
});

test("fails closed on malformed logs, duplicate ids and broken/cyclic parent chains", () => {
  assert.throws(() => auditSelectionSession("{bad"), /line 1/);
  assert.throws(() => auditSelectionSession(jsonl(user("u", null)), "absent"), /not found/);
  assert.throws(() => auditSelectionSession(jsonl(user("u", "absent"))), /not found/);
  assert.throws(() => auditSelectionSession(jsonl(user("u", "a"), stop("a", "u"))), /cycle/);
  assert.throws(() => auditSelectionSession(jsonl(user("u", null), user("u", null))), /Duplicate/);
});

test("invalid protocol stays visible in audit and cannot inflate successful kind counts", () => {
  const turns = auditSelectionSession(jsonl(user("u", null), call("a", "u", "call-1", { version: 999 }), result("r", "a"), stop("s", "r")));
  const summary = summarizeSelectionTurns(turns);
  assert.equal(summary.turns[0].choices[0].valid, false);
  assert.deepEqual(Object.keys(summary.successfulKindCounts), []);
});
