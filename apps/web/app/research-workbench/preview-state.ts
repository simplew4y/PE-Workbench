export type ScenarioId = "revision" | "actuals" | "unchanged" | "conflict" | "recalculation";
export type Phase = "ready" | "running" | "review" | "published" | "rejected" | "unchanged" | "blocked";

export interface ResearchChange {
  id: string;
  metric: string;
  period: string;
  before: string;
  observed: string;
  proposed: string;
  kind: "实际值" | "假设修订" | "论据变化";
  impact: string;
  reason: string;
  source: string;
  location: string;
  quote: string;
  path: string[];
}

export const changes: ResearchChange[] = [
  {
    id: "revenue", metric: "中国区收入增长", period: "2026 H1 · 同比 · 固定汇率",
    before: "+8.0%", observed: "+3.0%", proposed: "+3.0%", kind: "实际值",
    impact: "补入历史期实际值", reason: "同期间、同币种口径较预测低 5 个百分点。先补入实际值，未来预测另行判断。",
    source: "2026 半年度报告（演示）", location: "第 18 页 · 地区收入",
    quote: "2026 年上半年，中国区收入按固定汇率同比增长 3.0%。该口径不包含汇率变动的影响。",
    path: ["中国区收入!F18", "利润表!F24", "现金流!F16", "估值!B37"],
  },
  {
    id: "growth", metric: "中国区下半年增长假设", period: "2026 H2 · 同比 · 固定汇率",
    before: "+12.0%", observed: "尚未披露", proposed: "+6.0%", kind: "假设修订",
    impact: "增长恢复节奏需要下调", reason: "上半年增长低于原预测。下半年实际尚未发生，结合管理层对恢复节奏的判断提出局部修订，不把上半年实际直接替换为下半年预测。",
    source: "管理层业绩交流（演示）", location: "第 4 页 · 中国区经营展望",
    quote: "我们预计下半年需求温和恢复，但恢复速度仍存在不确定性。新品贡献和门店效率需要在下一次经营更新中继续观察。",
    path: ["假设!J12", "中国区收入!J18", "利润表!J24", "估值!B37"],
  },
  {
    id: "thesis", metric: "新品驱动增长的论据", period: "研究判断 · 未来 12 个月",
    before: "增长主线", observed: "贡献未单独披露", proposed: "保留，降低置信度", kind: "论据变化",
    impact: "从中等置信度调整为低", reason: "新品收入没有单独披露，现有数据尚不能验证增量贡献；保留论点并增加 Q3 核验条件。",
    source: "2026 半年度报告（演示）", location: "第 23 页 · 产品与渠道",
    quote: "集团持续推进新品投放与门店升级。本报告未按新品和存量产品分别披露收入贡献。",
    path: ["证据 E03", "判断 T02 · 新品贡献", "指标 MON02 · 新品收入", "Q3 经营更新"],
  },
];

export const scenarios: Record<ScenarioId, { label: string; summary: string; result: string }> = {
  revision: { label: "重大假设修订", summary: "实际值已核对，1 项未来假设需要你的判断。", result: "候选框架与模型已生成，等待审阅。" },
  actuals: { label: "仅补入实际值", summary: "本轮只补入已披露实际值，未来假设沿用。", result: "按演示发布规则更新框架和模型，原版本保留。" },
  unchanged: { label: "没有实质变化", summary: "本轮资料与已有证据一致，原判断继续有效。", result: "记录检查结果，不生成重复版本。" },
  conflict: { label: "证据口径冲突", summary: "两份资料的收入口径无法直接比较，需要核实。", result: "暂不修改模型及框架，保留口径问题。" },
  recalculation: { label: "模型重算失败", summary: "新证据可更新框架，模型存在无法解析的外部链接。", result: "框架可单独审阅；候选模型不可用，继续沿用 M01。" },
};

export const stages = ["核对新资料", "对照事实与预测", "判断研究影响", "生成候选成果", "审阅与发布"];

export interface PreviewState {
  scenario: ScenarioId;
  phase: Phase;
  step: number;
  tracking: boolean;
  decisionNote: string;
}

export type PreviewAction =
  | { type: "scenario"; scenario: ScenarioId }
  | { type: "run" }
  | { type: "advance" }
  | { type: "decide"; decision: "approve" | "reject"; note: string }
  | { type: "tracking" }
  | { type: "reset" };

export function createPreviewState(): PreviewState {
  return { scenario: "revision", phase: "review", step: 4, tracking: true, decisionNote: "" };
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case "scenario":
      return { ...createPreviewState(), scenario: action.scenario, phase: "ready", step: 0, tracking: state.tracking };
    case "run":
      if (state.phase !== "ready") return state;
      return { ...state, phase: "running", step: 0 };
    case "advance":
      if (state.phase !== "running") return state;
      if (state.step < 3) return { ...state, step: state.step + 1 };
      return {
        ...state, step: 4,
        phase: state.scenario === "unchanged" ? "unchanged" : state.scenario === "conflict" ? "blocked" : state.scenario === "actuals" ? "published" : "review",
      };
    case "decide":
      if (state.phase !== "review" || action.note.trim().length < 8) return state;
      return { ...state, phase: action.decision === "approve" ? "published" : "rejected", decisionNote: action.note.trim() };
    case "tracking":
      return { ...state, tracking: !state.tracking };
    case "reset":
      return createPreviewState();
  }
}

