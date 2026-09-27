# 投资框架：环境与首个运行闭环

2026-09-12。两个仓库均使用 `codex/investment-framework`。

基线：核心 `205fade1170f80d1fa06a72dc7a1534f8451dfaf`；Web `32d51ea4114635ece4fbb98f21857c949254ca6c`。本次尚未提交、推送或合入 main。

## 当前已实现

- Agent 通过 `pe_investment_framework` 在对话中读取和提出框架；生成回复下方显示“确定投资框架”，用户点击后才发布。
- 右侧纵向“投资框架 / Memo”入口，默认收起阅读区；确认后自动展开框架。修改继续通过对话提出，不使用表单管理弹窗。
- Memo 读取当前项目各主题的正式内容；切换对话、刷新页面后成果仍保留。
- 用户假设与有资料依据的研究条目区分；保存研究条目时必须有可定位的证据。
- 正式版本不可变；草稿修订与发布基准分别检查，冲突保留草稿；发布请求可幂等重试。
- 选中的已解析 PDF 页和 Excel 单元格用于研究，引用绑定具体文档版本，复用现有来源预览。
- SDK 后台会话只装配 `pe_research_read` 与 `pe_research_submit`；不加载项目扩展、AGENTS、Skills、模板或默认 shell 工具。
- 独立 Worker 领取持久任务；具备租约、重试、取消、旧结果拒收和基准版本保留。
- 环境检查命令验证 Node、SQLite WAL/FTS5 和已有 openpyxl 环境。

持久队列仍保留在后端；当前对话生成使用主 Agent，无需启动研究 Worker。自动持续追踪尚未启用。

## 开发环境

采用现有相邻仓库布局和已安装依赖，无新增运行依赖：

```text
workspace/
  PE-Workbench-pi/
  PE-Workbench-pi-web/
```

Node 要求 `>=22.19.0`，本机验证版本为 `24.16.0`；Excel 使用已有 `openpyxl==3.1.5` 环境。

首次准备或核心源码修改后，在核心仓库编译 pe-boot：

```sh
./node_modules/.bin/tsgo -p packages/pe-boot/tsconfig.build.json
```

Web 的 `node_modules/@earendil-works/pe-boot` 必须解析到相邻核心仓库的 `packages/pe-boot`。本次发现并修复了它错误指向旧 `integration` 工作树的本地软链接。

在 Web 仓库运行：

```sh
npm run research:doctor
```

如果 Excel 检查失败，使用核心仓库原有 `packages/pe-boot/python/setup.mjs` 配置环境；无需另建解析器。

## 启动研究 Worker

Web 仍用原来的开发／部署启动方式。研究 Worker 独立启动，必须显式选择项目；不在 Next.js 请求处理器中启动循环。

先使用原有模型设置配置可用的 provider/model。Worker 复用 SDK 的认证配置，不把凭据写入任务。随后在 Web 仓库运行（替换占位值）：

```sh
PE_RESEARCH_PROVIDER=your-provider PE_RESEARCH_MODEL=your-model \
npm run research:worker -- \
  --registry /absolute/path/to/.pi/agent/pe-workbench/datasets.sqlite3 \
  --dataset dataset_your_project
```

单次处理追加 `--once`。认证目录与默认不同，设置 `PI_CODING_AGENT_DIR=/absolute/path/to/.pi/agent`。Worker 只负责队列里的后台研究任务；对话内生成由当前会话模型完成。

当前执行上限：每轮 120 秒、12 个模型回合，租约 60 秒、每 10 秒续租，最多尝试 3 次；失败后按 30/60 秒等待重试。SIGINT／SIGTERM 会停止当前会话，将可重试任务保留；强制退出后到期租约可重新领取。该限制是执行边界，不是已验证的模型费用上限。

本次未设置实际研究模型或启动常驻研究任务；未修改用户凭据，未调用真实模型。

## 数据与接口

研究数据保存在项目已有 `meta/collection.sqlite3`，以 `research_schema_version=2` 标记增量研究表；v2 增加确认续接记录，原文档 pipeline schema 保持 v4。首次进入框架功能时创建或升级研究表，不删除旧资料或 Memo。

首轮 API 集中在 `/api/pe/frameworks`：GET 按 datasetId 返回框架、当前 Memo、续接记录和最近任务；POST 通过 action 处理 `create/save/publish/restore/reject/generate/cancel/confirm/continue`。浏览器只传项目 ID，不接受任意工作区路径；沿用现有 API 认证、来源检查及用户路径约束。

主界面通过 PeFrameworkPanel 使用独立 research-ui 组件，真实框架版本可只读切换。confirm 校验当前会话分支中的真实工具提案，将正式版本与来源会话/工具调用续接记录在同一事务保存。客户端随后连接现有 SSE，再调用 continue；服务端复用原 Pi 会话、模型授权及 prompt/followUp 接收路径。未改变 Harness 核心。

保存与模型运行分别显示：续接失败可单独重试；已送达只表示 Pi 接收，最终执行结果在对话中显示。重试检查会话消息和内存队列，避免重复提交。若进程在接收过程中退出，且无法从会话确认是否送达，会显示待核对而不自动重放；当前没有常驻自动续接扫描器。发布后关闭页面、尚未续接的记录可在回到原对话后点击“继续研究”。

后端保留部分接受和历史恢复能力，当前简洁 UI 不提供管理表单。每条对话确认按钮绑定具体草稿及修订号；过期提案不能覆盖当前版本，用户可以在对话中要求重新整理。

研究 Worker 只读取已解析索引，不触发原文解析。现有上传解析链尚未接入受限执行后端，因此不能把本次改动宣称为完成了解析沙箱。

## 验证与后续阶段

已验证：核心定向测试（框架、SDK 接线、原有迁移及系统提示词）；Web 路由与提案结果识别测试；核心 `npm run check`；Web 类型检查；改动文件 lint。浏览器使用真实工具生成的临时测试对话，验证回复下确认、发布 v1、右侧自动展开及刷新恢复；未调用付费模型。

Web 全仓 lint 有 13 个既有 `react-hooks/preserve-manual-memoization` 错误，位于 ChatInput、ChatMinimap 和 useAgentSession；续接仅导出了 useAgentSession 已有的 SSE 连接方法，未更改这些既有报错处。

| 阶段 | 仍需完成 |
| --- | --- |
| A：框架版本闭环 | 真实模型与真实 PDF／Excel 人工验收；条目指标／规则修订、完整差异与追踪计划编辑进一步完善 |
| B：资料驱动复盘 | PDF／Excel 就绪后的持久触发、重启补扫、独立观察与覆盖状态、站内事件 |
| C：实时来源与运行环境 | 确定试点公司／行业、验证两个来源授权、快照与调度、解析隔离及真实越界测试 |
| D：前瞻试点 | 在常开机器连续运行 1—2 周，核对遗漏、时效、引用和成本 |

下一步从 B 的“证据就绪 → 幂等复盘任务 → 观察／建议”开始。外部来源和正式部署还需确定模型预算、试点公司／行业、数据授权与常开机器；配置未完成前不启用自动外部追踪。
