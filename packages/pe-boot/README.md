# PE 文档读取与引用

上传只保存原件和版本目录，不解析文件、不分块、不建立全文或向量索引。

```text
上传 → raw/ 原件 + documents 版本记录
提问 → pi ls/find 选择文件 → pe_document_open
     → pi read/grep 读取带来源链接的文字视图
回答 → 文件版本 + 页码/单元格/行号/段落位置
点击 → Agent 与 Web 共用 resolvePeEvidenceSource → 右侧原文预览
```

## 工具复用

| 工作 | 实现 |
| --- | --- |
| 查找文件、读取文字、搜索内容 | pi 原生 `ls`、`find`、`read`、`grep`；默认工具集也可用 `bash` 执行 `rg` |
| PDF 文字与页码 | PyMuPDF；预览沿用浏览器 PDF 查看器 |
| Excel 值、公式、格式、工作表 | openpyxl；保留现有公式引用和日期解析 |
| Word 段落、表格与 PPT 页 | 现有 OOXML 读取代码，复用 Python 标准库 |
| 范围取数、公式追踪、估值输出/日期及校验 | 保留 PE 财务工具，在首次读取指定文档时准备缓存 |
| 来源协议及 Excel 坐标 | `@earendil-works/pe-boot/source`，浏览器和服务端共用 |
| 上传登记、按需读取和来源定位 | `@earendil-works/pe-boot/documents`，Web 与 Agent 共用 |

没有引入 RAG 框架、向量数据库或另一套通用搜索工具。删除了 `pe_dataset_search`、同义词扩展和评分、上传任务队列与轮询、整目录 ingestion、文档分类及摘要分块，以及 Web 重复的来源解析器。

公开参考：[pi SDK 工具接口](https://pi.dev/docs/latest/sdk#tools)、[OpenAI 引用格式说明](https://developers.openai.com/api/docs/guides/citation-formatting)。本实现对齐工具驱动读取与位置引用的思路；不依赖 Codex 桌面端的内部实现。

## 运行

在仓库根目录安装一次 Python 读取依赖，需要 Python 3.10 或更高版本：

```bash
PE_DOCUMENT_PYTHON=python3.13 bash packages/pe-boot/python/setup.sh
```

默认使用包内 `python/.venv`。部署环境可设置 `PE_DOCUMENT_PYTHON` 指向已安装 `python/requirements.txt` 依赖的解释器。JS 包随附 Python 读取代码，虚拟环境不发布。

`pe_document_open` 接收 `path`（上传文件名或 `raw/` 路径）或 `doc_id`，返回 `readable_path`。原生文件工具随后按需求读取或搜索该视图。其他财务工具也会自动准备所选工作簿。

## 版本与缓存

- `documents` 仅保存原件身份、SHA-256、路径和版本。同名内容未变的上传复用版本；内容变化时保留旧原件并建立新版本。
- `source:` 引用编码文档版本及位置，不包含绝对路径，也不依赖 chunk、指标记录或缓存行 ID。
- `meta/read-cache/` 存放所选文档的文字视图和解析结果；SQLite 中的 Excel 表是财务读取缓存，普通坐标索引用于范围和公式查询。
- 清除解析缓存后，引用从固定版本原件重新解析。解析代码变化也会自动刷新缓存，文档版本和引用不变。
- 不删除已有原件、Memo、Research Note 或会话。旧 `chunk:`、`fact:`、`cell:` 引用不做兼容转换；重新读取资料后使用新的位置引用。现有项目的旧全文索引表不再使用；此改动不批量改写用户数据库。

按需的粒度是“选中的文档”：首次打开仍可能解析该文件全部页面或单元格，并非文件字节级的随机读取。工具响应有长度上限并标记截断；需要更多内容时继续用原生读取工具或缩小引用范围。扫描 PDF 不自动 OCR；缓存值不代表公式已重新计算。原件被绕过上传流程直接修改时，拒绝将它作为原版本引用。

## 验证

```bash
cd packages/pe-boot
node ../../node_modules/vitest/dist/cli.js --run test/documents.test.ts test/financial-tools.test.ts test/memo-tools.test.ts test/research-note-tools.test.ts
python/.venv/bin/python -m unittest discover -s python -p 'test_*.py'
```
