# PE 文档处理与引用

PDF 和 Excel 使用同一份文档目录，分别进入各自的处理链路：

```text
PDF 上传 → 原件 → Node worker / PDF.js → 页面、图片、FTS
         → pe_pdf_list / pe_pdf_search / pe_pdf_read → page: 引用

Excel 上传 → 不可变原件版本 → 后台准备 → Python openpyxl
           → Node 发布解析表与缓存 → 六个财务工具 → source: 引用

已有文本 / CSV / DOCX / PPTX → pe_document_open 按需生成文字视图
                          → 原生 read / grep → source: 行号或块位置
```

Web 研究上传支持 PDF、XLSX 和 XLSM。Agent 的通用文件读取能力继续保留。
PDF 使用既有 Node 解析和检索实现；Python 负责 Excel 与其他 Office 文件读取。
Excel 工具共享同一个准备服务；上传后台和 Agent 同时读取时不会重复发布或相互覆盖。
解析在 SQLite 写事务外完成，再通过短事务发布缓存。

## 工具

- `pe_pdf_list`、`pe_pdf_search`、`pe_pdf_read`：先列出项目内 PDF 及封面元数据，再按字面词做 grep 式定位（按文档和页序列出全部命中页，不排序，disclosure 页折叠），最后使用 `doc_id` 精确读取当前或历史版本的页面证据。
- `pe_document_open`：取得 Excel、文本或 Office 文件的 `readable_path`，供原生 `read`、`grep` 或 `bash` 中的 `rg` 使用。
- `pe_workbook_inspect`、`pe_excel_range`、`pe_formula_trace`：检查工作簿、精确取数、追踪公式。
- `pe_valuation_output_locate`、`pe_valuation_date_resolve`、`pe_model_validate`：完整保留主分支估值规则及核验语义。
- `pe_source_detail`：使用与 Web 预览相同的解析器，核验固定版本及位置。

完整的 `valuation-model-explainer` Skill、Memo、Research Note 和生成式 UI 均保留。
Memo 与 Research Note 同时接受 PDF 页面和 Excel 位置证据。
公式缓存值不表示公式已重新计算，宏也不会运行。

## 安装

使用 Node.js 22.19 或更高版本、Python 3.9 或更高版本。在 Core 根目录执行：

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run setup:python --workspace=@earendil-works/pe-boot
```

默认创建包内 `python/.venv`，依赖版本固定。也可配置 `PE_EXCEL_PYTHON`，
或沿用 `PE_DOCUMENT_PYTHON`，指向已安装依赖的解释器。
虚拟环境不随 npm 包发布。Web 必须使用匹配的 Core 版本。

## 版本与证据

同名、同内容的当前版本复用；内容变化创建新版本并保留旧原件。
新版本准备失败时保留失败状态，不会静默改用上一版。
`source:` 引用绑定文档版本及位置；旧 `cell:`、`fact:` 位置通过持久映射恢复。
缓存缺失或损坏时从固定版本原件重建；原件被篡改或跨出项目目录时拒绝读取。

数据库结构由 `collection-schema.ts` 统一管理，Web 通过包导出复用。
升级和回滚前应备份项目数据库及原件；迁移范围、安装步骤和验证结果见
[INTEGRATION.md](./INTEGRATION.md)。
