import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MetricComparison, InsightCallout } = await jiti.import("./research-surfaces.tsx");
const { getSurfaceAppearance } = await jiti.import("../../lib/generative-ui/appearance.ts");

function assertUniqueKeys(node) {
  if (Array.isArray(node)) {
    const keys = node.filter(React.isValidElement).map(child => child.key).filter(key => key !== null);
    assert.equal(new Set(keys).size, keys.length, "Sibling keys must be unique: " + keys.join(", "));
    node.forEach(assertUniqueKeys);
  } else if (React.isValidElement(node)) {
    assertUniqueKeys(node.props.children);
  }
}
test("comparison accepts repeated headers and rows without losing cell alignment on updates", () => {
  const component = { kind: "metric_comparison", title: "预测调整", columns: ["2025E", "差异", "2026E", "差异"], rows: [{ label: "净利润", values: [100, "-5%", 120, "+14%"], highlight: 3 }, { label: "净利润", values: [null, "-6%", 130, "+13%"] }] };
  for (const current of [component, {...component,columns:["2025E新预测","差异","2026E新预测","差异"]}, {...component,columns:component.columns.slice(0,2),rows:component.rows.map(row=>({...row,values:row.values.slice(0,2),highlight:1}))}]) {
    const appearance = getSurfaceAppearance({version:1,component:current});
    const element = MetricComparison({component:current,appearance});
    assertUniqueKeys(element);
    const html = renderToStaticMarkup(element);
    assert.equal((html.match(/>差异<\/th>/g) ?? []).length, current.columns.filter(column=>column==="差异").length);
    assert.match(html, /-5%/);
    assert.match(html, /—/);
  }
});
test("callouts allow identical evidence text without duplicate keys", () => {
  const component = {kind:"insight_callout",title:"核验",tone:"watch",body:"两个依据",evidence:["差异","差异"]};
  assertUniqueKeys(InsightCallout({component,appearance:getSurfaceAppearance({version:1,component})}));
});

