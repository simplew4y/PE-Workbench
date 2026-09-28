---
name: business-driver-model
description: 先还原分析师的收入、成本利润、现金流及估值输入依赖，交付独立模型说明；再分析商业驱动和假设隐含的经营条件。用于投资框架经营基线，不生成市场目标价。
---

# Business & Driver Model

开始前读取 [共同数据约定](../investment-framework-builder/references/state-contract.md)。完整流程只更新指定状态字段和分析附件，不各写一篇完整报告；单独调用时可返回该模块的中文结果。保留来源与稳定 ID。

## 输入与输出

输入：context、sources、既有evidence及原工作簿。输出：模型说明、model_understanding的说明与检查证据、evidence、business、metrics、assumptions、model_checks、gaps，以及趋势图附件。验收A的最终状态由Reviewer记录；不得写入市场共识或最终投资评级。

有工作簿时先执行 [模型说明与理解验收](../valuation-model-review/references/model-understanding.md)，并读取 [模型审核规则](../valuation-model-review/SKILL.md) 的“内部核验要求”和“范围与证据”，不要执行其整份审核报告。无工作簿时用财报建立基线并注明模型缺失，不虚构Excel来源。

先按公共参考核对已有说明的身份、版本和范围。同版本可复用说明、输入角色、路径证据、验收A和未解决事项；只补新问题、版本差异或范围缺口，不重新遍历或另写说明。没有适用成果时交付独立模型说明和A的检查证据，再进入以下经营研究。Reviewer保留必要抽查；不能用后续实际或市场预测替换原模型输入来验收理解。

## 工作要求

- 解释客户为何付费、利润来自哪个环节，区分客户购买动机的证据与研究推断；核验行业竞争与可观察KPI。
- 使用模型说明中已核查的输入角色、期间与驱动关系，按 [估值公共规则](../valuation-model-review/references/valuation-methods.md) 解释现金流及价值桥的影响；勾稽按Review执行。此阶段增加经营条件验证，不重新定义模型角色或预测依赖。
- 经营研究引用已说明的输入，再写“现实中需要的经营条件 → 支持证据 → 其他可能机制/缺口”。模型没写选值理由就注明未记录；现实中可能需要的条件不冒充分析师动机。例如利润率提升可能是效率，也可能是递延费用，不能直接选定有利解释。
- 检查增长、产能、投入与周转是否相容。新增投资回报与资本成本比较需要真实投入数据，不以空白公式或ROE替代增量回报。
- 完整研究中负责第一张历史与预测趋势图，遵循 [图表公共规则](../valuation-model-review/references/chart-quality.md)；单项调用按任务范围选择。

模块简表：假设及公式来源｜成立所需经营条件｜已有证据｜替代机制与缺口。盈利、现金流和核对明细按需要附，不抢先决定候选投资逻辑。
