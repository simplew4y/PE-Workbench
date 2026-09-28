import {
  isFrameworkDocument,
  renderInvestmentFrameworkMarkdown,
  type StoredFrameworkContent,
} from "@earendil-works/pe-boot/framework-report";

// Proposals, previews, published versions and downloads share one document renderer.
export const frameworkReportMarkdown = renderInvestmentFrameworkMarkdown;

const sectionNames = {
  researchSetup: "研究设定", currentAssessment: "当前判断", businessModel: "公司如何创造价值",
  investmentJudgments: "投资判断与其他解释", valuation: "市场预期、估值与回报",
  monitoring: "什么情况下我们错了", evidenceAndChanges: "证据、未知问题与版本变化",
} as const;
const fieldNames: Record<string, string> = {
  objective: "研究目标", horizon: "投资期限", preferences: "分析师偏好", informationCutoff: "信息截止",
  summary: "说明", status: "判断状态", returnDrivers: "主要收益来源", keyUncertainties: "主要不确定性",
  changesSinceLastVersion: "相比上一版的变化", drivers: "经营驱动", kpis: "关键指标", evidenceIds: "证据引用",
  items: "投资判断", marketExpectations: "市场预期", forecastComparisons: "预测对比", scenarios: "情景估值", catalysts: "催化剂",
  rules: "监控指标与行动", sources: "证据及质量", openQuestions: "未知问题", changes: "版本变化", coverageGaps: "覆盖缺口",
  id: "编号", kind: "类型", claim: "当前判断", rationale: "判断依据", subject: "主题", verification: "验证条件", invalidation: "失效条件",
  origin: "判断来源", counterEvidenceIds: "反面证据", confidence: "置信度", level: "程度", reason: "理由", alternativeExplanations: "替代解释",
  from: "驱动因素", to: "影响结果", mechanism: "传导机制", name: "名称", period: "期间", value: "数值", impact: "影响",
  metric: "指标", marketExpectation: "市场预期", ownForecast: "我们的预测", difference: "差异", assumptions: "经营假设",
  unit: "单位", asOf: "估值时点", expectedReturn: "预期回报", calculation: "计算依据", judgmentIds: "关联判断",
  event: "事件", expectedAt: "预计时间", source: "来源", frequency: "频率", warningThreshold: "预警阈值",
  invalidationThreshold: "失效阈值", action: "触发后的动作", thresholdBasis: "阈值依据", evidenceId: "原始证据",
  description: "说明", quality: "证据质量", limitations: "限制", question: "问题", evidenceNeeded: "所需证据", before: "之前", after: "现在",
};
type Change = { id: string; title: string; kind: "新增" | "修改" | "移除"; fields: { label: string; before: string; after: string }[] };

function displayValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "未提供";
  if (Array.isArray(value)) return value.length ? value.map((entry, index) => `${index + 1}. ${displayValue(entry)}`).join("\n\n") : "未记录";
  if (typeof value === "object") return Object.entries(value).map(([key, entry]) => `${fieldNames[key] ?? key}：${displayValue(entry)}`).join("\n");
  return String(value);
}

export function frameworkVersionDiff(before: StoredFrameworkContent, after: StoredFrameworkContent): Change[] {
  const beforeDocument = isFrameworkDocument(before);
  const afterDocument = isFrameworkDocument(after);
  if (beforeDocument !== afterDocument) {
    return [{ id: "report-document", title: "框架结构与完整内容", kind: "修改", fields: [{ label: "框架全文", before: frameworkReportMarkdown(before), after: frameworkReportMarkdown(after) }] }];
  }
  const changes: Change[] = [];
  if (beforeDocument && afterDocument) {
    if (before.title !== after.title) changes.push({ id: "report-title", title: "报告标题", kind: "修改", fields: [{ label: "报告标题", before: before.title, after: after.title }] });
    for (const key of Object.keys(sectionNames) as (keyof typeof sectionNames)[]) {
      const previous = before.sections[key];
      const next = after.sections[key];
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])].flatMap((field) => {
        const a = displayValue((previous as Record<string, unknown>)[field]);
        const b = displayValue((next as Record<string, unknown>)[field]);
        return a === b ? [] : [{ label: fieldNames[field] ?? field, before: a, after: b }];
      });
      if (fields.length) changes.push({ id: `report-${key}`, title: sectionNames[key], kind: "修改", fields });
    }
    return changes;
  }
  if (beforeDocument || afterDocument) return changes;
  const itemFields = { subject: "主题", kind: "类型", claim: "判断", rationale: "依据与调整原因", verification: "验证条件", invalidation: "失效条件", origin: "来源类型", evidenceIds: "证据引用" } as const;
  for (const id of new Set([...before.items, ...after.items].map((item) => item.id))) {
    const a = before.items.find((item) => item.id === id);
    const b = after.items.find((item) => item.id === id);
    const fields = (Object.keys(itemFields) as (keyof typeof itemFields)[]).flatMap((key) => {
      const previous = displayValue(a?.[key]); const next = displayValue(b?.[key]);
      return previous === next ? [] : [{ label: itemFields[key], before: previous, after: next }];
    });
    if (fields.length) changes.push({ id, title: b?.subject ?? a!.subject, kind: !a ? "新增" : !b ? "移除" : "修改", fields });
  }
  for (const [key, label] of Object.entries({title: "报告标题", objective: "研究目标", horizon: "研究期限", coverageGaps: "资料缺口"}) as ["title" | "objective" | "horizon" | "coverageGaps", string][]) {
    const previous = displayValue(before[key]); const next = displayValue(after[key]);
    if (previous !== next) changes.push({ id: `report-${key}`, title: label, kind: "修改", fields: [{ label, before: previous, after: next }] });
  }
  return changes;
}
