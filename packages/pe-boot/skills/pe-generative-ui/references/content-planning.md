# Content Planning

Plan silently before writing or calling `pe_render_ui`. Do not expose this checklist as boilerplate.

## Research frame

Extract only the dimensions supported by evidence:

1. **Decision** — what judgment or choice is the user trying to make?
2. **Thesis** — the shortest defensible answer to that decision.
3. **Evidence** — which verified facts directly support the thesis?
4. **Counterevidence** — what verified fact weakens or qualifies it?
5. **Drivers** — which signed or directional factors explain the change?
6. **Risks and catalysts** — what could materially change the judgment?
7. **Data gaps** — what cannot be concluded from the supplied material?

## Choose answer depth

| User intent | Composition |
| --- | --- |
| Definition, lookup, or one fact | concise prose; usually no UI |
| Reasoning, diagnosis, investment view, or several subquestions | prose by default; complexity does not mandate UI |
| Exact comparison with a small dataset | a Markdown table unless native UI adds a concrete benefit |
| Pattern, structure, or positioning difficult to explain in words | a local visual + non-duplicative interpretation |
| Explicit request for a visual brief or dashboard | `research_brief` only if 2–4 complementary visuals help |

Before each visual, ask: what will become easier to understand? If the only answer is "looks richer", omit it. Separately ask whether selection or navigation is necessary; default to a complete static view. Do not hide core information behind interaction.

## Build a research brief

Use this order when supported:

```text
thesis
  ├── current state      → kpi_strip / company_overview
  ├── change or drivers  → financial_trend / waterfall_chart / segment_breakdown
  └── implication        → risk_matrix / insight_callout / research_timeline
```

Do not fill every slot mechanically. Two strong blocks are better than four weak ones.

## Diversity comes from semantics

Vary the analytical job, not merely color or layout:

- magnitude → KPI strip;
- direction → trend;
- contribution → waterfall;
- concentration → treemap;
- prioritization → risk matrix;
- exact lookup → comparison table;
- causality or dependency → relationship map;
- sequence → timeline.
- valuation asymmetry → valuation range;
- relative positioning → peer quadrant;
- future checkpoints → catalyst calendar.

If two candidate blocks encode the same evidence with the same analytical job, keep only the stronger one.

## Evidence boundary

- Reported facts and calculations may be rendered once verified.
- Interpretations belong in the thesis or nearby prose.
- A causal claim, risk score, or waterfall driver needs direct support; otherwise label it as a hypothesis in prose and do not encode it as settled UI data.
- Make missing periods, incompatible units, and scope differences explicit rather than smoothing them over.
