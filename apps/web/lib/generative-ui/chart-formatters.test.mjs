import assert from "node:assert/strict";
import test from "node:test";
import { chartDatumName, escapeHtml, formatPeerTooltip, formatRiskTooltip, formatTreemapLabel, formatTreemapTooltip } from "./chart-formatters.ts";

test("chart formatters tolerate incomplete ECharts callback parameters", () => {
  assert.equal(escapeHtml(undefined), "");
  assert.match(formatTreemapTooltip(undefined), /业务分部/);
  assert.match(formatTreemapTooltip({ data: {} }), /—/);
  assert.match(formatTreemapLabel({}), /业务分部/);
  assert.match(formatRiskTooltip({ data: {} }), /风险项/);
  assert.equal(chartDatumName(undefined), undefined);
  assert.equal(chartDatumName({ data: { name: "汽车业务" } }), "汽车业务");
});

test("chart tooltip formatters escape model-provided text", () => {
  const tooltip = formatTreemapTooltip({ data: { name: "<script>x</script>", value: 10, unit: "<&", change: "'up'" } });
  const risk = formatRiskTooltip({ data: { name: "<img>", value: [5, 4], description: "a&b" } });

  assert.doesNotMatch(tooltip, /<script>/);
  assert.match(tooltip, /&lt;script&gt;/);
  assert.match(risk, /&lt;img&gt;/);
  assert.match(risk, /a&amp;b/);
  assert.match(formatPeerTooltip({ data: { name: "<peer>", value: [3, 15] } }), /&lt;peer&gt;/);
});
