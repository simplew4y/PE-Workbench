# Excel 估值取证与核验

有可访问的原始 Excel 时读取；截图或摘录不触发工作簿核验。

## 开始前核验

若用户只提供模型截图、公式摘录或他人分析，先核对可见内容、期间、单位和来源，区分原模型信息与转述或分析推断。只有能访问原始 Excel 时才执行下列工作簿工具核验；没有原文件时仅分析可见内容，不编造 `doc_id`、单元格、引用或工具结果，也不把他人的结论视为已经核验。原文件可用时回到该文件取证。

1. 先调用 `pe_workbook_inspect`。如果存在多个工作簿，必须锁定一个 `doc_id` 后才能分析；无法确定权威文件时列出冲突，不替用户选择。
2. 后续所有 Excel 检索和取数必须使用同一个 `doc_id`。不得把不同工作簿中的指标静默拼接。
3. 收集公司或项目、可能的日期、货币、单位、当前股价、目标价、目标年份和预测期。此时不要把最大日期、预测年份、报告日或文件时间直接认定为估值日。
4. 调用 `pe_valuation_output_locate` 生成和评分估值输出候选，不要用通用搜索结果或第一个关键词命中替代它。`selected` 表示确定性规则选出了首选候选，但不表示数值已经重算验证；`ambiguous` 时保留全部 `conflicting_candidate_ids`，分别检查公式链，不能擅自选择第一名；`missing` 时使用 `pe_document_open` 打开同一 `doc_id`，再用 pi 原生 `grep` / `read` 检查该文件的文字视图。仍未定位的主输出不写入报告。
5. 定位器返回 `selected` 后，调用 `pe_valuation_date_resolve`，将 `selected_output.candidate_id`、`selected_output.sheet_name`、`selected_output.cell_ref` 分别传入 `output_candidate_id`、`output_sheet`、`output_cell_ref`。如果输出仍为 `ambiguous`，应使用 `conflicting_outputs` 分别在每个冲突输出上下文中解析日期，不得把不同输出的日期合并成一个全局估值日。分别保留估值日、市场价格日、财务数据截止日、报告日、模型更新时间、目标期限和预测期。
6. 只有 `pe_valuation_date_resolve.status=verified` 才在报告中展示估值日。`inferred`、`ambiguous`、`missing` 保留为内部状态，报告省略日期及未确认说明。默认不得启用文件时间 fallback。
   工作簿由上传后台准备；读取工具等待准备完成，缓存缺失时自动重建。解析失败时说明无法读取，不得退回按文件名或文件时间猜测。
7. 调用 `pe_formula_trace` 反向追踪上游。对链条中的关键范围使用 `pe_excel_range` 精确读取公式、缓存值、数字格式、期间和单位。币种及尺度以工具返回的 `unit`、`unit_context` 为依据，结合分区表头和跨表公式来源；估值页未重复单位不代表全表没有单位。按公式关系识别金额、股数及每股单位，不能按公司、文件名、数值大小或某个无关区域的币种猜测。多币种工作簿分别保留各计算链的口径。
8. 调用 `pe_model_validate` 检查缓存覆盖、公式断链、外链、错误值和指标质量。内部区分 `structural_status` 与 `calculation_validation.status`，不得把结构通过表述为数值已经重算验证；用户要求详细核验时再分别说明这些状态。
9. `pe_source_detail` 继续用于核验检索得到的 PDF 页或 Excel 单元格范围，但不得用局部窗口代替公式追踪。
10. 若 `pe_formula_trace.complete` 为 false，内部核对外链、未解析引用、错误引用、循环、深度限制或节点限制。不得自行补全缺失链条，也不得据此输出无支持的结论；用户要求详细核验时再列明各项。
11. `formula_cache_status=present` 只表示缓存存在，不表示刚刚重算。若 `calculation_validation.status` 不是已验证状态，不得声称数值已经重算验证。缓存缺失或异常时，不得把公式文本或推算值写成模型原始计算值。

报告省略缺失的结果、数字、公式、估值方法及敏感性模块，不保留空标题或未确认提示。用户专门询问某项是否存在或为何省略时，才按实际读取范围说明原因。
