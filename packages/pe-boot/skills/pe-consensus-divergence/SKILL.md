---
name: pe-consensus-divergence
description: "Use when analyzing sell-side research consensus or divergence. Extract atomic claims with evidence, then build deterministic broker-voted cards."
---

# PE Consensus and Divergence

Use this skill for point-in-time analysis of multiple sell-side reports and models.

## Hard rules

- Use the current project ingest outputs; do not run a second PDF parser or modify originals.
- Establish `as_of`, eligible brokers, observation window, metric, period, unit, currency, and accounting basis before comparing values.
- Count independent brokers, not files. Deduplicate report versions and keep historical versions separate.
- `not mentioned` is not opposition.
- Sell-side dispersion is not a mispricing claim. Use `mispricing_candidate` only when an external benchmark is explicitly present.
- Every material claim needs a PDF page/block or Excel sheet/cell evidence reference.
- Keep explicit, derived, and inferred claims distinct. Never present an inference as a broker quote.

## Workflow

1. Inspect the project document catalog and identify the company, broker, report date, version, and file type.
2. Use `pe_pdf_search`/`pe_pdf_read` for PDF evidence and `pe_workbook_inspect`/`pe_excel_range`/`pe_formula_trace` for Excel evidence.
3. Build the common checklist and add company/industry-specific candidate questions only when repeated across at least two brokers and supported by evidence.
4. Extract atomic claims. One claim expresses one judgment, metric, period, driver, condition, or risk.
5. Persist claims only with a valid document in the current dataset and at least one evidence reference.
6. Normalize metric, fiscal period, actual/estimate state, basis, units, currency, and corporate-action adjustment before aggregation.
7. Call `pe_consensus_build` for deterministic latest-per-broker aggregation and numeric summary.
8. Present consensus/divergence cards with included/eligible counts, supporters, opponents, missing brokers, root cause, financial impact, recent changes, and evidence links.
9. If a new checklist question becomes active, mark historical documents for backfill and do not imply that unprocessed documents had no opinion.

## Card language

Use “样本内共识” for the included broker cohort. Use “卖方分歧” for cross-broker disagreement. Use “预测差候选” only when a timely or quality-weighted forecast is compared with a defined benchmark. Use “已实现惊喜” only when actual results are compared with the pre-announcement point-in-time consensus.

## Output requirements

State the as-of time and cohort. Show included, eligible, and excluded counts. For numeric consensus show median, mean, range, and robust dispersion where available. For logical divergence show direction, timing, scale, driver, or valuation type. Link each supporting and opposing claim to its source. State unresolved basis, permission, parsing, stale-data, or corporate-action warnings.
