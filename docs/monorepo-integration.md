# 单仓库整合记录

## 基线及边界

- Web：`74b38c43594df341359e7fa9fc851bd2127c47ca`，作为产品历史主线。
- Pi：`041d3bfeff4ad15448f81f139fb14b6bce8eaed4`，通过双亲 merge 导入完整可达历史。
- 整合在 `integration/monorepo` 完成后，按用户要求改用新仓库 `main`，作为团队开发入口。
- 原仓库、原服务、真实用户目录没有迁移或修改；仅推送新仓库，不进行 npm 发布。
- 没有迁入 npm-distribution 分支，没有更改业务算法、Schema、提示词或聊天结果展示策略。

提交分为 Web 目录迁移、Pi 历史合并、单仓库适配。不要 squash 或重写导入历史。
原 PR、Issue、评论仍到旧仓库查看。

## 工程入口

根目录沿用 Pi 工程结构，`apps/web` 保留 Next.js 应用自己的配置。
根 npm workspace 管理 Pi 所有原有包、嵌套后端、示例和 Web，使用一个安装锁。
保留 Pi coding-agent 的独立 shrinkwrap/install-lock，它们不是重复的开发安装锁。

Web 继续通过 SDK 调用 pe-boot；Node 专用依赖保持外部化。
根命令转发到 Web workspace，因此应用和 Worker 的 cwd 不会变成仓库根。
Turbopack 默认开发、Webpack 备用开发与生产构建保持不变。

命令见根 README。原生 Pi 用 `scripts/pi-native.mjs`；
三个 `pi-test` 脚本统一进入 PE TUI。原 Windows 脚本原先进入原生 Pi，
现与 Bash 脚本对齐；原生 Pi 功能仍可通过专用入口和原有 CLI 使用。

Pi 的同步版本、清理、测试编排限定在原 Pi workspaces，Web 不参与 Pi 版本递增。
同步版本时会更新 Web 对内部 Pi 包的依赖，但不改变 Web 自身版本。
自动发布和上游机器人 YAML 保存在 `docs/upstream-workflows`，不在 Actions 自动执行。
保留的手工 release 脚本具有发布、提交、推送能力，未经授权不得运行。

## 本地配置与测试隔离

Web 配置位于 `apps/web/.env.local`，以同目录 `.env.example` 为模板。
未复制开发机配置、密钥或用户数据。云登录配置仍需遵循当前 main 的要求，
本轮没有引入发行分支的自动初始化。

测试使用 `PI_CODING_AGENT_DIR` 指向临时目录、单独端口 30142；
桌面页面冒烟显式设置 `PE_DESKTOP_MODE=1` 和 `PE_MULTI_USER_MODE=0`，
只影响测试进程，不是产品默认值。没有使用真实账号或付费模型。
Python 测试使用本机已安装的 Python 3.14.4 / openpyxl 3.1.5 / PyMuPDF 1.28.2；
没有复制旧虚拟环境。新机器仍需执行 Python setup。

## 验证结果（2026-09-27）

通过：

- 干净 `npm ci --ignore-scripts` 安装；Pi 与 Web 原锁文件中的 registry 包版本保持不变。
- Pi 全套离线构建、上传 Worker 编译、19 处内部包依赖定位。
- 新增整合与版本同步测试 5 项；Web 核心定向测试 24 项。
- Session、模型缓存、授权、账号存储、聊天附件管理测试 39 项。
- 扩展回归组 30 项中 25 项通过，包含中文 PDF/Excel 入库与来源读取、生成式 UI。
- pe-boot 定向测试 43 项中 41 项通过，涵盖 Memo、Research Note、能力加载与提示词。
- Web ESLint、Pi Biome/依赖固定/TS import/shrinkwrap/install-lock 检查、浏览器打包检查。
- Playwright：创建中文项目，项目、文件、模型接口可达，四个研究栏目显示，Memo 面板展开。
- 原生 Pi 和 PE TUI 在 tmux 中启动，cwd 为仓库外临时目录，PE 包内 Skills/扩展正常加载。
- Windows PowerShell 入口语法解析通过；没有复用 Linux 依赖执行 Windows 原生测试。

既有阻塞与限制：

1. 在线 `hydrate:model-data` 失败：上游数据缺少 `kimi-coding`。本机离线构建使用了
   原 Pi 工作区的公开 provider JSON 和 manifest，经 `check:model-data` 验证通过；
   它们未提交。全新机器仍有模型数据准备阻塞，不能声称开箱即用。
2. Pi 全量类型检查：`packages/ai/test/stream.test.ts:707` 使用的
   `claude-sonnet-4-5` 不在当前生成类型中；包内源码及测试均与基线一致。
3. Web 全量类型检查：股票追踪 API 有 4 处 `selected_output` 类型错误，与迁移前一致。
4. Web 扩展测试有 5 处失败：两处混合上传旧表断言、一处历史 Excel 旧表断言、
   两处模拟股票追踪任务。用原始 Web 基线副本和同一依赖环境重跑，复现相同 5 处失败。
5. Memo/Research Note 各有一处测试仍期待旧 Skills 列表；当前实际新增 Skills 未被测试列入。
   不通过删除 Skills 或更改业务来修复这些基线测试。
6. 未启用共识时，页面仍请求共识接口并收到 404，这是保留的现有前端行为。
7. Node 22 安装会提示 Gondolin 示例要求 >=23.6；完整 workspace 推荐 Node 24。
8. 未运行完整测试套件；生产 Web 构建、完整真实账号/浏览器聊天/SSE、
   Windows/macOS 原生运行、跨平台发行未验收。本轮不能作为发行验证完成。

检查失败保持可见，不禁用类型检查、不忽略测试。新 CI 也会暴露这些基线阻塞，
应通过后续独立修复处理。

## 文件完整性

Pi `packages/` 下 1,489 个受控文件与锁定提交一致，没有裁剪任何包、Skills、
运行资源或示例。Web 只移入 `apps/web` 并适配依赖、资源定位和少量测试路径。
唯一移除的原受控文件是 Web 独立 package-lock，其内容已纳入根锁文件。
原 Pi README 和所有原工作流均保留到 docs；许可文件分别保留于根目录及 Web 应用目录。

用户已确认保留上述基线检查问题提交并推送；后续独立修复检查阻塞、完成目标平台验收。
npm 发行分支的迁入另行实施。
