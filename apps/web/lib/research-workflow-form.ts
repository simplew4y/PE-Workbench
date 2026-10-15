import type { IterationModelMapping, IterationObservations, IterationImpacts } from "@earendil-works/pe-boot";

export function parseModelLiteral(value: string): IterationModelMapping["expectedValue"] {
  const normalized = value.trim();
  if (!normalized || normalized === "null") return null;
  if (normalized.startsWith("=")) throw new Error("公式单元格不能作为可写输入。");
  if (normalized === "true" || normalized === "false") return normalized === "true";
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const number = Number(normalized);
    if (!Number.isFinite(number)) throw new Error("原值必须是有限数值。");
    return number;
  }
  if (normalized.startsWith('"')) {
    const parsed: unknown = JSON.parse(normalized);
    if (typeof parsed !== "string" || parsed.startsWith("=")) throw new Error("请输入单元格原始常量。");
    return parsed;
  }
  return value;
}

export function mappingFromObservation(observation: IterationObservations["observations"][number], impacts?: IterationImpacts): IterationModelMapping {
  if (observation.context.periodKind === "unknown") throw new Error("报告期间口径尚不明确，请先核实原文，不能自动建立映射。");
  const comparisons = impacts?.impacts.filter((impact) => impact.comparable && impact.observationIds.includes(observation.id)) ?? [];
  const currencies = [...new Set(comparisons.map((impact) => impact.comparisonBasis?.currency ?? null))];
  return {
    id: observation.id, subject: observation.subject, metric: observation.metric,
    ...(observation.sourceField ? { sourceField: observation.sourceField } : {}),
    period: observation.period ?? "", periodKind: observation.context.periodKind,
    asOf: observation.context.asOf, unit: observation.unit ?? "", scope: observation.context.scope ?? "",
    currency: currencies.length === 1 ? currencies[0] : null, role: observation.role === "fact" ? "actual" : "assumption",
    sheet: "", cell: "", expectedValue: null,
  };
}

export const modelDeliveryLabels: Record<string, string> = {
  not_configured: "未绑定模型，本轮仅更新框架", running: "正在写入副本并重算", no_change: "没有可自动写回的实际值",
  candidate: "候选模型已生成，尚未替换基线", unavailable: "模型更新不可用，原基线保留", cancelled: "模型更新已停止",
};

export const modelSkipLabels: Record<string, string> = {
  ambiguous_mapping: "存在多个单元格映射", no_exact_mapping: "未找到完全一致的指标口径", uncertain_observation: "证据存在待核实问题",
  non_numeric_observation: "不是明确数值", unknown_or_incompatible_role: "事实、预测角色不符", unresolved_or_incompatible_impact: "期间、范围、币种或影响判断未核实",
  non_numeric_baseline: "原假设没有明确数值，暂时保留",
  unchanged_value: "与原值一致", no_matching_observation: "本轮没有对应观察", ambiguous_observations: "有多个候选观察，不能自动择一", assumption_requires_human_decision: "假设修订需要研究员决定",
  nothing_new: "本轮没有新增证据，无需写回", currency_not_confirmed: "货币指标尚未确认币种",
};
