---
name: expectations-valuation
description: 完整投资研究中的估值阶段：比较经营判断、市场预期与价格隐含条件，连接情景估值、敏感性及回报路径。显式单独调用可交付局部结果；一般独立公司定价使用valuation-pricing-framework。
---

# Expectations & Valuation

完整研究开始前读取 [共同数据约定](../investment-framework-builder/references/state-contract.md)。只更新本模块字段和附件，不另写整篇报告。独立公司定价默认交给 [定价入口](../valuation-pricing-framework/SKILL.md)；用户显式调用本模块时可返回局部中文结果，不强制创建框架状态、前序检查点或完整报告。

## 输入与输出

完整流程输入：assumptions、metrics、forecasts、theses、evidence及case_checkpoint；缺检查点则返回Independent Case，不先按市场结果改写经营判断。输出market、valuations、sensitivities、return_paths、gaps及适用的第二张图，不覆盖theses或原预测。单独调用标明partial及未执行阶段；若使用状态，沿用现有字段。

## 本阶段职责

- 读取或复用同文件、版本和范围的模型说明及验收A，缺口限制对应判断。核算使用 [估值公共规则](../valuation-model-review/references/valuation-methods.md)，需要原模型勾稽时使用 [Review](../valuation-model-review/SKILL.md) 的审核要求，不执行其整篇报告。
- 记录原模型、自身预测、市场样本及价格时点的差异，逐期比较；缺共识留gap。市场数据不能倒灌到先前独立判断检查点。
- 通过assumption_ids将研究情景连接到经营条件，valuation_ids连接敏感性，thesis_ids连接回报路径。两类敏感性按公共规则分别标识，写入现有result/limitations，不把派生结果制造为新独立假设。
- 回报路径连接经营变化、盈利现金、分红/回购或重估及时间，并列证据、实现条件和下行缺口；催化剂必须影响相关预期，不硬编事件或默认倍数回升。计算口径及反向估值限制使用公共规则。
- 完整研究负责第二张敏感性图，执行 [图表公共规则](../valuation-model-review/references/chart-quality.md)；单独调用按问题选择，不强制图表。

模块表：关键变量｜模型预测｜市场参考及日期｜研究预测与依据｜估值影响；另列情景条件、回报路径及下行缺口。
