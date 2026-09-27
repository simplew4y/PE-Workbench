import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getTurnFrameworkProposal } = await createJiti(import.meta.url).import("./framework-proposal.ts");

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
