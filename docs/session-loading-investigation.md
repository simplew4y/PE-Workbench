# 会话慢加载排查与优化记录

2026-10-02，在 WSL Ubuntu-22.04 的 `/home/simpleway/PE-Workbench` 排查，基线为 `9161b4525fc03e58b8775dcc942056be3fd7ae84`。

已复现并修复一种确定的慢加载场景：分支导航树重复传输完整消息，绕过历史正文的思考和图片延迟加载。在合成的 24 分支图片会话中，响应由 8,396,693 字节降至 4,321 字节，受控 HTTP 加载中位数由 2,790.08 ms 降至 63.99 ms。该结论不等于已复现反馈用户的全部慢加载条件；原始问题没有提供具体会话或客户端性能轨迹。

## 加载链路与定位

1. 首次打开和切换会话：`useAgentSession.loadSession` 请求 `GET /api/sessions/[id]?deferThinking=1&deferMedia=1`，等待 JSON 解析后写入消息、消息 ID、当前叶节点及分支树，再解除加载提示。运行状态随后从 `/state` 获取，不阻塞正文显示。
2. 服务端优先使用存活会话的 SessionManager，否则解析文件路径并打开 JSONL；路径缓存未命中时扫描会话列表并解析项目归属。这里没有历史消息 SQL 查询。
3. 详情接口同时执行 `projectTreeForResponse(sm.getTree())`、`buildSessionContext` 和活跃时间计算，然后序列化整个响应。
4. 选择历史分支调用 `/context?leafId=...`，沿指定分支解析正文。向上滚动则扩大前端渲染窗口，默认显示最后 50 个渲染项，并不逐页请求服务器。
5. ChatWindow 目前仍先遍历历史构造渲染项，再截取窗口。它可能影响超长会话，但本次没有浏览器性能证据支持将其认定为已确认瓶颈。

根因位于 `apps/web/lib/project-tree.ts` 的节点复制：原来使用 `...node`，完整 `entry.message` 会随保留的根、分叉点和叶节点返回。压缩掉的节点虽然只留下预览，但保留节点的大段文本、thinking、toolResult 图片和其他负载仍留在导航树。即使当前分支正文很短，也会传输其他分支叶节点的图片。现有测试只验证压缩掉的节点，遗漏了保留节点。

修复让导航响应明确只携带节点 id/type、label/labelTimestamp、子节点、压缩节点 ID 和有界预览；完整正文继续由 context 提供。没有修改会话文件、上下文选择、压缩记录排序或消息 ID，也没有缓存可能过期的历史内容。BranchNavigator 类型同步接受精简节点，保持现有本地完整节点处理。

## 复现方法与测量口径

脚本：`apps/web/scripts/benchmark-session-loading.mjs`。

```bash
cd /home/simpleway/PE-Workbench/apps/web
node --experimental-strip-types scripts/benchmark-session-loading.mjs > /tmp/session-loading.json
```

脚本生成独立临时会话目录，使用固定种子的合成负载，退出时清理；不会读取真实会话、调用模型或使用凭据。每组分阶段和热请求测量 9 次；首次打开清空路径和列表缓存后测量 1 次。模块已加载，操作系统文件缓存未清空，所以首次测量不能解释为进程冷启动或冷磁盘。

另用本地 HTTP server 调用真实 GET 处理函数，开启 gzip，以 64 KiB 分块、20 Mbit/s 发送速率及每次 40 ms 请求延迟控制传输，完整接收并解析 JSON，每组 3 次。这是受控接口测试，不是浏览器点击到绘制完成的端到端计时；不含 Next.js 编译、中间件、登录和 DOM 渲染。

三组数据：

- 20 条交替的用户/助手纯文本消息。
- 5,000 条交替的用户/助手纯文本消息。
- 24 个从同一根节点分出的分支，每个分支含 64 KiB 合成 thinking 和 256 KiB 图片二进制的 base64 表示；实际活动分支只有 3 条消息。数据用于测量体积，不作为有效图片渲染。

