# UI 选择策略与回归评测

## 实际运行路径

```text
用户问题 + 已检索证据
          ↓
同一个回答模型：识别信息关系
          ↓
比较：文字/小表格 ↔ 合适的可视化候选
          ↓
按理解收益、证据适配、阅读成本、交互成本选择
          ↓
整条回答自检：数据口径、重复表达、交互必要性、绿色溯源
          ↓
普通 Markdown / pe_render_ui（已有严格协议和渲染器）
          ↓
现有 session JSONL 记录工具调用和结果
          ↓
只读审计 → 人工标注用例 → 离线结构回归
```

没有新分类模型、额外推理请求、前端关键词路由或强制组件配额。
候选比较、自检属于主模型的提示词约束，不是能保证模型服从的确定性算法。
协议校验仍由代码执行；事实是否有据、表达是否更清楚需要人工评审。
复用合适组件是正确行为，不能把组件使用频率均匀当成优化目标。
配色/皮肤在表达选择之后决定，不以换颜色代替内容改善。

## 文件职责

路径相对各自仓库根目录。

| 仓库 / 文件 | 职责 |
| --- | --- |
| core: packages/pe-boot/src/presentation-policy.ts | 主模型常驻的信息关系、候选比较、边界示例和自检策略 |
| core: packages/pe-boot/src/system-prompt.ts | 将策略加入真实会话系统提示词，保留组件契约、样式和溯源要求 |
| core: packages/pe-boot/skills/pe-generative-ui/SKILL.md | 按需加载的表达技能入口 |
| core: …/references/component-selection.md | 完整组件候选和16组正反边界示例 |
| core: …/references/evaluation-cases.json | 36条合成评测题、信息关系、可接受表达、组件数量及交互约束 |
| web: lib/generative-ui/selection-audit.ts | 从指定 session 的一条 parentId 分支提取每轮实际选择，区分成功/失败/未完成；不包含思考和工具结果正文 |
| web: scripts/audit-generative-ui.mjs | 默认脱敏摘要的只读命令行入口；不会扫描所有会话或写入新日志目录 |
| web: lib/generative-ui/evaluator.ts | 检查整条回答的全部成功 UI，允许多解，标记漏用/错用/堆叠/多余交互 |
| web: scripts/evaluate-generative-ui.mjs | 读取人工整理结果，或按明确映射评测指定会话分支；不调用模型 |

core 是 `/home/simpleway/PE-Workbench-pi`，web 是 `/home/simpleway/PE-Workbench-pi-web`。

## 审计实际会话

在 web 仓库中运行，替换为需要检查的那一个现有会话文件：

```bash
node --experimental-strip-types scripts/audit-generative-ui.mjs --session /absolute/path/session.jsonl
node --experimental-strip-types scripts/audit-generative-ui.mjs --session /absolute/path/session.jsonl --leaf USER_OR_ASSISTANT_ENTRY_ID
```

默认沿文件最后一个树节点回溯，而不是把所有分支混在一起。
若要审计界面所选分支，应明确传它的叶节点 ID；文件末尾不一定就是界面正在看的分支。
只支持含 id/parentId 的 v3 树日志，损坏或缺失父节点会报错。
正在写入的日志建议等回答结束再读取，最后一行不完整时会明确报错。

摘要包含 turnId、完成状态、工具调用数量、选型、样式和成功组件数量。
工具成功不等于浏览器渲染已验证；不会从频率推断质量。
失败重试与未完成调用单独保留，不冒充成功渲染。
需要人工检查内容时添加 `--include-content`；这会向终端输出私有问题、回答和成功 UI 的参数。
不要把该输出上传公共服务。不会输出隐藏思考、图片字节或检索结果全文。

## 跑结构评测

默认36条题均为合成数据，不是投资事实。先用受测模型回答，再收集结果；脚本不会自动花费模型额度。
图片题必须先提供真实可读的图片夹具并替换路径：题中路径是测试约定，不会由脚本生成或下载。
测试目标是展示/浏览图片，不意味着文本模型因此具备看图能力。
每次比较尽量保持模型、参数、资料一致，在不同会话运行边界题，避免上题要求污染下题。

手工结果 JSON 数组或 JSONL：

```json
[
  {"caseId":"delta-small","text":"收入增长3%。","surfaces":[],"completion":"complete"},
  {"caseId":"trend-divergence","text":"从Q4开始分化。","surfaces":[{"version":1,"component":{"kind":"financial_trend","title":"Q4开始分化","chart":"line","categories":["Q1","Q2","Q3","Q4","Q5","Q6","Q7","Q8"],"series":[{"name":"A","values":[10,11,12,14,17,20,22,25],"unit":"亿元"},{"name":"B","values":[10,11,12,11,10,9,8,7],"unit":"亿元"}]}}],"completion":"complete"}
]
```

```bash
npm run eval:generative-ui -- --results /absolute/path/results.json
```

`surfaces` 必须包含整条回答的所有成功调用，不能只挑最好看的一个。
`surface` 单调用字段仍可读取，但不能与 `surfaces` 混用。
默认全36题，缺少任何结果会失败。只测部分题时，提供对应子集 `--cases /absolute/path/cases.json`。

从会话直接评测，先人工给出用户消息 entryId 到 caseId 的映射：

```json
{"user-entry-1":"delta-small","user-entry-2":"trend-divergence"}
```

```bash
npm run eval:generative-ui -- --session /absolute/path/session.jsonl --case-map /absolute/path/map.json --cases /absolute/path/cases.json
```

这里必须人工映射，不能用关键词猜测“标准答案”。不同重复运行应分别评测，重复 caseId 会报错，不能用后一个结果悄悄覆盖前一个。
未完成/中断回答不算合格纯文字答案。成功工具返回中的参数错误仍会在协议检查中被拒绝。

## 评测能与不能判断什么

- 自动：协议有效性、允许的表达形式/组件、缺失或多余组件、整条回答的叶组件预算、显式 explore、内置轮播/计算器交互。
- 不自动判断：事实正确性、证据支持、图表口径与数据是否真实、语义重复、视觉审美、全部浏览器交互行为、绿色溯源是否实际可点开。
- 人工：逐题检查“更容易理解了吗”，对绿色引用点击验收，复核单位/来源/不确定性；将错例加入语义对应的边界组。
- 不以“21种组件都出现过”评判好坏。某一组件偏多可能完全合理，应结合题目和证据看错用率。

## 生效范围

策略由 core 编译产物进入 web 会话初始化。更新 core 后需重新编译 pe-boot；已驻留内存的 AgentSession 可能仍用旧系统提示词。
安全重启空闲 web 服务后，重新发送问题/新建会话会加载新策略，旧回答不会自动重写。
离线测试通过只证明工程规则可执行，不代表真实模型的选型质量已经达到某个分数。
