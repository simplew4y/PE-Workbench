# 项目整体估值报告

仅在用户要求项目 Excel 的整体估值分析/报告，且当前入口有 `pe_valuation_report` 时使用。先按 reading skill 取证，再以 `scope=overview` 提交。

- `facts` 提供来源坐标、完整 `expected_label`、期间和单位。每项 `context.label`、`context.unit`，以及需要时的 `context.period` 使用 `{sheet, cell, text, field?: "value" | "number_format"}`。文字用 reader 的 `display_value`，格式用原始 `number_format`。工具回读数字、核对文本，不替你证明业务含义。
- 保留加权平均、完全稀释、归母、调整后等口径。单位或期间不明时不能猜填；如果因此无法完成所问计算，明确说明。
- `calculations` 的 `growth/change/ratio/upside/product` 用于同口径增长、金额/百分点变化、比率、涨跌幅、每股量乘倍数。它不重算整个模型。
- 对所选事实声明 `role`、`valuation_method`、`period_kind`。`overview` 至少需要一个 `target_price/per_share_value/enterprise_value/equity_value` 估值事实。独立方法分别披露，别把别名或取整结果当另一种方法。工具不会自动穷尽所有输出。
- `sections` 用中性标题；`fact_ids` 引用事实/计算，非空 `analysis` 关联事实。数字、年份、引用和已发生的财务趋势放在事实/计算里，analysis 用于定性解释及明确的条件风险，不把未经核验的事实改写成假设。
- 已完成 `pe_driver_sensitivity` 时，把其 `run_id` 作为 `sensitivity_run_id` 提交。报告工具会核对同一工作簿、同一估值输出和原始输入，再只渲染最多五个实测 Top Drivers；不要把敏感性数字手抄进 analysis。完整传播路径和排除原因保留在该运行的审计附件。
- `blocked` 且 `repair_scope=sections` 时，按 `section_issues` 修正文字并重新提交，保留已核验事实，不需要为文字错误重新读表。来源或算术错误则按具体问题补读、修正。
- `ready` 后原样返回 `rendered_report`，不改写其中数字、单位或引用。影响结论的未决问题在交付时简短说明，不静默隐藏；不能跳过被阻止的校验直接伪装成已通过的报告。
