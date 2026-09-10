# Main 能力选择性迁入 rebuild

## 基线与范围

首轮开发在独立工作树的 `codex/migrate-main-capabilities` 分支完成。随后按用户要求，已将本次 48 个修改和新增文件迁回 `/home/code/PE-Workbench-pi` 与 `/home/code/PE-Workbench-pi-web`，两个原目录均切换到 `rebuild_pipeline/search`。临时工作树保留备份；未合并、变基或 cherry-pick Main 提交。

- Pi 基线：`f97860735b4a81d34c3f4772bfe615a275e804ac`。
- Web 基线：`83fa9f3667859ddc62b026a738887381cd28bcce`。
- Main 行为参考：Pi `ce77f288a24477adbad968980c24201679026400`；Web `1806aee067647036f958a1ada5b02af338ef8cd4`。
- 首轮迁入时 fetch 超时，以上记录为当时的本地引用；2026-09-09 已重新成功拉取两个仓库。
- Main 分支历史未修改，没有将 Main 整体合入 rebuild。浏览器测试文件不纳入本次提交。

## 2026-09-09 远端更新适配

- 两个原仓库均在 `rebuild_pipeline/search`，先备份未提交修改，再执行 `git merge --ff-only origin/rebuild_pipeline/search`。
- Pi 合入 5 个提交，更新到 `2d3cfe5f7`；Web 合入 2 个提交，更新到 `641ed7e`。
- 保留新增的估值报告分组、公式单位推断、报告文字定向修复、存储错误保留、失败上传清理和项目存储目录重定位支持。
- 文件名使用 NFC 保留合法 Unicode 标点，仅将 Windows 非法 ASCII 标点映射为全角字符。重复和版本身份仍使用 NFKC 统一名称；不重命名既有文件，不改变路径越界校验。
- 选择性适配 Main 的共识开关（Pi `032185ceb`、Web `e886313`）：默认关闭工具注册、系统提示词入口、上传后观点分析和共识 API。未导入旧 Chunk Pipeline。
- 共识关闭时在访问数据库、获取分析锁或启动 Python 前返回；保留原有分析取消、超时、父进程退出和失败快照保护。

## 已迁入

- PDF 双栏、侧栏、封面标题、券商、日期、评级、目标价、Exhibit 和页面角色规则；项目资料同时显示报告标题与原文件名。
- `pe_pdf_list`：列举当前 PDF，可显式包含历史版本。
- `pe_pdf_search`：字面关键词检索，按文档和页码返回命中行；不按相关度排名。默认 40 页、最多 200 页，通过 `next_page_offset` 继续。免责声明页可展开。
- `pe_pdf_read`：一次最多 10 页；自动或显式读取页图。最多附加 3 张、合计 10 MiB，检查工作区边界与模型图片能力。结果区分实际附加图片和未附加原因。
- PDF、Excel 共用可移植文件名标点处理，不重命名既有资料。
- 独立的机构观点提取、22 项基础分析清单、新问题归并、机构识别、数值归一化、观点修订链、项目样本共识/分歧。
- 开启共识功能后，`pe_consensus_cards` 和 `GET /api/pe/consensus?datasetId=...` 共用只读结果读取器，返回覆盖情况、生成时间、过期状态和可选页面引用/引文。关闭时 API 返回 404。

保留 rebuild 的 Excel 解析、估值工具与报告约束、文件版本与历史引用、大文本预览、请求来源校验、Qwen 兼容及 Markdown 展示。没有迁入旧 Chunk Pipeline 或多用户代码。

## 2026-09-10 feature 分支再次整合

本次不是合并 Main 历史。两个原目录始终保持 `rebuild_pipeline/search`，按现有运行链路重写适配；未提交、未推送。

- Pi 参考 `feature/consensus-divergence-schema`：`cfe8f0487e8df97b00b42ac922959ddab1ef6037`。
- Web 参考 `feature/consensus-divergence-ui`：`d6a1fc10d2effd349e13ca903f5cbf1c8bac0599`。
- 直连 GitHub 超时后，使用本机现有代理执行只读 `ls-remote`，确认上述引用就是当时远端最新提交；没有修改代理配置。

### 行为映射与取舍

| feature 代码 | rebuild 接入方式 |
| --- | --- |
| AtomicClaim/Card 类型、机构聚合辅助函数 | 沿用已经落地的原子观点、机构身份和快照表；不覆盖 SDK 的共享只读 `consensus.ts`，不引入第二套同名模型 |
| 中位数、均值、区间、IQR、MAD | 去重与常规统计复用现有逻辑；把 IQR/MAD 接入实际 Python 卡片生成器，统一使用同一组单位、币种、口径可比样本 |
| 机构一票、立场比例、未提及机构 | 同一机构按观点日期、创建时间和稳定 ID 取最新观点；记录立场样本 ID、比例及没有已核验观点的机构，不把未提及算成反对 |
| 通用及动态 Checklist | 保留现有 22 项基础清单、动态问题归并和持久化。两家机构/不同证据的解释门槛写入 Skill；不把单份资料的发现删除掉 |
| 共识 Skill | 新增 `pe-consensus-divergence`，实际调用 `pe_consensus_cards` 读取已计算结果并核对页证据；与工具使用同一个开关 |
| 前端卡片与侧栏 | 新增共识面板，读取 50 张卡并显式请求来源，展示期间、统计、双方理由、公司指引、覆盖/过期状态及可点击原文 |

