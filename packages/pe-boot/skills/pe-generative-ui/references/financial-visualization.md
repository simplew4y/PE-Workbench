# Financial Visualization

## Select by analytical task

| Question | Component | Form |
| --- | --- | --- |
| How did a metric change over time? | `financial_trend` | line |
| Which category or company is larger? | `financial_trend` | bar |
| What is the composition of one total? | `financial_trend` | pie |
| What are the exact values across many dimensions? | `metric_comparison` | table |
| What is the company at a glance? | `company_overview` | metric card |
| What single signal changes the decision? | `insight_callout` | callout |
| Which signed drivers explain the change? | `waterfall_chart` | waterfall |
| Where is the business concentrated? | `segment_breakdown` | treemap |
| Which risks deserve attention first? | `risk_matrix` | scatter matrix |
| Which headline values should be scanned first? | `kpi_strip` | metric strip |
| What is the downside/base/upside valuation range? | `valuation_range` | scenario bands |
| Where does the company sit versus peers on two dimensions? | `peer_quadrant` | scatter quadrant |
| Which future events could change the thesis? | `catalyst_calendar` | catalyst rail |

## Financial integrity

- Do not mix RMB, USD, HKD, percentages, and absolute amounts in one axis.
- Do not combine revenue and margin in the same series merely because both are important.
- Preserve `亿元`, `%`, `人`, `倍`, or other units explicitly.
- Use comparable periods. Do not place quarterly and annual values on the same trend without a clear normalization.
- Calculated values must be described as calculated in nearby prose or in the series name.
- A pie chart requires a true common denominator; market shares or revenue mix values should not be forced to sum to 100 when the source scope differs.

## Interpretation

Prefer interpretations such as:

- acceleration or deceleration;
- reversal from growth to decline;
- divergence between revenue, profit, and cash flow;
- margin compression or expansion;
- concentration or diversification;
- outlier performance relative to peers.

Do not infer a cause from a shape alone.