原始结果保存在 [优化前数据](session-loading-benchmark-before.json) 和 [优化后数据](session-loading-benchmark-after.json)，包含全部样本、区间、正文哈希和消息数。

## 相同条件下的前后对比

单位为 ms；除首次打开外均为中位数。

| 场景 | 首次详情请求 前 → 后 | 重复详情请求 前 → 后 | 历史 context 前 → 后 | 受控 HTTP 前 → 后 |
| --- | ---: | ---: | ---: | ---: |
| 20 条纯文本 | 65.26 → 72.97 | 0.39 → 0.46 | 0.28 → 0.28 | 45.99 → 46.25 |
| 5,000 条纯文本 | 68.34 → 68.46 | 21.39 → 20.47 | 17.81 → 16.91 | 96.49 → 95.68 |
| 24 个图片分支 | 116.54 → 68.17 | 59.56 → 19.13 | 16.56 → 20.05 | 2,790.08 → 63.99 |

图片分支的受控 HTTP 样本：优化前 2,795.69 / 2,790.08 / 2,780.34 ms，3/3 超过 2 秒；优化后 64.10 / 61.22 / 63.99 ms，0/3 超过 2 秒。该条件下等待下降约 97.7%，不代表真实用户发生频率。

| 图片分支定位指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| JSON 字节数 | 8,396,693 | 4,321 |
| gzip 字节数 | 6,324,740 | 729 |
| 文件读取解析 | 16.59 ms | 19.57 ms |
| 导航树构造 | 0.09 ms | 0.10 ms |
| 正文构造 | 0.05 ms | 0.04 ms |
| 树和正文 JSON 序列化 | 30.57 ms | 0.02 ms |

主收益来自减少冗余序列化和传输，并不是提高磁盘速度或数据库查询速度。context 不携带导航树，未作优化，其耗时波动不能算作收益。纯文本对照没有明显改变。

另在临时开发服务观察到首次首页请求 26.3 s，其中 Next.js 编译 25.1 s、proxy 1,007 ms、application-code 194 ms。这里只测到一次，不能据此认定生产环境存在同样开销，也没有把它计入上述优化对比。

## 回归检查

- `npm run check` 完整通过：Biome、依赖及锁文件检查、Pi 类型检查、browser-smoke、19 处 workspace 解析、Web 类型检查和 ESLint。
- 以下 6 个定向文件共 61 项测试通过：

```bash
cd /home/simpleway/PE-Workbench/apps/web
node --experimental-strip-types --test \
  lib/project-tree.test.mjs \
  lib/session-reader.test.mjs \
  lib/chat-lazy-load.test.mjs \
  components/BranchNavigator.test.mjs \
  app/api/sessions/runtime-route.test.mjs \
  hooks/session-history-loading.test.mjs
```

新增测试覆盖根/分叉点/叶节点以及深度展平后的负载剔除、原始对象不被修改、导航预览和跳转目标、详情和 context 一致性、分支来回读取、正文顺序与 ID 唯一性、延迟内容的完整读取、500 错误响应。

将新增的导航树回归测试放到未修改 HEAD 的实现上运行，9 项中原有 7 项通过、新增 2 项失败；当前实现 9 项全通过，确认测试能捕获本次问题。

三组合成数据前后 context 的 SHA-256 完全一致，消息数分别为 20 / 5,000 / 3；每组重复请求均比较完整 context，并校验详情与历史接口一致。

额外执行 `hooks/useAgentSession.test.mjs` 为 21/23 通过。两个关于流式内容不显示在聊天区的源码断言失败；将未修改 HEAD 的测试及所读源码导出到临时目录后，同样是 21/23，失败项相同。本轮修改了加载回调，但未改动这些流式显示逻辑和断言；再次运行仍为相同的 21/23：
- delegates event stream readiness and keeps streamed content out of the chat
- tracks streamed tool execution progress without exposing it in the chat

