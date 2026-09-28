import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { getTurnFrameworkFailure, getTurnFrameworkProposal, getTurnFrameworkReport } = await jiti.import("./framework-proposal.ts");
const { frameworkFixture } = await jiti.import("../../../packages/pe-boot/test/fixtures/framework.ts");
const { renderInvestmentFrameworkMarkdown } = await jiti.import("../../../packages/pe-boot/src/research/report.ts");

test("confirmation comes only from successful proposal results, retaining exact draft revision", () => {
  const call = { type: "toolCall", toolName: "pe_investment_framework", toolCallId: "call", input: { operation: "propose" } };
  const details = { kind: "pe_framework_draft", datasetId: "project", draft: { id: "draft", revision: 3 } };
  const result = { role: "toolResult", toolCallId: "call", details, content: [] };
  assert.equal(getTurnFrameworkProposal([{ type: "text", text: "投资框架已生成" }], new Map()), null);
  assert.equal(getTurnFrameworkProposal([call], new Map()), null);
  assert.equal(getTurnFrameworkProposal([call], new Map([["call", { ...result, isError: true }]])), null);
  assert.deepEqual(getTurnFrameworkProposal([call], new Map([["call", result]])), { datasetId: "project", draftId: "draft", revision: 3, toolCallId: "call" });
  assert.deepEqual(getTurnFrameworkProposal([call], new Map([["call", { ...result, details: undefined, content: [{ type: "text", text: JSON.stringify(details) }] }]])), { datasetId: "project", draftId: "draft", revision: 3, toolCallId: "call" });
  assert.equal(getTurnFrameworkProposal([{ ...call, input: { operation: "read" } }], new Map([["call", result]])), null);
});

test("chat displays the saved seven-section document even if the model supplies a different summary", () => {
  const call = { type: "toolCall", toolName: "pe_investment_framework", toolCallId: "call", input: { operation: "propose" } };
  const document = frameworkFixture();
  const details = { kind: "pe_framework_draft", datasetId: "project", draft: { id: "draft", revision: 1, content: document }, rendered_report: "incorrect summary" };
  const result = { role: "toolResult", toolCallId: "call", details, content: [] };
  const expected = renderInvestmentFrameworkMarkdown(document);
  assert.equal(getTurnFrameworkReport([call, { type: "text", text: "只生成了三个条目" }], new Map([["call", result]])), expected);
  assert.equal(getTurnFrameworkReport([call], new Map([["call", { ...result, details: undefined, content: [{ type: "text", text: JSON.stringify(details) }] }]])), expected);
  assert.equal(getTurnFrameworkReport([call], new Map([["call", { ...result, isError: true }]])), null);
  assert.equal(getTurnFrameworkReport([call], new Map([["call", { ...result, details: { ...details, draft: { ...details.draft, content: { title: "旧稿", items: [] } } } }]])), null);
  assert.equal(getTurnFrameworkReport([call], new Map([["call", { ...result, details: { ...details, draft: { ...details.draft, content: { schemaVersion: 2 } } } }]])), null);
});

test("terminal framework timeout exposes its user message without treating raw tool errors as final output", () => {
  const call = (toolCallId) => ({ type: "toolCall", toolName: "pe_investment_framework", toolCallId, input: { operation: "propose" } });
  const failure = { role: "toolResult", toolCallId: "failure", isError: true, content: [], details: { kind: "pe_framework_error", error: "草案尚未保存，请稍后重试。", technicalError: "private technical details" } };
  const results = new Map([["failure", failure]]);
  assert.deepEqual(getTurnFrameworkFailure([call("failure")], results), { toolCallId: "failure", error: failure.details.error });
  assert.deepEqual(getTurnFrameworkFailure([call("failure")], new Map([["failure", { ...failure, isError: false }]])), { toolCallId: "failure", error: failure.details.error });
  assert.equal(getTurnFrameworkFailure([call("failure")], new Map([["failure", { ...failure, details: undefined }]])), null);
  results.set("success", { role: "toolResult", toolCallId: "success", isError: false, content: [] });
  assert.equal(getTurnFrameworkFailure([call("failure"), call("success")], results), null);
});
