import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { samples } from "./extended-fixtures.mjs";
import { parseGenerativeUiSurface } from "./parser.ts";
import {
  extendedSchemas,
  parseExtendedComponent,
  calculateScenario,
} from "./extended-contract.ts";
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { GenerativeSurface } = await jiti.import(
  "../../components/generative-ui/GenerativeSurface.tsx",
);
for (const component of samples)
  test(component.kind + " validates and renders through registry", () => {
    const input = {
      version: 1,
      presentation: { treatment: "glass", theme: "orchid" },
      component,
    };
    const result = parseGenerativeUiSurface(input);
    assert.equal(result.success, true, result.error);
    const html = renderToStaticMarkup(
      React.createElement(GenerativeSurface, { input }),
    );
    assert.match(html, new RegExp(component.title));
    assert.doesNotMatch(html, /界面数据无效/);
  });
test("all new components can appear in a brief", () => {
  for (const component of samples)
    assert.equal(
      parseGenerativeUiSurface({
        version: 1,
        component: {
          kind: "research_brief",
          title: "Brief",
          thesis: "Evidence",
          blocks: [component, samples[3]],
        },
      }).success,
      true,
    );
});
test("rejects unsafe URLs and executable fields", () => {
  for (const src of [
    "javascript:alert(1)",
    "data:image/svg+xml,foo",
    "//evil/x.png",
    "/tmp/x.svg",
  ])
    assert.throws(() =>
      parseExtendedComponent({ ...samples[0], images: [{ title: "x", src }] }),
    );
  assert.throws(() =>
    parseExtendedComponent({ ...samples[4], formatter: "alert(1)" }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[1],
      entities: [{ ...samples[1].entities[0], url: "javascript:alert(1)" }],
    }),
  );
});
test("rejects malformed numerical and graph data", () => {
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[2],
      places: [{ ...samples[2].places[0], latitude: 91 }],
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[3],
      inputs: samples[3].inputs.map((i) => ({ ...i, step: 0 })),
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[4],
      links: [
        ...samples[4].links,
        { source: "利润", target: "收入", value: 1 },
      ],
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[4],
      links: [{ source: "missing", target: "收入", value: 1 }],
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[5],
      series: [{ name: "x", values: [1, 2] }],
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[5],
      series: [{ name: "x", values: [1, 2, 101] }],
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[6],
      candles: samples[6].candles.map((c) => ({ ...c, high: 1 })),
    }),
  );
  assert.throws(() =>
    parseExtendedComponent({
      ...samples[2],
      places: [{ ...samples[2].places[0], latitude: NaN }],
    }),
  );
});
test("calculator has deterministic arithmetic and safe divide by zero", () => {
  assert.equal(calculateScenario("product", [6, 12]), 72);
  assert.equal(calculateScenario("sum", [6, 12]), 18);
  assert.equal(calculateScenario("ratio", [6, 12]), 0.5);
  assert.equal(calculateScenario("ratio", [6, 0]), null);
  assert.ok(Math.abs(calculateScenario("compound", [100, 10, 2]) - 121) < 1e-9);
});
test("media uses authorized raw file route and external loads are opt-in", () => {
  const render = (component) =>
    renderToStaticMarkup(
      React.createElement(GenerativeSurface, {
        input: { version: 1, component },
      }),
    );
  assert.match(render(samples[0]), /api\/files\/tmp\/chart.png\?type=read/);
  const html = render({
    ...samples[0],
    images: [{ title: "remote", src: "https://example.com/x.png" }],
  });
  assert.match(html, /加载外部图片/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(render(samples[2]), /<iframe/);
});
test("extended schema contains seven bounded tool-callable shapes", () => {
  assert.equal(extendedSchemas.length, 7);
  assert.ok(extendedSchemas.every((s) => s.additionalProperties === false));
});
test("frontend and agent schema and parser stay aligned", async () => {
  const core = await jiti.import(
    "../../../PE-Workbench-pi/packages/pe-boot/src/tools/extended-ui-contract.ts",
  );
  assert.deepEqual(core.extendedSchemas, extendedSchemas);
  for (const sample of samples)
    assert.deepEqual(
      core.parseExtendedComponent(sample),
      parseExtendedComponent(sample),
    );
  const malicious = JSON.parse(
    '{"kind":"sankey_chart","title":"x","unit":"x","nodes":["a","b"],"links":[{"source":"a","target":"b","value":1}],"__proto__":{}}',
  );
  assert.throws(() => parseExtendedComponent(malicious));
  assert.throws(() => core.parseExtendedComponent(malicious));
});