Node 输出 SQLite experimental 和模块类型推断警告；这些不是本次类型或 lint 失败。

## 浏览器验收补充（2026-10-02）

在独立的临时项目和合成会话中完成实际浏览器验收。Next 开发实例仅监听 127.0.0.1:30142；测试代理监听 127.0.0.1:30143，向指定会话或分支注入延迟、HTTP 500。使用临时 PI_CODING_AGENT_DIR、PI_CODING_AGENT_SESSION_DIR、PE_USER_ROOT，本地单用户测试模式；未修改项目 .env 或真实用户会话，也未发送模型提示词。此前浏览器连接失败的问题已排除，本节取代此前“UI 待验收”的状态。

数据集为：120 条交替文本消息的 accept-history、4 条消息的 accept-switch、6 条消息的 accept-slow、4 条消息的 accept-error，以及共享根节点的 3 分支 accept-branches。各分支具有独立的 QUESTION / ANSWER / THINKING 标记。

### 验收发现并修复的第二个问题

先点分支 0，再立即点分支 1；代理对 a0 的 context 请求延迟 4 秒，a1 不额外延迟。修复前 a1 在 2,729 ms 返回、a0 在 4,040 ms 返回，正文最终回退为 BRANCH ANSWER 0，与用户最后选择的分支 1 不一致。该场景实际复现 1/1；不是发生频率统计。

根因：useAgentSession.loadContext 无请求顺序、组件存活和会话身份检查，迟到请求无条件覆盖 messages / entryIds；失败仅打印日志，叶节点却已提前更新。

修复使用详情和分支请求共享的递增请求编号，仅允许当前会话、仍挂载组件的最新请求提交状态。分支请求显示加载提示，成功后一起更新正文、消息 ID 和叶节点；失败显示错误，重试成功清除错误。只有成功且仍有效的请求会提交 navigate_tree，避免迟到请求反向修改后端叶节点。卸载时使旧请求失效。网络请求本身未取消，本次保证的是显示与导航状态正确。

新增 9 项行为回归通过，使用 TypeScript AST 提取并执行实际加载回调、控制 fetch 完成顺序，覆盖成功乱序、迟到失败、loading 所有权、失败重试、详情与分支交叉、卸载/会话变化以及延迟 state 响应。相同测试在未修改 HEAD 实现上为 0/9，在修复后为 9/9；原始输出保存在验收目录。

### 浏览器验收结果

| 验收项 | 操作与依据 | 结果 |
| --- | --- | --- |
| 首次打开 | 进入 120 条消息会话，末条 ANSWER 059 正确，初始渲染 50 条、提示隐藏 70 条 | 通过 |
| 普通会话切换 | accept-history 与 accept-switch 往返 3 轮；短会话 4 条内容正确，返回历史后窗口恢复 50 条 | 通过 |
| 历史滚动加载 | 上滚依次显示 50 → 100 → 120 条，隐藏提示 70 → 20 → 消失 | 通过 |
| 历史完整性 | 从 DOM 提取全部 120 条消息，unique=120，并逐条校验 QUESTION/ANSWER 000…059 的交替顺序 | 通过，无缺失、重复或乱序 |
| 慢会话中切换 | accept-slow 详情注入 5 秒延迟，期间有“正在加载会话...”提示；切至 accept-switch 后内容正确，旧请求 5,050 / 5,055 ms 返回后仍保持当前会话 | 通过 |
| 会话详情异常 | 详情注入 HTTP 500，显示 Error: HTTP 500；解除故障后重新选择，4 条消息正常恢复 | 通过 |
| 分支快速切换 | a0 延迟 4 秒，先点 0 再点 1；修复后先复测 1 次，再重复 3 轮，全部在两个响应结束后保持 ANSWER 1 | 通过 |
| 分支加载与异常 | 分支加载提示可见；a0 注入 HTTP 500 后明确显示错误，解除故障、重新选择 a0 后恢复 ANSWER 0 | 通过 |
| 延迟思考内容 | 展开“查看处理过程”及“思考”，出现加载提示，随后显示 BRANCH THINKING 1，同时正文保持 ANSWER 1 | 通过 |
| 类型、lint 与回归 | 完整 npm run check 退出 0；本次相关 61 项测试通过；另有已确认的 2 项基线静态断言失败 | 本次检查通过，基线失败保留 |

