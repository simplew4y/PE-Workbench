---
name: valuation-pricing-framework
description: 独立公司估值与定价入口：解释适用方法、当前价格隐含条件、估值水平和重估空间，并适配Wind及股票追踪forecast。完整投资研究内的情景、预期差与回报路径使用expectations-valuation。
---

# 估值与定价框架

用于用户问“这家公司怎么估值、当前价格是否合理、还有没有重估空间”，以及股票追踪预测。输入可为公司名称、财务资料、行业和用户给定的估值数据；按问题深度交付，不为普通定价问答创建框架状态或启动完整研究。

完整投资研究由 [Builder](../investment-framework-builder/SKILL.md) 调度 [Expectations](../expectations-valuation/SKILL.md)，本入口不与其重复写一篇报告。两者共用 [估值公共规则](../valuation-model-review/references/valuation-methods.md)；已有模型证据按同文件版本与范围复用，没有原模型时不强制Excel解构。

## 定价分析

1. 依据证据识别高成长、稳健成长、周期、价值、资源、平台或金融等业务特征，用于选择方法，不先用标签决定投资结论。
2. 解释适用的PE、PEG、PB、EV/EBITDA、PS、分部或周期中枢等方法及局限，不生搬硬套。参数、价值桥、基准与两类敏感性采用公共规则。
3. 拆解当前价格可能隐含的增长、盈利、周期、份额或新业务条件；条件反推不是已经证实的预测，列固定条件和证据缺口。
4. 结合公司阶段与经营质量比较历史、同业位置；统一期间与口径，高倍数不自动贵、低倍数不自动便宜。
5. 说明业绩兑现、行业变化、商业模式、治理或风险偏好变化如何影响定价，区分有来源的机制与待验证的解释，不硬编催化剂。
6. 在请求和证据范围内回答估值性价比、盈利与倍数的回报来源及乐观/审慎/等待的条件；没有充分证据就明确不能判断。

完整定价回答可按“适用方法、价格隐含条件、估值位置、驱动、重估/回落条件、结论”组织，单项问题不强制六部分。不输出交易指令或启动监控。

## PE Workbench 接入

方法来源：[万得艾思 · Alice Market / valuation-pricing-framework](https://github.com/Wind-Alice/AliceMarket/blob/main/skills/valuation-pricing-framework/SKILL.md)。本应用的公共计算规则及以下适配共同约束实际交付。

- `wind.financial.data` 通过 `pe_trusted_source` 接入：常规财务用 `category=financials`；专项接口无法提供的自定义估值、历史分位或同业聚合才用 `category=analytics`，对应 `analytics_data.get_financial_data(question)`。股票行情和历史K线由 `pe_stock_tracking refresh` 获取。
- 股票追踪每轮先刷新并保存Wind行情，再取得本轮财务、估值及同业证据；不能将旧模型改日期作为新预测。
- 利润受一次性收益或分拆影响时区分持续/终止经营，按公司情况选择替代方法，不因半年实际与全年预测不同就终止。
- 追踪输出保持 `forecast={bear,base,bull,targetDate,basis:{summary,evidenceIds}}`，依据说明方法、输入、情景和计算，保留Wind来源引用。可提供 `valuationEstimates=[{date,price,basis}]`，但未来预测不依赖另填当日估值或复核表。
- 追踪不输出完整报告、不要求用户填参数。数据不足时先考虑其他适用方法或定向补取；仍无法支持定价则保留已有行情并说明缺项，不造预测。
