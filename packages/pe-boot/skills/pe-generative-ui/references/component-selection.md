# Component Selection

Choose the smallest surface that materially improves comprehension.

```text
Would prose or a small Markdown table communicate this information equally well?
├── yes → prose / Markdown, regardless of question complexity
└── no → select a visual for this specific information
    ├── explicitly useful identity snapshot with verified details → company_overview / entity_cards
    ├── numeric shape/change matters → financial_trend
    ├── exact multi-dimensional lookup matters → metric_comparison
    ├── order/time matters → research_timeline
    ├── relationships matter → relationship_map
    ├── headline metrics need fast scanning → kpi_strip
    ├── signed drivers form a bridge → waterfall_chart
    ├── likelihood × impact matters → risk_matrix
    ├── composition/concentration matters → segment_breakdown
    ├── valuation scenarios share one basis → valuation_range
    ├── two comparable peer dimensions matter → peer_quadrant
    ├── future dated checkpoints matter → catalyst_calendar
    ├── explicitly requested visual brief + complementary visuals → research_brief
    ├── one decisive signal deserves emphasis → insight_callout
    └── user asked for a source set → source_collection
```

These are capabilities, not triggers. Do not convert every entity, metric, or risk into UI. A multi-angle answer need not contain a brief or any UI. Only an explicitly requested visual brief may use `research_brief` with 2–4 blocks. Blocks must have different jobs, for example:

- company overview + financial trend;
- peer comparison + risk callout;
- relationship map + transaction timeline.
- KPI strip + trend + risk matrix.
- segment breakdown + waterfall + insight callout.

Do not pair a table and chart containing the same complete dataset.

Default to static presentation. Enable explore only when navigation or selection helps a real task, not because a library offers controls. Keep one theme across the answer, with content-driven layout and no arbitrary offsets.

## Compare candidates before committing

Compare prose/small Markdown table, the best eligible visual, and a second visual only when genuinely plausible. Prefer comprehension gain, evidence fit, low reading effort and low interaction cost, in that order. A tie goes to the simpler presentation. Do not expose internal deliberation or generate numeric selection scores. A component's data prerequisites are necessary, not a reason to use it.

Additional relationships in the complete catalog:

| Relationship | Candidates | Boundary |
| --- | --- | --- |
| Appearance | image_gallery | Real accessible images; grid for comparison, carousel for browsing |
| Entity identity/details | entity_cards, company_overview | A company/product name alone does not justify a card |
| Geographic distribution | place_map | Verified coordinates; no implicit geocoding |
| Editable assumptions | scenario_calculator | Bounded inputs, declared operation and units |
| Measured transfers | sankey_chart | Same-unit nonnegative acyclic flows; disclose omissions |
| Multi-dimensional profile | radar_chart | Explicit normalization, sourced dimensions, no invented scores |
| Trading range over time | candlestick_chart | Actual OHLC, not annual financial metrics |

## Paired boundary examples

These are synthetic examples, not evidence for a user's research. The changed requirement or relationship, not the subject/company keyword, changes the presentation.

| A: simpler / inappropriate visual | B: justified visual | Why B is different |
| --- | --- | --- |
| Revenue 100→103: state +3% in prose | Complete quarterly data for two diverging businesses: trend | Trajectory, not two-number lookup |
| Three exact annual figures: small Markdown table | Dense 8-company multi-metric lookup: comparison table | Repeated cross-dimensional lookup |
| Why profit fell, qualitative evidence only: prose | Start 100; price -20, volume +10, cost -5; end 85: waterfall | Reconciled signed contributions |
| Ownership edges without amounts: relationship diagram | Verified transfers from sources through channels: Sankey | Flow magnitude, not merely topology |
| Two segment figures: sentence/table | Eight same-scope segments: composition plot | Concentration visible by relative area |
| List three offices, no coordinates: prose | Verified global sites; geographic clusters matter: map | Spatial relationship supported by coordinates |
| Three real product photos to compare: image grid | Ten screenshots to browse sequentially: carousel | Simultaneous comparison vs navigation |
| Product photos unavailable: explain limitation | Supplied actual photos: gallery | No invented URLs or claims to see unseen pixels |
| Profit 100 × PE 20: explain 2000 and units | User wants to vary profit and PE: calculator | Interaction changes an outcome |
| One closing price: prose | Actual 20-day OHLC; compare volatility intervals: candlestick | Open/high/low/close structure |
| One date: sentence | Six dated acquisition milestones: timeline | Order carries meaning |
| General future risks with no dates: prose | Three announced decision deadlines: calendar | Dated future checkpoints |
| Two risks with no calibrated scores: prose | Documented likelihood/impact method and six risks: matrix | Defensible prioritization |
| Three qualitative strengths: prose | Comparable measured normalized dimensions: radar | Supported multidimensional shape |
| Company name plus one fact: sentence | Explicit identity snapshot with verified metrics: company overview | Snapshot is the task, not an automatic card |
| Many investment subquestions: natural analysis, optional local visual | Explicit visual brief with independent evidence views: brief | Explicit composition request and complementary jobs |

## Final presentation check

- Does each visual reveal a relationship harder to see in prose/a small table?
- Are units, periods, denominators, source and uncertainty explicit and supported?
- Check all tool calls together: no KPI strip plus a second table restating it, or callout repeating the conclusion.
- Keep conclusions visible without hover/click. Interaction is task-driven.
- Keep exact green `#pe-source?evidence_id=...` citations with material claims. Cards do not replace them.
- Do not rotate components, enforce equal usage quotas or swap the best chart for novelty. Style comes last and is independent.

Offline regression cases are in `evaluation-cases.json`. Multiple accepted presentations are intentional. The evaluator checks structural selection, not truth, reasoning quality, actual image readability or visual aesthetics.
