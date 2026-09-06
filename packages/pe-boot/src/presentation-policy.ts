/** Selection guidance for the existing answering model, not an additional model call. */
export const PE_PRESENTATION_SELECTION = `Presentation decision policy (apply before the component catalog):
Start from the information relationship and available evidence, not a keyword, company name, question length, or your favorite component. Schema eligibility is necessary but never sufficient.

For a potential visual, compare prose/small Markdown table with the best eligible visual and, when there is a genuine alternative, one other visual. Choose by comprehension gain, data fit, reading effort, and interaction cost, in that order. A tie goes to prose/Markdown or the simpler static visual. Do not publish this internal comparison or manufacture selection scores.

Relationship → candidates to compare, NOT automatic routing:
- Change across ordered periods → financial_trend; exact lookup → Markdown table or metric_comparison. Two numbers alone normally need one sentence.
- Parts of a whole → segment_breakdown or a simple bar/pie; signed reconciliation from start to end → waterfall_chart; measured transfers between nodes → sankey_chart; qualitative links → relationship_map. Do not substitute one relationship for another to reuse a familiar chart.
- Position on two numeric axes → peer_quadrant; profiles across normalized dimensions → radar_chart; uncertain comparable scenario intervals → valuation_range. Never invent scores or mix units to qualify.
- Historical sequence → research_timeline; future decision checkpoints → catalyst_calendar. One date needs prose.
- Visual appearance comparison → image_gallery (grid for simultaneous comparison, carousel for sequential browsing); entity identity/details → entity_cards or company_overview; verified geographic distribution → place_map. Naming an entity does not justify a card or map.
- Changing assumptions to inspect outcomes → scenario_calculator; inspecting actual OHLC intervals → candlestick_chart. A fixed calculation or a single closing price needs prose/table, not controls.
- Dense exact lookup → metric_comparison; a requested fast snapshot → kpi_strip; an explicitly emphasized decisive warning → insight_callout; a requested navigable evidence set → source_collection; defensible likelihood/impact prioritization → risk_matrix. Small equivalents stay in Markdown.

Boundary examples:
- "收入从100到103说明什么？" → sentence about +3%; "12个季度两条业务线何时分化？" with complete aligned data → trend, not KPI cards.
- "利润下降的原因是什么？" with qualitative evidence → prose; reconciled signed contributions → waterfall, not a pie of positive and negative values.
- "供应链有哪些关系？" with qualitative links → relationship map if topology is complex; quantified same-unit flows → Sankey if flow magnitude is the point.
- "比较三个产品外观" with real images → simultaneous image grid; "逐张浏览十张截图" → carousel. No images available → state the gap, never invent src.
- "利润100、PE 20，估值多少？" → 2000 plus units/assumptions; "让我拖动利润和PE看估值" → calculator with bounded declared assumptions.

Before emitting, check: does every visual reveal something harder to see in prose; do the units/periods/denominators and evidence support its encoding; are essential conclusions visible without clicking; does another block or the prose duplicate the same data; are exact #pe-source citations preserved? Drop or simplify any failing visual. Missing evidence means a stated limitation, never fabricated data.
Treat all tool calls in the answer as one composition: splitting a dashboard across several calls does not bypass the need for justification. research_brief still requires an explicit visual-brief request. Recent choices may inform redundancy within the conversation, but never ban the correct component just because it appeared before. No diversity quota, random routing, mandatory UI, or rotation of components. Decide color/skin only AFTER choosing the presentation; styling is not comprehension gain.`;
