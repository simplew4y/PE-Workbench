# Issue #1：模型规则统一与验证记录

依据：[issue #1](https://github.com/simplew4y/PE-Workbench/issues/1) 和 [完整分析文档](https://docs.google.com/document/d/11LHB-vw0kdy7EwQf5Dj59yBVqRx_Ft5Pc6Yt0wwUBgI/edit)。实施基线为 `7d188d43dd8880186b244c2cce43c44ea794df98`，分支 `codex/issue-1-shared-model-rules`，目标 `main`。

不同入口原先对EPS条件替换与上游驱动扰动采用不同分类。本次将输入角色、模型交接、估值及图表规则集中维护，保留模型说明、审核、独立定价与完整研究入口。

## 位置与职责

| 原文档位置 | 整合仓库位置及本次处理 |
| --- | --- |
| `PE-Workbench-pi/packages/pe-boot/skills/` | `packages/pe-boot/skills/`：输入角色/验收沿用model-understanding；新增valuation-methods和chart-quality公共参考，入口引用公共规则 |
| `PE-Workbench-pi/packages/pe-boot/src/` | `packages/pe-boot/src/`：更新能力文件清单、系统路由与受限研究预注入 |
| `PE-Workbench-pi-web/` | `apps/web/`：本次不改Web界面或API；通过现有SDK连接使用公共能力 |

普通聊天不强制新建框架状态。完整研究沿用model_understanding、evidence、gaps及附件，通过文件身份、版本和覆盖范围核对成果；Reviewer保留原始路径抽查。数据库、工具参数、报告facts/calculations、股票追踪forecast均未改。没有重写现有能力去重/上下文替换机制。

受限研究将SKILL.md用于发现，将所需skill及参考正文按路径去重预注入；仍只有pe_research_read、pe_research_submit，不新增文件、Python或外部访问工具。

## Issue 验收对应

| 验收项 | 实现与检查 |
| --- | --- |
| 输入角色、两类敏感性 | model-understanding集中定义角色；valuation-methods区分原模型输入敏感性、价格条件对照及切断依赖的新增情景 |
| 同版本接续、版本变化补查 | 公共交接规则覆盖身份、版本、范围、输入角色、路径、A及缺口；Builder/Business/Reviewer按该规则复用及重评 |
| 价值桥、复现、图表 | valuation-methods统一计算口径；chart-quality统一范围与质量，审核不固定追踪图，完整研究保留适用三图 |
| 单项定价路由 | valuation-pricing-framework负责独立定价和Wind/forecast；Expectations负责研究阶段，显式单项调用保留partial |
| A/B和模块分工 | 保留模型理解与投资判断的分离、Reviewer定向审核、聚焦/受限研究与完整报告的分工 |

以上是实现对应，不能替代下述行为验收。

## 2026-09-28 自动验证

- 7个定向Vitest文件共137项通过：capabilities（14）、research-reader-skill（1）、system-prompt（15）、valuation-report-guard（77）、research-pi（1）、stock-tracking-tool（7）、valuation-report（22）。其中独立定价压缩恢复用例在其余136项通过后追加，capabilities全文件14项复测通过。
- 覆盖共享参考去重、阶段替换、恢复会话/压缩、独立定价隔离、受限研究发现/预注入和权限，以及报告保护、真实来源校验和股票追踪输出。
- 9个修改后的SKILL.md通过quick_validate；相对引用及工具名可达性通过回归测试。框架状态校验器自测通过，未改schema。
- 合成工作簿两版各32个数值锚点通过现有reader核验，并检查输入/沿用/倒算公式、两版哈希不同、读取前后文件哈希不变。原基准价格75/82.5，增长提高1个百分点且真实跨期传播后的价格76.5/85.815，v2第二年价格89.16。
- workspace验证19处内部依赖通过；browser-smoke、Web ESLint通过；差异格式检查通过。

复测入口（仓库根）：

```bash
cd packages/pe-boot
node ../../node_modules/vitest/dist/cli.js --run test/capabilities.test.ts test/research-reader-skill.test.ts test/system-prompt.test.ts test/valuation-report-guard.test.ts test/research-pi.test.ts test/stock-tracking-tool.test.ts test/valuation-report.test.ts
cd ../..
python3 packages/pe-boot/evals/shared-model-rules/fixture.py
python3 packages/pe-boot/skills/investment-framework-builder/scripts/validate_state.py --self-test
npm run check
```

## 全仓基线阻塞

`npm run check`的Biome、依赖固定、TS导入、shrinkwrap、install-lock检查通过，随后Pi类型检查失败。为避免跳过串联命令后续检查，另执行了workspace、browser-smoke、Web类型与lint。

- Pi有11处既有错误：fireworks-models测试中的旧模型ID和compat字段（7处）、openai-completions-prompt-cache（2处）、openai-completions-tool-choice（1处）、stream中的claude-sonnet-4-5（1处）。
- Web有4处既有错误：股票追踪route对PeValuationOutputResult.selected_output的访问。
- 在临时目录展开未修改HEAD，复用相同依赖及本机生成的模型目录数据，分别运行Pi/Web类型检查，复现完全相同的11/4处错误。本次不更改模型目录、测试基线或股票追踪API以绕过失败。

## 行为验收尚未运行

[8组行为用例与执行说明](../packages/pe-boot/evals/shared-model-rules/README.md)已准备，覆盖EPS对照、上游传播、倒算角色、同版本接续、版本变更、完整报告、受限后台和独立定价。没有调用真实/付费模型，没有使用真实投研数据，没有实际agent回答、工具轨迹或图文报告可作为行为通过证据；faux测试和合成来源核验不证明模型分析质量。

本次不涉及issue #2的成果栏，不执行发布或自动合并。后续PR应保留以上基线失败及行为未验收说明，不将其描述为全量验收通过。