feature 的新计算函数尚未被其实际上传/工具流程调用；其中 `peConsensusBuildTool` 只是旧名称兼容别名，Skill 提到的 `pe_consensus_build` 并未注册。本次没有复制无调用链的第二套接口，也没有声称实现其尚未落地的候选审核、激活及历史回填管理功能。

新增统计保存在现有 `consensus_cards.stats_json`：`iqr/mad` 及显示文本、`sample`（机构总数、立场样本数、计票 claim IDs、比例、未找到观点的机构）。核心 collection Schema、PDF 页、原文件、FTS 和引用均不变。卡片生成器版本升为 `pe_consensus_cards_v2`；旧快照不自动触发付费重算，下一次正常观点分析会补齐新统计。

保留并补回“计算放在函数里，这样按开关关闭的工具不会出现在提示词中”等说明。另说明只读刷新不触发分析、失效引用不开放预览、项目切换取消旧请求及卸载旧卡片。没有恢复已删除的 `PE_PRESENTATION`。

### 验证与手动验收

- Pi 4 个定向文件 33 项测试、`npm run check`、Skill 校验通过。
- Web 共识请求、组件渲染、API、分析 Worker、国际化等 20 项测试通过；Python 分析 18 项测试通过；Web lint 通过。
- Web `tsc --noEmit` 剩余原有 7 处 `lucide-react` 类型声明缺失错误。本次不安装依赖，不用空类型声明绕过。
- 未启动开发服务器或浏览器，未调用真实模型，未修改用户数据。
- 开启 `PE_CONSENSUS_ENABLED=1` 后重启 Web：项目资料下方可展开“共识与分歧”；已有快照无需新模型请求即可读取。验证项目切换、展开机构来源、点击页引用、刷新和过期提示。TUI 可使用 `/skill:pe-consensus-divergence`。
- 关闭开关后重启：共识工具、系统提示词入口、Skill、API、分析均不可用，面板隐藏；其他检索和生成能力保持原样。

## PDF 解析与观点分析是两层

PDF → 页文本、Markdown、布局和图片：仍是本地 PDF.js 脚本，不调用模型。

观点分析：上传批次至少成功入库一份文件后，优先处理新 PDF，再补扫当前项目尚未完成的 PDF。Excel 不进入这条观点提取链。

- Node 负责项目锁、子进程、心跳和超时；Python 3.10+ 标准库负责独立分析，代码在 `services/pe-analysis/`。
- 只读已经入库的 `pdf_pages`，不重新解析 PDF，不创建 `chunks/chunk_locations`。
- 模型请求中的“窗口”只是临时合并多页的请求批次，不是持久化文本 Chunk。
- 核心 collection Schema 仍为 v4，由 pe-boot 管理。分析使用独立版本号的附加表：`analysis_checklist_items`、`checklist_proposals`、`issuers`、`document_issuers`、`atomic_claims`、`document_scans`、`consensus_cards`、`pe_analysis_metadata`、`pe_analysis_windows`。
- 默认跳过观点分析；显式开启共识且配置模型后才执行。分析失败不撤销已经完成的文档入库。

## 配置

在启动 Web 的服务端环境或 `.env.local` 中配置，不能使用 `NEXT_PUBLIC_`：

```dotenv
# 共识总开关，默认关闭。需要此能力时改为 1，并重启 Web；TUI 需设置同一环境变量。
PE_CONSENSUS_ENABLED=0

# 独立于聊天界面的模型设置。未填写 URL/Key 时跳过观点分析。
PE_INGEST_LLM_BASE_URL=https://your-compatible-endpoint/v1
PE_INGEST_LLM_API_KEY=your-key
PE_INGEST_LLM_MODEL=your-model

# 可选：设为 1 完全关闭观点分析；PDF/Excel 解析照常执行。
PE_INGEST_ANALYSIS_DISABLED=0

# 可选：指定 Python。否则优先复用 pe-boot 的虚拟环境，再寻找系统 Python。
# PE_INGEST_ANALYSIS_PYTHON=/absolute/path/to/python

# 默认值：单次请求 600 秒、最多尝试 3 次、整次分析 1800 秒。
PE_INGEST_LLM_TIMEOUT_SECONDS=600
PE_INGEST_LLM_MAX_ATTEMPTS=3
PE_INGEST_ANALYSIS_TIMEOUT_SECONDS=1800

# 默认每个请求约 20000 字符，每文档最多 12 个请求窗口。
PE_INGEST_SCAN_WINDOW_CHARS=20000
PE_INGEST_SCAN_MAX_WINDOWS=12

# 可选的供应商参数，JSON 对象；不得覆盖 model/messages 等核心请求字段。
# PE_INGEST_LLM_EXTRA_BODY={"enable_thinking":false}
```

