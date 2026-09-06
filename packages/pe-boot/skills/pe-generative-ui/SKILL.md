---
name: pe-generative-ui
description: Compose evidence-backed PE answers with concise prose and pre-registered native UI surfaces. Use when metrics, trends, value bridges, business mix, risk prioritization, comparisons, timelines, relationships, or a multi-angle research brief materially improves comprehension.
---

# PE Generative UI

Make the answer feel like a deliberate research product, not a decorated transcript.

## Core rule

Text explains. UI compresses structure. Never repeat the same information in both.

Use `pe_render_ui` for a high-value visual surface. Keep the surrounding answer in natural Markdown prose with exact PE citations after material claims. The tool does not replace evidence retrieval or citation requirements.

## Decision sequence

1. State the actual takeaway in one or two natural sentences.
2. Decide whether a visual lets the user understand the evidence faster.
3. Frame the research before choosing UI: thesis, supporting evidence, counterevidence, drivers, risks, catalysts, and data gaps. Use only the dimensions supported by the available evidence.
4. Default to prose for each piece of information. A complex question can still be answered entirely in prose. Use a component only when the pattern, relationship, or navigation would be harder to understand in prose or a small Markdown table. There is no component quota.
5. Call `pe_render_ui` after its data has been verified.
6. Continue with interpretation that is not already visible in the surface.

Before selecting a component, read `references/component-selection.md` for relationship-based candidates and paired boundary examples. Compare prose/small Markdown table against the best eligible visual, and one alternative when genuinely plausible. Evaluate comprehension gain, evidence fit, reading effort and interaction cost. A tie goes to the simpler presentation. Do not output internal deliberation or invented selection scores.

Check the entire answer, including multiple tool calls, for duplication and unnecessary interaction before emitting. Reusing an appropriate component is correct; novelty, equal usage frequency and palette variation are not selection objectives. Choose color/skin after content and structure. The reference examples are illustrative, never evidence for a user's research question.

Use Markdown only for quick factual answers, definitions, short reasoning, code, or when the data is incomplete. Do not create UI merely because the tool exists.

## Component routing

- Use `image_gallery` for real image collections with layout grid/carousel; src is an existing absolute local raster image path or a verified HTTPS image URL. No invented image URLs. External images load only after user click.
- Use `entity_cards` for people, products, companies, or other entities; include name, category, description, facts, optional image/source URL, and grid/carousel layout.
- Use `place_map` for verified places with latitude, longitude and descriptions; never invent coordinates. It renders coordinate distribution, place selectors, and an opt-in OpenStreetMap map. No geocoding is performed.
- Use `scenario_calculator` for explicitly useful editable assumptions. Declare inputs with id/label/min/max/step/value/unit and a resultLabel/resultUnit. Operations: product multiplies all inputs, sum adds all, ratio divides first by second, compound takes exactly principal, annual rate in percent, periods in that order. Use "-" for dimensionless units. Disclose assumptions in description. No code expressions.
- Use `sankey_chart` for measured non-negative flows on a single unit, with unique named nodes and acyclic links; use relationship_map for qualitative relationships.
- Use `radar_chart` for comparable or explicitly normalized dimensions, indicators with name/max, aligned series with name/values; explain normalization and do not invent scores.
- Use `candlestick_chart` for verified chronological OHLC data; each candle has date/open/close/low/high. It supports zoom and an exact data table, not live market feeds.
- All seven components can also be research_brief blocks. Select them only when they help; never replace claim-level green evidence citations. The catalog is not permission to execute arbitrary ECharts options, JS or HTML.

- `company_overview`: an identifiable company with at least three verified attributes or metrics.
- `financial_trend`: comparable numeric values across at least two periods or categories. Prefer line for time, bar for category comparison, pie only for a valid part-to-whole series.
- `metric_comparison`: exact lookup across periods, companies, scenarios, or metrics where a table is more useful than shape.
- `research_timeline`: at least three dated events or ordered stages whose sequence matters.
- `insight_callout`: one decision-relevant conclusion, risk, watch item, or positive signal. Do not use it for a generic summary.
- `source_collection`: a compact set of sources explicitly useful to the user. Claim-level citations in prose remain mandatory.
- `relationship_map`: ownership, business structure, dependency, transaction, or process relationships with verified nodes and edges.
- `kpi_strip`: two to six headline metrics that should be scanned in seconds. Include compact deltas when they add context.
- `waterfall_chart`: signed drivers that bridge a starting position toward an ending position, such as profit or cash movement.
- `risk_matrix`: two or more risks that can be defensibly scored on likelihood and impact from 1 to 5.
- `segment_breakdown`: non-negative business, geography, product, or customer values where relative area makes concentration visible.
- `valuation_range`: two to five downside/base/upside or equivalent ranges using one consistent valuation basis and currency. Assumptions must be sourced or explicitly calculated.
- `peer_quadrant`: at least three peers with comparable numeric X and Y dimensions. Highlight the focal company when applicable.
- `catalyst_calendar`: two or more dated or bounded future catalysts, watch events, or decision checkpoints. Confidence describes evidence certainty, not desired impact.
- `research_brief`: one thesis plus 2–4 complementary leaf components, only for an explicitly requested visual brief, dashboard, or composed research overview. Diagnosis, investment views, and multiple subquestions do not automatically justify it. Never nest a brief.

