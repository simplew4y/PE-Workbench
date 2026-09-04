# Component Selection

Choose the smallest surface that materially improves comprehension.

```text
Would prose or a small Markdown table communicate this information equally well?
├── yes → prose / Markdown, regardless of question complexity
└── no → select a visual for this specific information
    ├── identifiable company + 3 metrics → company_overview
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
