# Research UI — 独立验收组件

独立演示入口：`/research-ui-preview`。主系统通过 `PeFrameworkPanel` 适配真实数据；组件本身仍保持独立。

组件依赖 React 和同目录 CSS Module；没有 Next、Pi、数据库、网络请求或外部框架运行时依赖。复制这个目录即可带走组件；测试需要宿主已有的 TypeScript 和 react-dom。

- `FrameworkConfirmation`：受控 status、onConfirm、可选 preview/error。宿主负责同步切换 pending 和请求去重。confirmed 只表达正式保存成功，不代表 Agent 已继续执行。
- `ResearchRail`：宿主提供唯一 ID 的 artifacts、selectedId 和 onSelect。内容及操作均接受 ReactNode；父容器需要 `position: relative` 和限定高度。null 收起面板，方向键切换，Escape 收起。
- `ArtifactVersions`：versions 按旧到新排列，selectedId 仅表示浏览位置，不修改正式版本。

样式优先使用当前工作台 CSS 变量，并提供独立使用的默认值。演示控制和 900ms 模拟请求只存在于演示页。刷新会重置模拟数据。

## 来源与复用边界

此版本是根据现有工作台组件抽离并重新编写的 React 实现，没有复制下列项目的源码，因此没有伪称已移植其运行时，也没有引入其依赖。保留固定来源，后续若直接复制代码，必须同时带入对应 MIT 版权及许可原文。

| 参考 | 固定提交 | 采用的交互 |
| --- | --- | --- |
| [DeerFlow](https://github.com/bytedance/deer-flow/tree/f17ca3777a1c14b40374f8c496f3f0cd8a54d487/frontend/src/components/workspace/artifacts) | f17ca377 | 成果选择、阅读面板开关；由宿主控制自动打开 |
| [Open Canvas](https://github.com/langchain-ai/open-canvas/blob/0310cecd51f31b3d37a52d6d1060137da3405280/apps/web/src/components/artifacts/header/navigate-artifact-history.tsx) | 0310cecd | 前后版本浏览与边界禁用 |
| [CopilotKit](https://github.com/CopilotKit/CopilotKit/blob/06b8901d4f69a8c76bd0311520ba78a37e196b3a/packages/react-core/src/v2/hooks/use-human-in-the-loop.tsx) | 06b8901d | 确认状态与交互回调分离；未复制 Promise Hook |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui/blob/8b8619dcce970959afe30a265dac29c5c172c84a/packages/core/src/runtimes/external-store/external-store-adapter.ts) | 8b8619dc | 外部持有状态；未引入 ExternalStoreRuntime |

检查：`node --test components/research-ui/ResearchUI.test.mjs`。

已接入：服务端发布、同事务确认记录、原会话续接和失败重试。宿主先连接 SSE，再提交续接；状态不明确时不自动重放。参考仓库保留到用户完成主系统验收之后。
