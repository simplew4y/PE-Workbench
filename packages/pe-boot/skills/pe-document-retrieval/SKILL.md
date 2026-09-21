---
name: pe-document-retrieval
description: 检索 PE 项目上传的 PDF、Excel、Word、PowerPoint 和文本原件，选择文件版本并读取可引用证据。用于资料问答、页图核查和单元格取证；一般代码文件读取不需要此 skill，估值解释另用 pe-valuation-model-explainer。
---

# 项目资料检索

按问题选择相关文件及版本，工具返回的 markdown_citation 紧跟实质结论，保留精确证据位置。先定位后精读，不为每次问答扫描全部原件。

## PDF

- 上传后台已处理 PDF；用 pe_pdf_list 发现文件名和版本，pe_pdf_search 查找页文本的字面匹配，使用 next_page_offset 继续翻页。
- 用 pe_pdf_read 精读准确页码，保留 page: 引用。确认返回的 attached/omitted 图像状态，必要时用原生 read 读取页图路径后才能声称已进行视觉核查。
- 多文档比较时，对每份支撑结论的 PDF 分别调用 pe_pdf_read 核对关键页；meta/text 缓存与 read/grep 仅用于定位，不能代替关键页核验。回答前检查每份文件的结论都有已读页证据，缺少的先补读。
- 如实描述阅读范围：只读相关页就说“已核对相关页”，不能声称“读完全文”；单个词未命中或局部页面未提及，不能推断全文不存在。区分季报、半年报与年报的口径。
- 不启动第二套 PDF 解析器；检索未命中只表示已检查范围未定位，不能断言整份资料没有相关内容。

## Excel

- 原件注册为不可变版本，上传后台准备读取缓存。先用 pe_workbook_inspect 选择工作簿，锁定 doc_id；后续工具使用同一 doc_id，不静默混合工作簿或版本。
- pe_excel_range 读取确切区域，公式关系用 pe_formula_trace，缓存和结构问题用 pe_model_validate；缓存数值不代表最新重算结果。
- 工具会等待后台准备，缓存缺失时自动重建。需要文字视图回退时，调用 pe_document_open 获取 readable_path，再用原生 read/grep 或 bash 的 rg 检查；不修改原件或托管目录/缓存。
- 解释估值模型时读取 pe-valuation-model-explainer；最终整体报告再读取 pe-valuation-report。普通取数不加载报告流程。

## Word、PowerPoint 与文本

用原生文件发现工具选择目标文档，调用 pe_document_open，然后 read/grep 返回的 readable_path。保留 source: 引用绑定的原文行或 Office 内容块。

## 原件证据定位

Excel 的 source: 链接绑定文档版本、工作表和单元格范围，不依赖解析缓存。旧 cell: 链接仍可解析，旧 fact: 引用保留原版本。pe_source_detail 与原文预览定位一致；历史引用不得被悄悄替换成最新版。不要手写 evidence_id 或把内部引用改为网站、文件地址或 source_collection。
