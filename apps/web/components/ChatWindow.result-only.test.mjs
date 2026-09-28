import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("puts live activity and streamed details in the turn disclosure", () => {
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?label=\{activity\} active=\{isLiveTail\}/);
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?message=\{streamState\.streamingMessage\}[\s\S]*?<\/ProcessDetailsGroup>/);
  assert.doesNotMatch(source, /t\("chat\.thinking"\)/);
});

test("retains final reasoning in the disclosure and the answer outside it", () => {
  assert.match(source, /withAssistantBlocks\(finalAssistant, finalProcessBlocks\)/);
  assert.match(source, /<\/ProcessDetailsGroup>[\s\S]*?if \(displayedAnswer\)/);
  assert.match(source, /renderMessage\(answerIdx, \{[^\n]+messageOverride: displayedAnswer/);
});

test("only saved framework documents request diagram previews in the final answer", () => {
  assert.match(source, /renderMessage\(answerIdx, \{[^\n]+defaultMermaidPreview: Boolean\(frameworkReport\) \}\)/);
  assert.match(source, /defaultMermaidPreview=\{options\.defaultMermaidPreview\}/);
});

test("renders result-bearing generative UI messages outside the hidden tool chain", () => {
  assert.match(source, /const uiProcessIndices = processIndices\.filter/);
  assert.match(source, /for \(const uiProcessIdx of uiProcessIndices\)[\s\S]*?keyPrefix: "generative-ui"/);
});

test("provides a live disclosure before the first saved assistant message", () => {
  assert.match(source, /const finalAssistantIdx = isLiveTail \|\| frameworkReport \? -1/);
  assert.match(source, /if \(isLiveTail \|\| detailIndices\.length > 0 \|\| finalProcessBlocks\.length > 0\)/);
  assert.doesNotMatch(source, /if \(finalAssistantIdx === -1\) \{/);
});

test("keeps explicit command output visible after completion", () => {
  assert.match(source, /messages\[processIdx\]\.role !== "bashExecution"/);
  assert.match(source, /messages\[bashIdx\]\.role === "bashExecution"\) rendered\.push/);
  assert.match(source, /trailingIdx = finalAssistantIdx \+ 1/);
});