export function currentVersions(state: PreviewState) {
  const published = state.phase === "published";
  return { framework: published ? "F02" : "F01", model: published && state.scenario !== "recalculation" ? "M02" : "M01" };
}

export function visibleChanges(scenario: ScenarioId): ResearchChange[] {
  if (scenario === "unchanged") return [];
  if (scenario === "actuals" || scenario === "conflict") return changes.slice(0, 1).map((change) => evidenceChange(change, scenario));
  if (scenario === "recalculation") return changes.slice(2);
  return changes;
}

export function evidenceChange(change: ResearchChange, scenario: ScenarioId): ResearchChange {
  if (scenario === "conflict" && change.id === "revenue") return {
    ...change,
    period: "2026 H1 · 固定汇率与报告汇率混用",
    observed: "固定汇率 +3% / 报告汇率 +1%",
    proposed: "待核实，不采用",
    reason: "报告与交流材料使用不同汇率口径；原模型口径也需重新确认。在取得口径调节表前，不计算预测误差，不改动原值。",
    source: "半年度报告 / 管理层业绩交流（演示）",
    location: "第 18 页 / 第 2 页 · 口径待确认",
    quote: "报告：按固定汇率同比增长 3.0%。交流材料：按报告汇率同比增长 1.0%。尚未提供两种口径的调节表。",
  };
  if (scenario !== "revision" && !(scenario === "actuals" && change.id === "revenue") && !(scenario === "recalculation" && change.id === "thesis")) return {
    ...change, proposed: change.before, reason: `${change.reason} 本场景不采用该项修订，继续保留原值。`,
  };
  return change;
}

export function phaseLabel(phase: Phase) {
  return { ready: "待检查", running: "分析中", review: "待你审阅", published: "已发布", rejected: "保留原版本", unchanged: "无实质变化", blocked: "待核实" }[phase];
}

export function roundOutcome(state: PreviewState): string {
  if (state.phase === "ready" || state.phase === "running") return "尚未完成本轮检查。";
  if (state.phase === "rejected") return "候选修订未采用，保留 F01 / M01 与审阅原因。";
  if (state.phase === "published") return state.scenario === "recalculation"
    ? "框架 F02 已发布；候选模型不可用，继续沿用 M01。"
    : "框架 F02 与模型 M02 已发布，原版本及更新依据保留。";
  return scenarios[state.scenario].result;
}

export function roundSummary(state: PreviewState): string {
  return ["published", "rejected", "ready", "running"].includes(state.phase)
    ? roundOutcome(state) : scenarios[state.scenario].summary;
}

export type ModelView = "baseline" | "candidate" | "original";

export function modelSnapshot(state: PreviewState, view: ModelView) {
  const updated = view === "candidate" || (view === "baseline" && currentVersions(state).model === "M02");
  const available = view !== "candidate" || (state.scenario !== "recalculation" && ["review", "published", "rejected"].includes(state.phase));
  return {
    available,
    revenue: available ? updated ? "+3.0%" : "+8.0%" : null,
    growth: available ? updated && state.scenario === "revision" ? "+6.0%" : "+12.0%" : null,
    actual: updated,
    status: view === "original" ? "初始基线" : view === "baseline" ? "当前基线" : !available ? "不可用" : state.phase === "rejected" ? "未采用" : state.phase === "published" ? "已采用" : "候选",
  };
}

export function changeSetCsv(state: PreviewState): string {
  const versions = currentVersions(state);
  const rows = [
    ["演示数据", "期间与口径", "类型", "原值", "新证据", "候选值", "原因", "来源", "处理结果", "当前框架", "当前模型", "审阅意见"],
    ...visibleChanges(state.scenario).map((change) => [change.metric, change.period, change.kind, change.before, change.observed, state.scenario === "conflict" ? "待核实，不采用" : change.proposed, change.reason, `${change.source} ${change.location}`, roundOutcome(state), versions.framework, versions.model, state.decisionNote || "无人工审阅意见"]),
  ];
  return `\uFEFF${rows.map((row) => row.map((value) => {
    const text = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n")}`;
}

export function researchReport(state: PreviewState): string {
  const versions = currentVersions(state);
  return [
    "# 远川消费 · 研究更新演示", "", "本文件为虚构示例，不来自真实公司或模型重算。", "",
    `场景：${scenarios[state.scenario].label}`, `本轮状态：${phaseLabel(state.phase)}`,
    `当前框架：${versions.framework}；当前模型：${versions.model}`, "", roundOutcome(state), "",
    ...visibleChanges(state.scenario).flatMap((change) => [`## ${change.metric}`, change.period, `原值：${change.before}；新证据：${change.observed}；候选：${state.scenario === "conflict" ? "待核实，不采用" : change.proposed}`, change.reason, `来源：${change.source} · ${change.location}`, ""]),
    "## 审阅记录", state.decisionNote || "未提交人工审阅意见。", "",
    "## 未解决问题", "新品贡献未单独披露；门店效率改善需在 Q3 核实。",
  ].join("\n");
}