未设置模型名时沿用 `private-fund-default`。开启共识并填写真实模型配置后，分析会把 PDF 页文本发送到指定服务，并可能产生费用；本次测试仅使用本地模拟服务，没有调用真实模型。

## 正确性边界

- 每条保留观点必须有当前请求中的真实 `page:` ID 和能在该页找到的引文；数值、期间、单位不匹配的内容不能进入数值统计。
- 已核验表示“引文存在、结构校验通过”，不代表预测一定实现，也不能保证模型对表格列、语义和机构身份的理解完全正确。
- 不同币种、单位或明确口径不直接求平均或建立数值修订关系；公司指引与机构样本分开。
- 中位数、区间和数量由程序计算，模型不能覆盖这些字段；叙述中的新增数字会被拒绝。
- 超过扫描上限、存在未扫页或待 OCR 页时，覆盖状态为不完整，不发布为完整新结果。提高上限后，下一次上传成功时补扫尚未完成窗口。
- 文本、版本、提取器或窗口划分变化会使相应窗口失效；成功窗口可复用。失败重试不会提前删除旧观点。
- 共识结果整批事务发布。失败保留上一份完整快照；资料变化、正在分析或分析失败时将旧快照标记为过期，不能称作最新观点。
- 这里的“共识”仅代表当前项目的资料样本，不是全市场一致预期。首轮没有专用前端；2026-09-10 已接入侧栏卡片，见上文。

## 验证记录（2026-09-07）

- 迁回原目录时对 48 个文件逐字节校验一致；迁回后再次通过 54 项 Pi 定向测试。下列完整验证记录来自首轮迁入工作树。
- Pi 12 个定向 Vitest 文件，178 项通过，包含 PDF、Excel、Memo、研究笔记、估值报告与保护逻辑。
- Web 65 项定向 Node 测试通过，包含解析、混合 Worker、检索引用、API、并发、超时及进程退出。
- Python 分析测试 13 项通过。
- 复制原阳光电源电话会 PDF 到临时项目：21 页 PDF + Excel 入库、Markdown/布局/图片、页面检索、Excel 公式溯源、模拟模型生成共识完整通过；原始资料未改动。
- Worker 定向编译、pe-boot 定向编译、Web lint、Git diff 空白检查通过。
- 未运行完整 build 或完整测试套件，未做浏览器视觉验收。

尚未通过的全局检查：

1. Pi `npm run check`：既有 AI 测试对 `workers-ai/@cf/moonshotai/kimi-k2.6` 的 9 处引用与模型目录类型不一致。AI 源码和测试本轮无修改，不在此迁入中重写模型目录。
2. Web `tsc --noEmit` 与 `MarkdownBody.test.mjs`：现有依赖缺少 `@streamdown/cjk`、`streamdown`、`remark-cjk-friendly-gfm-strikethrough`，且 `lucide-react` 类型文件缺失。先由用户在该工作树执行 `npm install --ignore-scripts` 补齐已声明依赖，再重跑；不添加空类型声明绕过问题。

## 合并后复测（2026-09-09）

- Pi 14 个定向 Vitest 文件 213 项通过；增加默认关闭/显式开启共识的 6 项测试后，相关 3 个文件 28 项复测通过，合计覆盖 219 项。
- Web 16 个定向 Node 测试文件 67 项通过，包含新存储错误、Unicode 名称和共识开关。
- Python Excel 7 个文件 63 项通过，观点分析 13 项通过。
- 真实 PDF 只读复制到临时项目，与 Excel 一同上传：21 页入库成功、分析完成、生成 1 张测试共识卡；2 次模型请求均发往本地模拟服务。
- pe-boot 与上传 Worker 定向编译、Web lint、Pi browser-smoke 检查和 Git diff 空白检查通过。未运行完整 build、完整测试套件或真实付费模型。
- Pi 全仓类型检查仍有原先的 9 处 Cloudflare 模型缺项错误；已用生成器刷新忽略的 JSON 模型数据，未改生成的 TypeScript 文件，错误仍然存在。
- Web 类型检查已不再报告 Markdown 依赖缺失；剩余 7 处错误均来自本机 `lucide-react@1.40.0` 包缺少其声明的 `dist/lucide-react.d.ts`。本次未安装依赖、未添加空类型声明。

## 复测入口

两个仓库必须保持相邻目录名 `PE-Workbench-pi` / `PE-Workbench-pi-web`，因为 Web 使用本地 workspace 依赖。

```bash
# Web 工作树：只编译上传 Worker，不运行 Next build。
node scripts/build-pe-ingest-worker.mjs
node --test lib/pe-ingest/analysis.test.mjs app/api/pe/consensus/route.test.mjs
python3 -m unittest discover -s services/pe-analysis -p 'test_*.py' -v

# 可选真实文档冒烟：文件只读，临时新建项目，使用本地假模型。
PE_MIGRATION_SMOKE_PDF=/absolute/path/to/sample.pdf \
PE_EXCEL_PYTHON=/absolute/path/to/excel/python \
node --test lib/pe-ingest/migration-smoke.test.mjs
```