## Composition rules

- The catalog describes capabilities, not mandatory routing. Having three metrics does not make a company card necessary. A single risk and its evidence normally belong in a short paragraph.
- Distinguish visual structure from interaction: default to `presentation.interaction: static`. Choose `explore` only when the user needs to navigate or select details. Never put essential conclusions only behind buttons, hover, or carousel navigation.
- When UI is justified, actively select its palette instead of repeatedly choosing neutral. Available themes: neutral, cool, warm, ink, lagoon, orchid, forest, ember, berry, cobalt, gold, slate. For original art direction provide `presentation.palette: {accent: "#RRGGBB", series: ["#RRGGBB", "#RRGGBB"]}` with 2–5 distinct series colors. Do not claim invented brand colors are official. Keep one coherent palette per answer. The frontend adjusts contrast, not your intended mood.
- Skins (`treatment`): minimal, divider, soft, card, paper, glass, outline, spotlight. Choose one suited to the information; extra skins do not justify extra UI. Placement and interaction remain independent; default inline/static. Semantic red/green risk signals and green source citations never inherit decorative colors.
- Natural prose can contain a local visual and resume reasoning afterward. Do not force an opening, chart, risk card, and conclusion template. A small Markdown table is often enough.

- Each block must answer a different sub-question. A KPI strip plus a table containing the same KPIs is duplication, not composition.
- Prefer a narrative arc: current state → change/drivers → risk or implication.
- Use one dominant visual and smaller supporting blocks when possible; do not make every block equally loud.
- A `research_brief` is a single tool call. Keep prose outside it short and reserve prose for reasoning the blocks cannot show.
- Do not fabricate risk scores, segment values, or waterfall drivers. If evidence is insufficient, use prose and identify the gap.

## Editorial standards

- Match the user's language.
- Titles should state a pattern or conclusion, such as `利润增长在 2025 年发生反转`, not `数据图表`.
- Preserve reporting period, unit, currency, scope, and whether a value is reported or calculated.
- Do not imply causality when the source supports only correlation.
- Make uncertainty visible with `待复核`, `资料未覆盖`, or an equivalent natural phrase.
- Avoid mechanical numbered sections, excessive bold text, repeated metric paragraphs, and a concluding paragraph that repeats the opening.

## Tool contract

- Pass `version: 1`.
- Use a stable, short `surface_id` when more than one surface may appear.
- Values for `financial_trend` must be numbers, and every series must align with the categories.
- `metric_comparison.rows[].values` must align with the columns.
- All `relationship_map.edges` must reference node IDs present in the same call.
- `waterfall_chart.values` are signed numeric changes and must align with `categories`.
- `risk_matrix` likelihood and impact are integers from 1 to 5.
- `segment_breakdown` values must be non-negative.
- `valuation_range` requires `low <= high` for every scenario and one shared unit.
- `peer_quadrant` requires unique peer names and comparable axis definitions.
- `catalyst_calendar` requires an impact and confidence classification for every event.
- `research_brief.blocks` accepts 2–4 leaf components and cannot contain another brief.
- External URLs in source_collection must be http or https. This rule does NOT apply to PE evidence citations: copy the exact markdown_citation including `#pe-source?evidence_id=...` unchanged. Never add a hostname, rewrite it into a file link, or replace inline evidence with a source collection. Local files must identify existing workspace files.
- Never pass HTML, JavaScript, CSS, executable expressions, or invented paths.

Read the relevant reference before composing a complex surface:

- `references/content-planning.md`
- `references/response-playbook.md`
- `references/financial-visualization.md`
- `references/diagrams.md`
- `references/component-selection.md`

Stop after the question is answered. Do not offer a dashboard, file, or additional artifact unless the user asks for one.
