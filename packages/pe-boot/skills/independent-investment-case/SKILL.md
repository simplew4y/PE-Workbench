---
name: independent-investment-case
description: 基于经营证据提出可验证的候选投资逻辑和经营预测，比较支持证据、反证、替代解释及未知问题；用于市场共识比较前保存独立判断或有依据地更新判断。
---

# Independent Investment Case

开始前读取 [共同数据约定](../investment-framework-builder/references/state-contract.md)。完整流程只更新指定状态字段和分析附件，不各写一篇完整报告；单独调用时可返回该模块的中文结果。保留来源与稳定 ID。

## 输入与输出

输入：model_understanding、business、metrics、assumptions、model_checks及evidence。输出：theses、forecasts、gaps和case_checkpoint。按当前阶段冻结经营判断，不直接生成市场估值。有工作簿先读取验收A结果；依赖未追清的预测不能升级为支持证据，可继续独立于该链的经营研究并标明限制。不要把“未记录选值理由”改写成“无法知道怎么算”。

## 工作要求

- 每条逻辑说明什么变化、通过什么机制、在什么期限内可能带来收益；先分开商业机制与当前价格的吸引力。
- 只保留有实质区别的逻辑，合并重复，不凑数量。Quality Compounder、Variant Perception、Deep Value等只提供问题，不是公司身份。
- 每条列支持证据、反面证据、替代解释、未知问题和信心依据。多篇转述同一信息不当作独立证据；模型预测本身不是兑现证据。
- 自己的经营预测必须标作research_forecast，与model_forecast和actual分开；允许沿用原模型但要注明，并解释支持程度。不凭空填新预测。
- 不主动读取市场共识以迎合目标价。已看到的市场信息写入case_checkpoint.exposure；保存时间与所用证据ID后再交估值阶段。后续因证据改判可建立新检查点并记录变化，保留原检查点。
- 信心用证据质量和缺口解释，不无依据打概率分。缺证据时写“还不能判断”，偏好不得替代结论。

模块表：逻辑ID｜候选逻辑｜支持证据｜反面证据｜替代解释｜还缺什么｜信心依据。将经营条件的assumption_ids挂到逻辑，供估值和监控引用。
