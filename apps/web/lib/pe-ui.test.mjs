import assert from "node:assert/strict";
import test from "node:test";

import { parsePeUiBlock } from "./pe-ui.ts";

test("parses a valid chart block", () => {
  const result = parsePeUiBlock(JSON.stringify({
    version: 1,
    type: "chart",
    chart: "line",
    title: "收入趋势",
    categories: ["2024", "2025"],
    series: [{ name: "收入", values: [10, 12], unit: "亿元" }],
  }));
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.block.type, "chart");
});

test("rejects mismatched chart dimensions", () => {
  const result = parsePeUiBlock(JSON.stringify({
    version: 1,
    type: "chart",
    chart: "bar",
    title: "收入",
    categories: ["2024", "2025"],
    series: [{ name: "收入", values: [10] }],
  }));
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error, /match categories length/);
});

test("rejects arbitrary UI and unsafe source protocols", () => {
  assert.equal(parsePeUiBlock('{"version":1,"type":"html","html":"<script>"}').success, false);
  const source = parsePeUiBlock(JSON.stringify({
    version: 1,
    type: "source-list",
    sources: [{ title: "bad", url: "javascript:alert(1)" }],
  }));
  assert.equal(source.success, false);
});
