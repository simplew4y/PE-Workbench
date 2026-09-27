import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { GenerativeSurface } = await jiti.import("./GenerativeSurface.tsx");
const risk = { kind: "risk_matrix", title: "Risk", risks: [{name:"Price",likelihood:4,impact:5,description:"Price evidence"},{name:"Delivery",likelihood:2,impact:3,description:"Delivery evidence"}] };
const segment = {kind:"segment_breakdown",title:"Mix",segments:[{name:"A",value:80,unit:"%"},{name:"B",value:20,unit:"%"}]};
const valuation = {kind:"valuation_range",title:"Valuation",unit:"RMB",scenarios:[{label:"Bear",low:50,high:60,rationale:"Bear assumption"},{label:"Base",low:70,high:90,rationale:"Base assumption"}]};
const peer = {kind:"peer_quadrant",title:"Peers",xAxis:{label:"Growth"},yAxis:{label:"ROE"},peers:[{name:"A",x:1,y:2,description:"Peer A"},{name:"B",x:2,y:3,description:"Peer B"},{name:"C",x:3,y:4,description:"Peer C"}]};
function render(component, presentation) { return renderToStaticMarkup(React.createElement(GenerativeSurface,{input:{version:1,component,presentation}})); }

test("static charts expose supporting details without selector buttons", () => {
  for (const [component, evidence] of [[risk,"Delivery evidence"],[segment,"20"],[valuation,"Bear assumption"],[peer,"Peer C"]]) {
    const html = render(component);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, new RegExp(evidence));
    assert.match(html, /data-pe-treatment="minimal"/);
    assert.doesNotMatch(html, />ANALYSIS</);
  }
});
test("explore intent retains selectors", () => {
  for (const component of [risk,segment,valuation,peer]) assert.match(render(component,{interaction:"explore"}), /<button/);
});
test("brief children inherit presentation and no decorative brief badge", () => {
  const html = render({kind:"research_brief",title:"Brief",thesis:"Thesis",blocks:[risk,segment]}, {theme:"cool",treatment:"soft"});
  assert.equal((html.match(/data-pe-theme="cool"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /RESEARCH BRIEF/);
});