修复后三轮乱序请求，a1 分别在 49 / 68 / 61 ms 完成，a0 分别在 4,052 / 4,542 / 4,074 ms 完成；最终 DOM 三次均为 ROOT、QUESTION 1、ANSWER 1，加载提示三次均可见。见 [三轮结果](session-loading-acceptance/branch-race-after.json) 和 [代理请求记录](session-loading-acceptance/network.jsonl)。

### 浏览器计时口径

浏览器计时在自动化端从“开始点击”到“确认指定末条正文可见”，含工具往返、开发编译及 React 开发模式开销，**不是 performance trace / 纯绘制时间**，不与前述受控 HTTP 指标混算：

- 首次进入 120 条会话观察到 2,533 ms（1 次，开发模式，不作为生产 SLA）。
- 第一轮直接访问开发实例的三次短会话切换为 341 / 287 / 423 ms，返回历史为 354 / 352 / 307 ms。
- 最终修复后、经过测试代理的三次短会话切换为 1,598 / 854 / 887 ms，返回历史为 869 / 1,109 / 933 ms。两组环境和开发编译状态不同，不能用它们声称优化或退化；最终一组的详情代理耗时为 56–249 ms。
- 5 秒慢请求尚未完成时，切换到另一会话确认正文可见用时 1,272 ms，旧响应到达后内容保持正确。

可复用的严格优化前后比较仍以前述固定数据、相同限速条件的 HTTP 基准为准。没有取得原反馈用户的会话和浏览器性能轨迹，不能宣称所有线上慢加载成因均已排除。

### 复测步骤及证据

1. 在独立临时用户目录生成上述文本/分支 JSONL，启动本地开发实例，在 UI 建立临时项目，将会话 header.cwd 设为该项目目录，再刷新会话列表。
2. 打开历史会话，检查末条，再滚动至顶部两次触发窗口扩展；比对 120 条标记消息的数量、唯一性、顺序。
3. 普通会话往返三轮，再对 slow 详情注入 5 秒延迟，加载期间切换，等待旧响应结束。
4. 对详情及分支分别注入 500，检查错误显示；解除后重新选择，检查恢复。
5. 对 a0 context 注入 4 秒延迟、a1 不延迟；连续点击 0、1，等待两个请求完成，确认选中分支及正文均为 1；重复三轮。
6. 展开分支的处理过程和思考，确认延迟内容仍完整可读。

证据均位于 [session-loading-acceptance](session-loading-acceptance/)：
[历史完整性数据](session-loading-acceptance/history-completeness.json)、
[切换耗时及内容](session-loading-acceptance/session-switches.json)、
[加载提示](session-loading-acceptance/loading-indicator.jpg)、
[修复前乱序覆盖](session-loading-acceptance/branch-race-before.jpg)、
[修复后分支状态](session-loading-acceptance/branch-race-after.jpg)、
[分支异常](session-loading-acceptance/branch-error.jpg)、
[异常恢复](session-loading-acceptance/branch-error-recovered.jpg)、
[思考加载完成](session-loading-acceptance/thinking-loaded.jpg)。

本轮受控场景验收通过。临时服务和数据在结束时清理，修改留在工作区，未提交 Git。针对原始用户反馈的实际发生频率及其他触发条件，仍需真实会话样本确认。
