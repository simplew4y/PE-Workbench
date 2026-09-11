# 用户系统可靠性修复（2026-09-11）

## 已完成

- [x] 删除会话只清理由真实会话头 cwd / id 推导出的自身附件目录，不再用聊天文本授权删除。
- [x] 软链接越界拒绝清理；任何存续 JSONL 损坏、不可读或含链接时保留附件；扫描包括活跃会话。
- [x] 分支引用的原会话附件保留。删除最后一个分支时，不再顺带清理属于原会话的目录：宁可留下孤立文件，不跨所有者删除。
- [x] 本地模式保留左下角设置上拉菜单，模型、技能、插件均有入口。
- [x] 显式桌面模式下，本地 API 与云账号服务可用性解耦，不改变 PE_USER_ROOT 或 .pi/agent/pe-workbench 数据位置。
- [x] 云端故障使用未过期本地会话的身份信息；401/403 不冒充离线认证成功。
- [x] 缓存的模型目录仅用于浏览与非计费初始化，不包含可用平台令牌。平台生成/压缩等命令单独授权，刷新模型元数据及凭证，保持当前会话的模型选择。
- [x] 后台模型档案包含来源、核验时间、区域、推理映射、输入模态、缓存价格、阶梯和时段费率。
- [x] Qwen / DeepSeek 的实际挂载配置已导入官方核验规格；上下文、推理能力、价格档位下发 Pi。
- [x] 网关统一 max_tokens / max_completion_tokens，按思考模式限制输出，用供应商 usage 的缓存量结算，请求开始时固定高低峰费率。

## 桌面模式的安全边界

本机 `.env.local` 已设置 `PE_DESKTOP_MODE=1`。使用 `npm run dev`（监听 127.0.0.1:30141），Windows 访问 localhost 即可。

这是单个操作系统用户拥有的桌面工作台，不是公网多租户服务。云账号用于平台模型、余额等云端能力；本地数据仍由该操作系统用户拥有。

**不要携带此开关使用 dev:lan/start:lan 或部署到公网。** 公网部署必须关闭 PE_DESKTOP_MODE，并另行设计每用户执行与文件隔离。原有 Host、Origin 和可选 PI_WEB_PASSWORD 检查未移除。

离线没有平台调用授权，用户必须显式切换为自定义模型才能继续推理；自定义模型的上游 API 本身也必须可达。完全断网需本地模型服务。

## 模型配置维护

服务器项目 `/home/PE_Workbench_backend`；真正生效的配置为 `/var/lib/pe-workbench/model-config/model_gateway.toml`，不是仓库中的示例文件。

后台“应用官方规格”使用 `app/model_metadata.py` 中带核验日期的规格快照，**不是实时抓取或自动每日同步**。目录只匹配准确的上游地址与模型 ID，第三方中转不能套用原厂价格。价格变更应先根据官方来源更新目录、测试，再导入。

- Qwen 北京区依据：https://help.aliyun.com/zh/model-studio/model-qwen3-max
- DeepSeek 依据：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
- DeepSeek 推理参数：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/

手动模型没有档案时沿用输入/输出固定单价；导入档案后按档案计费（包括缓存、长度分档、时段），上方固定价不覆盖档案。平台容量可主动调低，但不能超过档案中上游上限。公开原价不含供应商账户专属折扣。

Pi 会话费用是估算，后台结算为准，尤其是长会话跨越高低峰时段时。旧历史记录不重算。Qwen 在 Pi 中显示 off/high，其中 high 表示启用思考；DeepSeek 显示 off/low/high/max。

后端 `scripts/import_verified_models.py` 默认为预览，传入 `--apply` 才原子替换配置并产生备份。现有模型 ID、密钥引用保持不变。

## 验证与备份

使用临时目录、伪造服务响应和拦截后的 Pi 请求做回归，没有删除真实用户资料，没有发送付费模型测试请求。已检查真实浏览器中的未登录本地设置入口。

验证结果：前端相关回归 43 项通过，TypeScript / ESLint / git diff --check 通过；后台隔离容器全套 16 项测试通过，部署后模板渲染与公网 /health/gateway 检查通过。前端需重启一次开发服务，以更新热重载保留的全局运行时与新增缓存表。

服务器旧代码与配置备份：`/home/PE_Workbench_backend/backups/model-fix-20260911T0214/`。
旧镜像：`pe_workbench_backend-backend:before-model-fix-20260911`。
导入前配置另有同目录 `.before-verified-*.bak` 备份。回滚必须同时还原代码/镜像与配置，且先核对是否有之后的管理员修改。

本轮没有 git commit、push 或修改真实会话。Pi SDK 已支持所需能力，本次使用其现有接口，未改 SDK 源码。
