import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("shows one generic thinking state instead of streamed reasoning and tool progress", () => {
  assert.match(source, /\{agentRunning && \([\s\S]*?t\("chat\.thinking"\)/);
  assert.doesNotMatch(source, /message=\{streamState\.streamingMessage/);
  assert.doesNotMatch(source, /function phaseLabel/);
});

test("omits process details while retaining the final answer", () => {
  assert.doesNotMatch(source, /ProcessDetailsGroup/);
  assert.match(source, /const finalAnswerMessage = finalSplit\.answerBlocks/);
  assert.match(source, /renderMessage\(finalAssistantIdx, \{ messageOverride: finalAnswerMessage/);
});

test("renders result-bearing generative UI messages outside the hidden tool chain", () => {
  assert.match(source, /const uiProcessIndices = processIndices\.filter/);
  assert.match(source, /for \(const uiProcessIdx of uiProcessIndices\)[\s\S]*?keyPrefix: "generative-ui"/);
});

test("shows only the turn anchor while the live turn is running", () => {
  assert.match(source, /if \(isLiveTail\) \{\s*if \(messages\[userIdx\]\.role === "user"\) rendered\.push\(renderMessage\(userIdx\)\)/);
});
