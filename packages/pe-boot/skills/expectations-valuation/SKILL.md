---
name: expectations-valuation
description: 完整投资研究中，在已保存经营判断后比较模型、自身预测、市场预期与价格隐含条件，计算情景、下行、回报路径和敏感性。独立公司定价及股票追踪使用valuation-pricing-framework；明确点名单模块时限定范围。
---

# Expectations & Valuation

完整流程读取 [共同数据约定](../investment-framework-builder/references/state-contract.md)，只更新本模块字段和附件。独立公司定价及股票追踪转交 [定价入口](../valuation-pricing-framework/SKILL.md)；用户明确单独调用本模块时返回限定范围的中文结果，不强制建立框架状态。

## 输入与输出

输入：assumptions、metrics、forecasts、theses、evidence及case_checkpoint。完整流程须先保存检查点；缺失则返回前一模块。单项调用说明仅完成局部分析；已有状态时标partial，不声称完成独立判断阶段。输出：market、valuations、sensitivities、return_paths、gaps及敏感性图；不覆盖theses或原预测。

## 工作要求

- 区分原模型预测、自身经营判断、市场一致预期和条件反推，记录价格时点、市场样本及每个预测期。缺共识就留缺口，不拿单一分析师当市场。
- 读取已有模型说明、核对结果及验收A，按 [接续规则](../valuation-model-review/references/model-understanding.md) 复用同版本证据及已复现基准，只补算新情景或变更路径。未解析的核心引用限制相应结论，不能包装成完整重估。
- 价值桥、DCF时点/终值、情景与反推统一使用 [估值复算与敏感性共同规则](../valuation-model-review/references/valuation-methods.md)，不重新执行整份模型审核。
- 情景通过assumption_ids关联经营条件；收益比较用同一价格日期、币种和期限，区别价格回报、总回报和年化回报。
- 回报路径连接经营变化、盈利现金、分红/回购或重估及时间。回购现金与每股收益效果不重复计入；过去已派股息不属于新买入者。催化剂必须改变相关预期，不硬编事件或默认倍数回升。
- 按共同规则区分原模型输入敏感性与价格条件对照；研究新增假设单列。结合可比扰动和不确定性选2—3个重点变量，将路径、固定条件与缺口交给Monitoring。
- 负责敏感性图，按 [共同图表规范](../valuation-model-review/references/report-charts.md) 生成，不另加一套报告图。

模块表：关键变量｜模型预测｜市场参考及日期｜研究预测与依据｜估值影响；另列情景条件、回报路径和下行缺口。
