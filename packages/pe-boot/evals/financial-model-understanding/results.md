# 实测结果

日期：2026-09-20。原文件只读，未重算、未联网。生产 skill 不含 Hermès 坐标或答案。

## 行为测试

两个独立上下文 agent 完成五题，只提供问题、skill 和原文件，不提供验收点或历史结论。保留实际回答于 observed-answers.md。以下为本次核验，不是生产模型成功率，也不是跨公司 benchmark。

| 题目 | 结果 | 主要核验依据 |
| --- | --- | --- |
| 收入机制 | 通过 | 法国 IK18 由上年同季收入乘增长预测；IK21 为8%输入，后三季链接；IR19由全年收入倒算。继续追了2025预测基数，没有停在年度链接。 |
| 成本机制 | 通过 | FM10反推COGS；FI16内含−0.3%，FM16内含+0.2%，FN16沿用。识别公式里的假设，没有将全年倒算毛利率当输入。 |
| 期间与颜色 | 通过 | 区分2024历史公式、2026硬填预测和链接预测；黄色也可以含公式。只说模型中的历史分类，没有伪称外部公告核验。 |
| 旁置估值表 | 通过 | X6→Q38→AU74，X7=47；X8约2338.03，X10用2150得8.75%。指出2400基准下方向相反，不选最新、不忽略小表。 |
| 投资研究衔接 | 通过 | 从亚洲12%增长、毛利率/费用/EPS及47倍估值提出验证与跟踪；未声称知道设定理由、最新兑现或市场共识。 |

原始回答偏长，适合审阅公式链，不代表最终产品默认应该这么展示。默认呈现应先给白话结论，坐标/路径用于核验或展开。

## 独立来源断言

运行 `check_evidence.py --workbook <原文件>`：16个公式、8个硬填输入、期间标签及5项局部算术核对通过。对真实回答的关键数字和计算方向作交叉检查；不把这些断言当语言行为评分。

本次未发现五题中的 fatal 条件。核验不涵盖全工作簿、外部输入真实性、重新计算、投资判断的盈利表现，亦没有无skill对照组，不能声称已量化skill提升幅度。

## 接线与回归

- capability运行时：实际载入reader、理解与研究正文；去重、重载和工具权限测试，不只检查文件存在。
- 后台框架：同一能力注册表的正文注入，只开放研究读取/提交两种工具；无额外文件/外部权限。
- 报告拦截：建模机制和框架任务不再误入完整报告；明确要求完整报告仍校验。
- 股票追踪的模型查询接口：改用结构导航、明确query搜索与单元格读取；不再使用已移除的selected_output/自动日期契约。
- 局部预览：重置临时副本的activeTab和所有tabSelected，修复隐藏旧选中页被先打印。Hermès Multiples!W5:X10重新渲染并目视确认；自动回归检查临时副本页选择及原文件不变。

最终执行：core `npm run check` 通过；17个定向测试文件共228项通过；Python三组共8项通过；Web附件/RPC/新查询接口共20项通过，改动文件ESLint通过。以下为主要测试命令。

```sh
# core repo
npm run check
cd packages/pe-boot
PE_EXCEL_PYTHON=/path/to/python node ../../node_modules/vitest/dist/cli.js --run test/capabilities.test.ts test/system-prompt.test.ts test/research-reader-skill.test.ts test/valuation-report-guard.test.ts test/workbook-business-reader.test.ts test/workbook-reader-transport.test.ts test/financial-tools.test.ts test/excel-processing.test.ts test/excel-pipeline.test.ts test/stock-tracking-tool.test.ts test/research-framework.test.ts
cd python
/path/to/python -m unittest test_render_workbook test_workbook_reader test_document_cache
```

Web普通typecheck和股票追踪旧测试会读本机过期的core dist，不能视作当前源码验证。用临时tsconfig映射core源码后，只剩未改动的files route Buffer|string类型错误。新模型查询API回归与session附件测试直接使用core源码，通过。未运行Next构建、未改依赖、未宣称浏览器端到端通过。

## 下一轮

用未看过的门店/量价型收入模型、费用明细模型和有缺失外链的模型验证泛化。固定生产模型与预算后重跑相同问题，保留tool trace及成本；再做无skill对照。新增规则应针对可复现的错误，不为一个公司的表格习惯加通用先验。
