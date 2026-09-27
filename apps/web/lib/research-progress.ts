import type { ResearchCardView } from "@earendil-works/pe-boot";

const labels = { unverified: "待核实", confirmed: "已人工确认", open: "待研究", resolved: "已解决" };

/** A factual index of saved work; never infer investment conclusions or completion. */
export function researchProgress(cards: ResearchCardView[], datasetId: string) {
  const active = cards.filter((card) => card.datasetId === datasetId && !card.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return {
    active,
    latest: active[0] ?? null,
    confirmed: active.filter((card) => card.status === "confirmed"),
    open: active.filter((card) => card.status === "open"),
    unverified: active.filter((card) => card.status === "unverified"),
    resolved: active.filter((card) => card.status === "resolved"),
    evidenceGaps: active.filter((card) => card.kind === "note" &&
      (!card.evidence.length || card.evidence.some((entry) => !entry.available))),
  };
}

export function researchProgressMarkdown(cards: ResearchCardView[], datasetId: string, name: string, exportedAt: string) {
  const progress = researchProgress(cards, datasetId);
  const heading = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\\x60*_[\]<>#]/g, "\\$&");
  const lines = [
    "# " + heading(name) + " · 研究进展",
    "", "导出时间：" + exportedAt,
    "", "范围：本项目未归档的研究记录。状态由研究员维护，不代表自动核验或最新投资结论。",
    "", "已人工确认 " + progress.confirmed.length + " 项；待核实 " + progress.unverified.length +
      " 项；待研究问题 " + progress.open.length + " 项；已解决问题 " + progress.resolved.length + " 项。",
    "", "## 后续核查",
    "", progress.open.length ? "尚有未解决问题，请结合原始资料继续验证。" : "暂无已记录的待研究问题，不代表研究已完整。",
    "", "有 " + progress.evidenceGaps.length + " 项成果缺少资料入口或存在不可定位的引用。",
  ];
  const groups = [
    ["已人工确认的成果", progress.confirmed], ["待核实的成果", progress.unverified],
    ["待研究问题", progress.open], ["已解决问题", progress.resolved],
  ] as const;
  for (const [title, entries] of groups) {
    lines.push("", "## " + title);
    if (!entries.length) lines.push("", "暂无记录。");
    for (const card of entries) {
      lines.push("", "### " + heading(card.title), "", "状态：" + labels[card.status] +
        "；保存：" + card.createdAt + "；更新：" + card.updatedAt + "；版本：" + card.revision, "", card.content);
      if (card.origin) lines.push("", "原回答摘录：", "", card.origin.excerpt,
        "", "来源会话：" + card.origin.sessionId + "；回答：" + card.origin.entryId);
      if (card.relatedCardIds.length) lines.push("", "关联卡片：" + card.relatedCardIds.join("、"));
      if (card.frameworkItemIds.length) lines.push("", "关联框架条目：" + card.frameworkItemIds.join("、"));
      lines.push("", "资料引用（请回到原项目核对，不代表逐句支持）：");
      if (!card.evidence.length) lines.push("", "暂无资料入口。");
      for (const evidence of card.evidence) lines.push("", "- " +
        heading(evidence.citation || evidence.id) + "；标识：" + heading(evidence.id) +
        (evidence.available ? "" : "（暂不可定位）"));
    }
  }
  return lines.join("\n") + "\n";
}
