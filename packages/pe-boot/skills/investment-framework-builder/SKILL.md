---
name: investment-framework-builder
description: 生成、修订或保存投资框架，包括聊天草稿：交付并提交研究设定、当前判断、商业机制、投资判断、估值回报、监控、证据变化七节结构文档。模型说明与两阶段审核保留为附件；单项模型说明交给valuation-model-review。
---

# 📝 Investment Framework Builder

读取 [共同数据约定](references/state-contract.md) 与 [最终报告要求](references/report.md)。用户说“生成投资框架”即进入本流程；草稿和正式框架使用相同七节结构。框架以工具接受的 `schemaVersion=2` 文档为唯一保存对象，聊天、确认按钮、阅读与下载围绕同一份内容；不能只保存命题条目、另写一份无法还原的报告。

在 PE-Workbench 中用 `pe_load_capability` 按阶段加载对应模块，同时保留 `investment-framework-builder`；无需一次加载六个模块。脚本路径相对本 skill 目录解析，输出使用项目 `generated/` 下的本次报告目录，具体接入约定见共同数据约定。

## 📝 执行顺序

1. 先用 `pe_investment_framework(read)` 读取现有版本与草稿，保留原判断和证据 ID。确认公司、研究问题、资料与信息截止日；缺少偏好、期限或截止日依据时记录未知，不停工或猜测。按需在 `generated/` 建立或复用分析附件 `framework-state.json`，不覆写原模型；没有文件工具时仍可完成七节提案。
2. 有工作簿时，按 [模型说明与理解验收](../valuation-model-review/references/model-understanding.md) 的交接规则核对已有说明。由 [Business & Driver Model](../business-driver-model/SKILL.md) 复用同身份、版本和范围的说明、输入角色、路径证据、验收A及未解决事项；仅对新问题、版本差异或范围缺口补查，无适用成果才新交付 `模型说明.md`。执行 [Framework Reviewer](../framework-reviewer/SKILL.md) 的关键路径抽查并记录本次A结论；不能只凭旧通过状态、章节齐全或JSON合法通过。再由Business补充现实经营条件、外部证据及趋势图。没有工作簿时A标不适用并说明，不伪造模型说明。
3. 读取并执行 [Independent Investment Case](../independent-investment-case/SKILL.md)，保存候选判断、经营预测及 `case_checkpoint`。先完成这一阶段，再主动获取市场共识。若输入已含共识或目标价，记录已接触信息，不伪称盲测。
4. 读取并执行 [Expectations & Valuation](../expectations-valuation/SKILL.md)，把经营假设接入估值与市场比较，不能悄悄重写上一步判断。
5. 读取并执行 [Falsification & Monitoring](../falsification-monitoring/SKILL.md)，把重点变量关联到逻辑、失效条件与新证据。
6. 将分析编排为 [最终报告要求](references/report.md) 的七节 `sections`；当前判断最后生成并放第二节。模型说明、复算与验收A/B作为附件，不能占据或挤掉正文七节。若生成了分析状态文件则执行 `python3 scripts/validate_state.py <状态路径>`，再记录Reviewer验收B；未执行的核验明确标未执行。只把问题送回对应模块定向修正，最多两轮。A核心链未通过时仅继续不依赖该链的研究，受影响判断标待验证，不强行通过。
7. 用 `pe_investment_framework(propose)` 提交完整七节内容、实际读取的 docIds 和 read 返回的 expectedVersionId。工具保存的草稿由工作台直接展示为“完整投资框架”，无需再次逐字输出 `rendered_report`；回复简短说明已生成、尚待确认即可。只有用户点击“确定投资框架”才正式发布。内容修改必须重新提交整份文档；读取超时由工具对原参数有限重试，不因超时重新编写内容。分析附件的 `reviewed_draft` 不等于项目版本已发布；自动监控与交易仍须相应请求。

仅有 `pe_research_read` / `pe_research_submit` 的后台任务读取现有 basis 和获准证据，将相同七节 schema 提交给 `pe_research_submit`；不调用文件、市场或框架工具，不声称完成不可用的附件流程。未知信息在对应节的现有字段说明限制，并写入末节缺口，不将整节删除。

六个skills是职责分工，不要求六个agent。两个验收按依赖顺序执行，不是两次用户审批；可在授权范围内委派独立核验，不能把同一agent自检称为独立审核。

## 更新

新资料先评估重要性，再按 evidence → assumption → thesis → valuation → monitoring 引用找受影响字段。保留未受影响内容，不因措辞变化重写投资判断。记录旧判断、新证据、新判断及原因；首次不制造版本变化。

## 边界

单项模型检查交给 [valuation-model-review](../valuation-model-review/SKILL.md)，不启动全流程。分析师偏好决定研究深度和末尾适配，不替代事实判断。证据不足写“还不能判断”。共同回答商业机制、盈利现金驱动、市场预期、保守价值下行和回报路径；不同风格作为问题来源，不贴公司标签。
