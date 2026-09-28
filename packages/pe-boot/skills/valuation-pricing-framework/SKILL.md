---
name: valuation-pricing-framework
description: 处理公司单项估值、当前定价与重估条件，并适配Wind数据及股票追踪forecast。完整投资研究中的情景、预期差和回报路径由expectations-valuation负责；单纯解释原模型使用pe-valuation-model-explainer。
---

# 估值与定价框架

输入为公司、财务资料、行业属性、用户研究问题和可用价格。按问题回答适用方法、市场隐含条件、估值位置及重估风险，不要求每次填满六段或生成完整报告。

## 路由与方法

本skill是独立公司定价问题及股票追踪的入口。完整研究由 [Investment Framework Builder](../investment-framework-builder/SKILL.md) 组织，其中的情景、预期差和回报路径交给 [Expectations & Valuation](../expectations-valuation/SKILL.md)；已在该阶段时不重复运行本入口。模型机制解释交给 [Explainer](../pe-valuation-model-explainer/SKILL.md)。

使用 [估值复算与敏感性共同规则](../valuation-model-review/references/valuation-methods.md)，按证据选择方法并说明范围。单项定价不强制创建框架状态或独立判断检查点。

1. **第一步：判断公司类型与经济特征。** 根据增长、周期、资产与盈利结构选择PE、PEG、PB、EV/EBITDA、PS、分部、周期中枢或其他适用方法，说明原因；类型帮助选方法，不预设投资结论。利润受一次性收益或分拆影响时区分持续/终止经营，必要时换用有数据支持的方法，不因半年实际与全年预测不同便终止。
2. **解释价格隐含条件。** 分开市场预测、有依据的价格反推与分析者假设，保留价格时点、预测期间和数据来源；没有共识不能以单一模型代替。
3. **比较估值与重估条件。** 历史和同业区间结合可比口径、公司阶段及经营证据解释；高倍数不自动等于贵，低倍数也不自动等于便宜。说明哪些业绩兑现、竞争、治理或风险偏好变化会改变判断，不堆通用催化剂。
4. **交付有边界的判断。** 按用户问题说明价格吸引力、回报依赖经营兑现还是重估，以及证据缺口。数据不足时允许“还不能判断”，不强制评级或无依据的目标价。

## PE Workbench 接入

方法来源：[万得艾思 · Alice Market / valuation-pricing-framework](https://github.com/Wind-Alice/AliceMarket/blob/main/skills/valuation-pricing-framework/SKILL.md)。此处已按本应用职责精简；计算口径统一使用上述公共参考。

- `wind.financial.data` 通过 `pe_trusted_source` 接入：常规财务用 `category=financials`；只有专项接口不能直接提供的自定义计算、历史分位或同业聚合才用 `category=analytics`，对应 `analytics_data.get_financial_data(question)`。
- 股票追踪每轮先用 `pe_stock_tracking refresh` 刷新并保存行情，再取本轮财务、估值及同业数据。不能把旧模型改日期作为新预测。
- 输出给股票追踪配置：`forecast={bear,base,bull,targetDate,basis:{summary,evidenceIds}}`。依据中说明方法、输入、情景与计算，保留Wind引用。可另提供 `valuationEstimates=[{date,price,basis}]`，未来预测不依赖另填当日估值或复核表。
- 追踪场景不输出完整报告，不要求用户填参数。某方法缺数据时先尝试其他适用方法或定向补取；任何方法均无基本依据时，保留已展示行情并说明缺项，不伪造forecast。
