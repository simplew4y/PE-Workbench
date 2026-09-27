import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerativeUiSurface } from "./parser.ts";

const surface = { version: 1, component: { kind: "insight_callout", title: "Signal", tone: "watch", body: "Evidence is incomplete." } };
test("presentation round trips through strict parser", () => {
  const presentation = { placement: "inline", treatment: "divider", theme: "warm", density: "comfortable", interaction: "static" };
  const parsed = parseGenerativeUiSurface({ ...surface, presentation });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.surface.presentation, presentation);
});
test("presentation rejects arbitrary styling and unsupported modes", () => {
  for (const presentation of [null, "card", { css: "position:fixed" }, { interaction: "auto" }, { theme: "unknown" }, { treatment: "random" }]) {
    assert.equal(parseGenerativeUiSurface({ ...surface, presentation }).success, false);
  }
});
test("history without presentation remains readable", () => {
  assert.equal(parseGenerativeUiSurface(surface).success, true);
});

test("accepts new skins and AI-selected hex palettes but never CSS expressions", () => {
  for (const treatment of ["paper", "glass", "outline", "spotlight"]) {
    const presentation = {treatment,theme:"orchid",palette:{accent:"#663399",series:["#226688","#884422"]}};
    const parsed = parseGenerativeUiSurface({...surface,presentation});
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.surface.presentation, presentation);
  }
  for (const palette of [{accent:"red",series:["#123456","#654321"]},{accent:"#ffffff",series:[]},{accent:"url(https://evil)",series:["#123456","#654321"]},{accent:"#123456",series:["#123456","var(--x)"]}]) {
    assert.equal(parseGenerativeUiSurface({...surface,presentation:{palette}}).success, false);
  }
});
