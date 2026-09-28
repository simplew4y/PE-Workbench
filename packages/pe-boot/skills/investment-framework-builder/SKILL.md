---
name: investment-framework-builder
description: 协调完整投资研究：先独立交付并验收分析师的模型说明，再组织经营判断、预期估值、反证追踪及投资审核。共用研究状态并生成中文图文报告；单项模型说明交给valuation-model-review。
---

# Investment Framework Builder

读取 [共同数据约定](references/state-contract.md) 与 [最终报告要求](references/report.md)。这是总控，不凭空代做缺失分析，也不把模块文章拼接成报告。

在 PE-Workbench 中用 `pe_load_capability` 按阶段加载对应模块，同时保留 `investment-framework-builder`；无需一次加载六个模块。脚本路径相对本 skill 目录解析，输出使用项目 `generated/` 下的本次报告目录，具体接入约定见共同数据约定。

## 执行顺序

1. 确认公司、研究问题、资料与信息截止日，在用户输出目录建立或复用 `framework-state.json`。不覆写原模型。保留已有逻辑ID、原预测版本与证据，新增数据注明可得日期。研究对象不明才澄清，不为偏好等可空字段停工。
2. 有工作簿时，按 [模型说明与理解验收](../valuation-model-review/references/model-understanding.md) 的接续规则，先接收已有说明、输入角色、路径证据、A状态与未解决事项，沿用 `model_understanding`／`evidence`。由 [Business & Driver Model](../business-driver-model/SKILL.md) 补齐缺失说明或定向核查新范围/版本差异；同版本成果不重新遍历。执行 [Framework Reviewer](../framework-reviewer/SKILL.md) 的必要抽查及A验收，保留或更新实际结论；再由Business补充经营条件、外部证据和趋势图。无工作簿时A标不适用，不伪造模型说明。
3. 读取并执行 [Independent Investment Case](../independent-investment-case/SKILL.md)，保存候选判断、经营预测及 `case_checkpoint`。先完成这一阶段，再主动获取市场共识。若输入已含共识或目标价，记录已接触信息，不伪称盲测。
4. 读取并执行 [Expectations & Valuation](../expectations-valuation/SKILL.md)，把经营假设接入估值与市场比较，不能悄悄重写上一步判断。
5. 读取并执行 [Falsification & Monitoring](../falsification-monitoring/SKILL.md)，把重点变量关联到逻辑、失效条件与新证据。
6. 统一编排草稿：第一部分复用已验收的模型说明；第二部分是投资研究，投资摘要最后生成、置于第二部分开头。执行 `python3 scripts/validate_state.py <状态路径>`，再执行Reviewer验收B；分别记录A、B，不能互相代替。只把问题送回对应模块定向修正，最多两轮。A核心链未通过时仅继续不依赖该链的研究，受影响判断和总状态标待验证，不强行通过。
7. 保存已核对的状态与报告，标为 `reviewed_draft` 或 `needs_revision`。交付本地报告不等于对外发布；不因文档模板含发布节点而额外要求本地交付审批。实际对外发布遵从用户授权，自动监控或发布必须有相应请求。

六个skills是职责分工，不要求六个agent。两个验收按依赖顺序执行，不是两次用户审批；可在授权范围内委派独立核验，不能把同一agent自检称为独立审核。

## 更新

新资料先评估重要性，再按 evidence → assumption → thesis → valuation → monitoring 引用找受影响字段。保留未受影响内容，不因措辞变化重写投资判断。记录旧判断、新证据、新判断及原因；首次不制造版本变化。

## 边界

单项模型检查交给 [valuation-model-review](../valuation-model-review/SKILL.md)，不启动全流程。分析师偏好决定研究深度和末尾适配，不替代事实判断。证据不足写“还不能判断”。共同回答商业机制、盈利现金驱动、市场预期、保守价值下行和回报路径；不同风格作为问题来源，不贴公司标签。
