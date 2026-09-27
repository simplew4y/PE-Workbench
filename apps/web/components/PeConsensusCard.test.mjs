import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { PeConsensusCard } = await jiti.import("./PeConsensusCard.tsx");
const { PeConsensusPanel } = await jiti.import("./PeConsensusPanel.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function card() {
  return {
    card_id: "one", item_key: "revenue", question: "Revenue?", title: "Revenue outlook",
    period: "2026FY", measure: "level", card_type: "divergence", issuer_count: 2, coverage_total: 3,
    as_of_date: "2026-09-10", priority: 1,
    stats: { median_display: "110 bn", iqr_display: "10 bn", mad_display: "10 bn",
      sample: { included_count: 2, stance_ratios: { bullish: 0.5, bearish: 0.5, neutral: 0 },
        not_mentioned: [{ issuer_key: "c", issuer_name: "Missing broker" }] } },
    bull: [{ claim_id: "a", issuer_name: "Broker A", value_display: "120 bn", reason: "Order growth" }],
    bear: [{ claim_id: "b", issuer_name: "Broker B", value_display: "100 bn", reason: "Price pressure" }],
    stance_counts: { bullish: 1, bearish: 1, neutral: 0 }, recent_changes: {},
    narrative: { consensus_line: "Project sample only", root_cause: "Different volume assumptions",
      financial_impact: "Output spread", verification_evidence: "Check orders" },
    company_view: { value_display: "115 bn", reason: "Company guidance" },
    sources: [{ claim_id: "a", doc_id: "report", issuer_name: "Broker A", as_of_date: "2026-09-01",
      claim_text: "Revenue may grow", evidence_ids: ["page:missing", "page:valid"],
      source_links: ["#pe-source?evidence_id=page%3Avalid"], citations: ["[Report p.3](#pe-source?evidence_id=page%3Avalid)"],
      unresolved_evidence_ids: ["page:missing"], quotes: [{ quote: "Revenue is expected to rise", evidence_id: "page:valid" }] }],
  };
}

function render(component, props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));
}

test("renders real SDK period, statistics, sides, source text and resolved preview controls", () => {
  const html = render(PeConsensusCard, { card: card(), cwd: "/project" });
  for (const text of ["2026FY", "110 bn", "Interquartile range", "Median absolute deviation", "50%",
    "Missing broker", "Order growth", "Price pressure", "Different volume assumptions", "Check orders",
    "Revenue is expected to rise", "Report p.3", "cannot be resolved"]) assert.ok(html.includes(text), text);
  assert.equal((html.match(/data-pe-source-citation="true"/g) || []).length, 1);
  assert.ok(!html.includes("#pe-source?"));
});

test("does not truncate at four sources or create buttons for unresolved sources", () => {
  const data = card();
  data.sources = Array.from({ length: 5 }, (_, index) => ({ ...data.sources[0], claim_id: String(index),
    issuer_name: "Issuer " + index, source_links: [], unresolved_evidence_ids: ["page:missing", "page:valid"] }));
  const html = render(PeConsensusCard, { card: data, cwd: "/project" });
  assert.ok(html.includes("Issuer 4"));
  assert.ok(!html.includes("data-pe-source-citation"));
});

test("escapes model prose, tolerates nonnumeric optional stats and hides without a project", () => {
  const data = card();
  data.title = "<script>alert(1)</script>";
  data.stats = { median_display: { invalid: "not text" } };
  const html = render(PeConsensusCard, { card: data, cwd: "/project" });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(render(PeConsensusPanel, { project: null }), "");
});
