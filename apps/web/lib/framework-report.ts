import type { FrameworkContent } from "@earendil-works/pe-boot";

// ponytail: legacy prose uses conservative phrase rules; structured report blocks should replace these when the schema supports them.
export function reportParagraphs(text: string): string[] {
  return text
    .replace(/本文件仅为草稿，不发布正式版本。/g, "")
    .replace(/执行纪律：[\s\S]*$/, "")
    .replace(/[（(](?:缓存值[、，]?未重算|缓存值|未重算|硬编码|公式缓存|工作簿未重算|缓存值、未重新计算)[）)]/g, "")
    .replace(/（硬编码、倍数运算基准）/g, "（估值基准）")
    .replace(/（硬编码并作为全部倍数运算基准）/g, "（估值基准）")
    .replace(/模型口径复核（缓存值、未重算）——/g, "模型数据：")
    .replace(/（=FY26e DB EPS，由 Q38\/Q74 链路得出）/g, "")
    .replace(/（外部公式缓存 RMS FP Equity）/g, "")
    .replace(/公式缓存\s*/g, "")
    .replace(/缓存值/g, "历史数据")
    .replace(/硬编码/g, "固定假设")
    .replace(/growth_driver/g, "增长驱动").replace(/fixed_cost_leverage/g, "经营杠杆")
    .replace(/(?:原判断不变。)?本轮无新增且相关的证据可用于验证或推翻该假设：/g, "现有依据不足以验证或推翻该假设：")
    .split(/(?<=[。；])(?![^（(]*[）)])\s*|\n+|(?=原判断：|新证据：|外部证据：|调整原因：)/u)
    .map((part) => part.trim()).filter(Boolean);
}

export function reportCoverage(gaps: string[]): string[] {
  return gaps.filter((gap) => !/^(?:Memo 列表为空|不可用证据（已排除）)/.test(gap)).map((gap) => {
    if (gap.startsWith("模型数值为缓存值")) return "模型中的部分数据与假设较旧，估值结果需经更新核验后使用。";
    if (gap.startsWith("主体映射未完成")) return "部分外部资料的证券身份尚未核实，其价格、财务与股东数据暂不能直接用于投资判断。";
    if (gap.startsWith("模型估值日期未被工具确证")) return "模型的估值基准日尚未确认，目标价与现价的时点是否一致仍需核实。";
    return gap;
  });
}

export function frameworkReportMarkdown(content: FrameworkContent) {
  return [
    `# ${content.title}`, `## 研究目标\n\n${reportParagraphs(content.objective).join("\n\n")}`, `## 研究期限\n\n${reportParagraphs(content.horizon).join("\n\n")}`,
    ...content.items.map((item, index) => [
      `## ${index + 1}. ${item.subject}`, reportParagraphs(item.claim).join("\n\n"),
      ...(item.origin === "user" ? ["用户假设，待验证"] : []),
      `### 如何验证\n\n${reportParagraphs(item.verification).join("\n\n")}`,
      `### 何时失效\n\n${reportParagraphs(item.invalidation).join("\n\n")}`,
      ...(item.evidenceIds.length ? [`### 原始证据\n\n${item.evidenceIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}`] : []),
    ].join("\n\n")),
    ...(reportCoverage(content.coverageGaps).length ? [`## 影响判断的关键限制\n\n${reportCoverage(content.coverageGaps).map((gap) => `- ${reportParagraphs(gap).join(" ")}`).join("\n")}`] : []),
  ].join("\n\n") + "\n";
}


export function frameworkVersionDiff(before: FrameworkContent, after: FrameworkContent) {
  const itemFields = { subject: "主题", kind: "类型", claim: "判断", rationale: "依据与调整原因", verification: "验证条件", invalidation: "失效条件", origin: "来源类型", evidenceIds: "证据引用" } as const;
  const text = (value: unknown): string => Array.isArray(value) ? value.join("\n") : String(value ?? "");
  const changes: { id: string; title: string; kind: "新增" | "修改" | "移除"; fields: { label: string; before: string; after: string }[] }[] = [];
  for (const id of new Set([...before.items, ...after.items].map((item) => item.id))) {
    const a = before.items.find((item) => item.id === id);
    const b = after.items.find((item) => item.id === id);
    const fields = (Object.keys(itemFields) as (keyof typeof itemFields)[]).flatMap((key) => {
      const previous = text(a?.[key]); const next = text(b?.[key]);
      return previous === next ? [] : [{ label: itemFields[key], before: previous, after: next }];
    });
    if (fields.length) changes.push({ id, title: b?.subject ?? a!.subject, kind: !a ? "新增" : !b ? "移除" : "修改", fields });
  }
  for (const [key, label] of Object.entries({title: "报告标题", objective: "研究目标", horizon: "研究期限", coverageGaps: "资料缺口"}) as ["title" | "objective" | "horizon" | "coverageGaps", string][]) {
    const previous = text(before[key]); const next = text(after[key]);
    if (previous !== next) changes.push({ id: `report-${key}`, title: label, kind: "修改", fields: [{ label, before: previous, after: next }] });
  }
  return changes;
}
