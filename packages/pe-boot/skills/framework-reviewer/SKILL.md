---
name: framework-reviewer
description: 分别验收模型理解与投资判断：先查真正输入、预测依赖及代表路径复算，再审正反证据、估值和改判条件。输出定向修正意见，不充当第二个报告作者。
---

# Framework Reviewer

开始前读取 [共同数据约定](../investment-framework-builder/references/state-contract.md)。完整流程只更新指定状态字段和分析附件，不各写一篇完整报告；单独调用时可返回该模块的中文结果。保留来源与稳定 ID。

## 输入与输出

输入：当前阶段已有的说明/报告、原工作簿、状态及底层证据，不要求先写完整投资报告才能审核模型理解。输出：model_understanding中的验收A结论，以及review中的验收B结论、问题位置、严重性、影响ID、原因、动作与责任模块。不重写整篇报告，不替原模块发明缺失数据。

## 验收A：能否解释分析师怎么算

按 [模型说明与理解验收](../valuation-model-review/references/model-understanding.md) 的U1—U6核查已有说明、输入角色及A证据。直接抽查决定性原公式与复算，尤其是跨期沿用、预测基数、利润链和估值接点；审核已有成果不等于再写完整模型说明或遍历全表。

同版本同范围保留仍有效的证据，新增问题或版本变化按接续规则定向核查；关键断点退回Business。对扰动类别与传播按 [共同计算规则](../valuation-model-review/references/valuation-methods.md) 抽查，价格条件对照不得替代U5。保存实际范围和结论，模型错误与理解是否通过分别记录；A不要求市场研究、图表或用户确认。

## 验收B：投资判断是否有依据

核对A状态；未通过的依赖限制对应判断，不能靠投资报告完整度抵消。只有用户要求投资研究时执行以下检查。单项模型说明到A结束；模型审核只增加相应公式/勾稽核验，不自动执行B。

1. 执行 `python3 ../investment-framework-builder/scripts/validate_state.py <状态文件>`（按本skill目录解析路径），检查ID、引用、阶段及必要字段。通过只代表结构有效，不证明金融计算正确。
2. 按共同计算规则抽查决定性估值、价值桥及差额证据；沿用A已核实的路径，重点检查新增情景和外部输入，不以check为零作充分证据。
3. 判断证据是否实际支持论点，是否重复来源或事后信息，是否忽略反证与合理替代解释，偏好是否污染事实。
4. 验证经营条件、情景与回报路径一致；价格是否同日，市场共识是否有来源；保守价值是否被误称底线；非线性敏感性是否错误线性外推。
5. 监控条件能否区分偏差与逻辑失效，是否有指标—判断关联、依据及行动；版本变更是否真正重要。
6. 按 [共同图表规范](../valuation-model-review/references/report-charts.md) 查看本次适用的已生成图；缺数据而明确省略可接受，假图或错方法不可接受。
7. 摘要不得引入正文没有的结论。事实支持经营机制，不自动支持当前价格。证据不足需保留“还不能判断”。

每条意见指定 business-driver-model、independent-investment-case、expectations-valuation、falsification-monitoring 或 builder，动作限补证据、修订判断、重算、修图或说明缺口。区分blocker、material、minor；未解决blocker不能通过。最多两轮定向修正，仍有问题交付明确缺口的草稿，不无限循环。

A、B各自记录reviewer_mode为self或independent及实际范围；同一agent先后自检仍为self。程序校验只检查记录存在和引用，不能自动签发两项验收。
