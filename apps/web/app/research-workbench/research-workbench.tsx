"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, Download, FileCheck2, FileSpreadsheet, FileText, FlaskConical, FolderOpen, History, Layers3, LayoutDashboard, Link2, Pause, Play, RotateCcw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { changeSetCsv, changes, createPreviewState, currentVersions, evidenceChange, phaseLabel, previewReducer, researchReport, roundOutcome, roundSummary, modelSnapshot, scenarios, stages, visibleChanges, type ModelView, type PreviewState, type ResearchChange, type ScenarioId } from "./preview-state";
import styles from "./workbench.module.css";

type View = "overview" | "updates" | "model" | "evidence" | "history";
const navigation = [
  { id: "overview", label: "研究概览", icon: LayoutDashboard },
  { id: "updates", label: "研究更新", icon: Layers3 },
  { id: "model", label: "财务模型", icon: FileSpreadsheet },
  { id: "evidence", label: "资料与证据", icon: FolderOpen },
  { id: "history", label: "版本历史", icon: History },
] as const;

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" }) {
  return <span className={styles.badge} data-tone={tone}>{children}</span>;
}

function SectionHeading({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className={styles.sectionHeading}><div>{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}<h2>{title}</h2></div>{children}</div>;
}

function ChangeTable({ items, inspect, conflict = false }: { items: ResearchChange[]; inspect: (change: ResearchChange) => void; conflict?: boolean }) {
  return <div className={styles.tableScroll}><table className={styles.table}>
    <caption className={styles.srOnly}>原预测、新证据与候选修改对照</caption>
    <thead><tr><th>指标 / 论据</th><th>原预测或判断</th><th>新证据</th><th>拟采取的动作</th><th><span className={styles.srOnly}>证据详情</span></th></tr></thead>
    <tbody>{items.map((change) => <tr key={change.id}>
      <td><button className={styles.rowLink} onClick={() => inspect(change)}>{change.metric}</button><small>{change.period}</small></td>
      <td>{change.before}</td><td>{conflict ? "两种口径，待核实" : change.observed}</td>
      <td><span className={styles.changeValue}>{conflict ? "保留原值" : change.proposed}</span><small>{conflict ? "暂不计算偏差" : change.kind}</small></td>
      <td><button className={styles.iconButton} aria-label={`查看${change.metric}证据`} onClick={() => inspect(change)}><ArrowUpRight size={16} /></button></td>
    </tr>)}</tbody>
  </table></div>;
}

function ResultPair({ state }: { state: PreviewState }) {
  const versions = currentVersions(state);
  const changed = ["review", "published"].includes(state.phase);
  const failed = state.scenario === "recalculation" && changed;
  return <div className={styles.resultPair}>
    <article><FileText size={19} /><div><span>投资框架</span><strong>{state.phase === "published" ? "F02 · 已发布" : state.phase === "review" ? "F02 · 待审阅" : `${versions.framework} · 继续沿用`}</strong><small>{state.phase === "review" ? "当前正式版仍为 F01" : state.phase === "published" ? "新判断与变更依据已保存" : "当前研究判断保留"}</small></div><Badge tone={state.phase === "published" ? "green" : state.phase === "review" ? "amber" : "neutral"}>{state.phase === "published" ? "当前版本" : state.phase === "review" ? "候选" : "当前版本"}</Badge></article>
    <article><FileSpreadsheet size={19} /><div><span>财务模型</span><strong>{failed ? "M02 · 重算失败" : state.phase === "published" ? "M02 · 已更新" : state.phase === "review" ? "M02 · 候选模型" : `${versions.model} · 继续沿用`}</strong><small>{failed ? "继续沿用 M01，候选结果不可使用" : state.phase === "review" ? "演示校验通过，尚未成为基线" : "演示版本 · Excel 文件尚未接入"}</small></div><Badge tone={failed ? "red" : state.phase === "published" ? "green" : "neutral"}>{failed ? "不可用" : state.phase === "published" ? "当前版本" : "演示"}</Badge></article>
  </div>;
}

export function ResearchWorkbench() {
  const [state, dispatch] = useReducer(previewReducer, undefined, createPreviewState);
  const [view, setView] = useState<View>("overview");
  const [activeStage, setActiveStage] = useState(4);
  const [selectedChange, setSelected] = useState<ResearchChange>(changes[1]);
  const selected = evidenceChange(selectedChange, state.scenario);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState("");
  const [query, setQuery] = useState("");
  const [modelTab, setModelTab] = useState<ModelView>("baseline");
  const [historySelection, setHistorySelection] = useState<"baseline" | "round">("round");
  const detailDialog = useRef<HTMLDialogElement>(null);
  const decisionDialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  const versions = currentVersions(state);
  const scenario = { ...scenarios[state.scenario], summary: roundSummary(state), result: roundOutcome(state) };
  const snapshot = modelSnapshot(state, modelTab);
  const items = visibleChanges(state.scenario);
  const reviewing = state.phase === "review";
  const finished = !["ready", "running"].includes(state.phase);
  const hasCandidate = ["review", "published", "rejected"].includes(state.phase);
  const failedModel = state.scenario === "recalculation";

  useEffect(() => {
    if (state.phase !== "running") return;
    const timer = window.setTimeout(() => dispatch({ type: "advance" }), 600);
    return () => window.clearTimeout(timer);
  }, [state.phase, state.step]);

  function navigate(next: View) {
    setView(next);
    main.current?.scrollTo({ top: 0 });
  }

  function inspect(change: ResearchChange) {
    setSelected(change);
    detailDialog.current?.showModal();
  }

  function openDecision(value: "approve" | "reject") {
    setDecision(value);
    setNote("");
    decisionDialog.current?.showModal();
  }

  function download(kind: "report" | "changes") {
    const value = kind === "report" ? researchReport(state) : changeSetCsv(state);
    const url = URL.createObjectURL(new Blob([value], { type: kind === "report" ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `远川消费-演示-${kind === "report" ? "研究更新.md" : "修改清单.csv"}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setReceipt(kind === "report" ? "已下载本轮研究报告（演示数据）。" : "已下载修改清单（演示数据）。");
  }

  function changeScenario(value: ScenarioId) {
    dispatch({ type: "scenario", scenario: value });
    setActiveStage(0);
    setModelTab("baseline");
    setHistorySelection("round");
    setReceipt("");
    navigate("updates");
  }

  const statusTone = state.phase === "published" ? "green" : state.phase === "blocked" ? "red" : reviewing ? "amber" : "neutral";

  return <div className={styles.shell} lang="zh-CN">
    <a className={styles.skipLink} href="#research-main">跳到研究内容</a>
    <aside className={styles.sidebar}>
      <Link className={styles.brand} href="/"><Layers3 size={23} /><span>PE <strong>Workbench</strong><small>投资研究工作台</small></span></Link>
      <div className={styles.project}><span className={styles.projectMark}>远</span><div><strong>远川消费</strong><small>消费研究 · 演示项目</small></div></div>
      <p className={styles.navCaption}>项目研究</p>
      <nav aria-label="研究工作台导航">{navigation.map(({ id, label, icon: Icon }) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{id === "updates" && reviewing && <b>1</b>}</button>)}</nav>
      <div className={styles.sidebarBottom}>
        <div className={styles.trackingCard}><span className={styles.trackingDot} data-active={state.tracking} /><div><strong>{state.tracking ? "持续跟踪中" : "跟踪已暂停"}</strong><small>演示计划 · 每 24 小时</small></div><button className={styles.iconButton} aria-label="持续跟踪设置" onClick={() => settingsDialog.current?.showModal()}><Settings2 size={16} /></button></div>
        <Link className={styles.backLink} href="/"><ArrowLeft size={15} />返回对话工作区</Link>
      </div>
    </aside>

    <main className={styles.main} id="research-main" ref={main} tabIndex={-1}>
      <header className={styles.topbar}><div className={styles.breadcrumb}>项目研究<ChevronRight size={13} /><strong>{navigation.find((entry) => entry.id === view)?.label}</strong></div><div className={styles.topbarRight}><Badge><FlaskConical size={12} />交互预览</Badge><span className={styles.avatar}>研</span></div></header>
      <div className={styles.content}>
        <div className={styles.demoBar}><div><FlaskConical size={15} /><span>虚构示例 · 操作仅在本页生效，刷新或切换场景会重置</span></div><div><label className={styles.srOnly} htmlFor="demo-scenario">演示场景</label><select id="demo-scenario" value={state.scenario} disabled={state.phase === "running"} onChange={(event) => changeScenario(event.target.value as ScenarioId)}>{Object.entries(scenarios).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><button aria-label="重置演示" onClick={() => { dispatch({ type: "reset" }); setActiveStage(4); setModelTab("baseline"); setHistorySelection("round"); setQuery(""); navigate("overview"); setReceipt("演示已重置。"); }}><RotateCcw size={14} /></button></div></div>

        <div className={styles.pageHeading}><div><p className={styles.eyebrow}>YUANCHUAN CONSUMER · DEMO</p><h1>{view === "overview" ? "远川消费" : navigation.find((entry) => entry.id === view)?.label}</h1><p>{view === "overview" ? "持续理解生意，让每一次判断都有据可循。" : view === "updates" ? "从一份新资料，到一轮有依据的研究更新。" : view === "model" ? "先理解输入与假设，再看结果如何变化。" : view === "evidence" ? "回到原始资料，区分已知、预测与待核实。" : "保留每次判断，以及当时做出判断的依据。"}</p></div><div className={styles.headingActions}>{view === "overview" && <button className={styles.primary} onClick={() => navigate("updates")}>{reviewing ? "查看本轮变化" : "进入研究更新"}<ArrowRight size={16} /></button>}{view !== "overview" && <button className={styles.secondary} disabled={!finished} onClick={() => download("report")}><Download size={15} />下载本轮报告</button>}</div></div>

        {view === "overview" && <>
          <div className={styles.overviewGrid}>
            <section className={styles.assessment}><div className={styles.inlineHeading}><span className={styles.eyebrow}>当前研究判断 · {versions.framework}</span><Badge tone="green">持续观察</Badge></div><h2>{state.phase === "published" && state.scenario !== "actuals" ? "增长主线仍在，恢复节奏需要重新评估。" : "品牌与渠道优势仍在，增长兑现是下一步关键。"}</h2><p>重点关注中国区需求恢复与新品贡献。估值能否获得支撑，取决于增长向利润和现金流的实际传导。</p><div className={styles.assessmentFoot}><span><Clock3 size={13} />资料截止：2026.08.28（演示）</span><button onClick={() => { navigate("history"); setHistorySelection(state.phase === "published" ? "round" : "baseline"); }}>阅读当前框架<ArrowUpRight size={14} /></button></div></section>
            <section className={styles.nextAction}><div className={styles.inlineHeading}><span className={styles.eyebrow}>你的下一步</span><Badge tone={statusTone}>{phaseLabel(state.phase)}</Badge></div><div className={styles.actionIcon}>{reviewing ? <FileCheck2 size={25} /> : <CheckCheck size={25} />}</div><h2>{reviewing ? "有一轮更新需要审阅" : state.phase === "published" ? "本轮成果已归档" : "继续跟踪新的证据"}</h2><p>{scenario.summary}</p><button className={styles.textButton} onClick={() => navigate("updates")}>{reviewing ? "查看差异与建议" : "查看检查结果"}<ArrowRight size={15} /></button></section>
          </div>
          <div className={styles.stats}><div><span>框架基线</span><strong>{versions.framework}<small>正式版本</small></strong></div><div><span>模型基线</span><strong>{versions.model}<small>{failedModel && state.phase === "published" ? "沿用上一版" : "演示版本"}</small></strong></div><div><span>本轮资料</span><strong>2<small>份示例来源</small></strong></div><div><span>关键不确定性</span><strong>2<small>项继续跟踪</small></strong></div></div>
          <section className={styles.section}><SectionHeading eyebrow="LATEST UPDATE" title="本轮研究更新"><button className={styles.textButton} onClick={() => navigate("updates")}>查看全部<ArrowRight size={14} /></button></SectionHeading><button className={styles.updateSummary} onClick={() => navigate("updates")}><span className={styles.documentIcon}><FileText size={23} /></span><div><div className={styles.inlineHeading}><strong>2026 半年度经营更新</strong><Badge tone={statusTone}>{phaseLabel(state.phase)}</Badge></div><p>{scenario.summary}</p><small>半年度报告 · 管理层业绩交流 · 基于 F01 / M01</small></div><ChevronRight size={20} /></button></section>
          <div className={styles.bottomGrid}><section className={styles.section}><SectionHeading title="核心论据与验证方向" /><div className={styles.thesisList}><button onClick={() => inspect(changes[2])}><span className={styles.number}>01</span><div><strong>新品贡献能否接替原有增长动力</strong><p>贡献未单独披露，等待 Q3 经营数据。</p></div><Badge tone="amber">待验证</Badge></button><button onClick={() => inspect(changes[0])}><span className={styles.number}>02</span><div><strong>中国区需求恢复能否持续</strong><p>核对同口径收入与门店效率。</p></div><Badge>持续跟踪</Badge></button></div></section><section className={styles.section}><SectionHeading title="研究成果" /><button className={styles.artifactLink} onClick={() => navigate("history")}><BookOpen size={20} /><div><strong>投资框架 · {versions.framework}</strong><small>判断、依据与改判条件</small></div><ArrowUpRight size={16} /></button><button className={styles.artifactLink} onClick={() => navigate("model")}><FileSpreadsheet size={20} /><div><strong>财务模型 · {versions.model}</strong><small>输入、公式与版本状态</small></div><ArrowUpRight size={16} /></button></section></div>
        </>}

        {view === "updates" && <>
          <div className={styles.roundHeading}><div><Badge>更新 002</Badge><strong>2026 半年度经营更新</strong><span>基线 F01 / M01</span></div><Badge tone={statusTone}>{phaseLabel(state.phase)}</Badge></div>
          <nav className={styles.stages} aria-label="本轮更新阶段">{stages.map((stage, index) => <button key={stage} disabled={index > state.step || state.phase === "ready"} aria-current={activeStage === index ? "step" : undefined} data-complete={index < state.step} onClick={() => setActiveStage(index)}><span>{index < state.step ? <Check size={14} /> : `0${index + 1}`}</span><strong>{stage}</strong></button>)}</nav>
          {state.phase === "ready" ? <section className={styles.emptyState}><FolderOpen size={32} /><h2>这一轮将演示「{scenario.label}」</h2><p>使用两份虚构资料和 F01 / M01 基线，展示从检查到交付的完整过程。</p><button className={styles.primary} onClick={() => { dispatch({ type: "run" }); setActiveStage(4); }}><Play size={15} />运行一次演示</button></section> : state.phase === "running" ? <section className={styles.emptyState} aria-live="polite"><span className={styles.loading}><Layers3 size={30} /></span><h2>{stages[state.step]}…</h2><p>正在播放演示流程，不调用真实来源或模型。</p><progress value={state.step + 1} max={5} aria-label="演示流程进度" /></section> : <>
            <div className={styles.stageNote}><CheckCheck size={17} /><div><strong>{stages[activeStage]}</strong><span>{["已固定两份演示资料及研究基线，保留来源与期间。", "比较同期间、同币种和同业务范围；不可比项保留缺口。", "关联受影响论据，未受影响的判断继续保留。", failedModel ? "框架候选已生成，模型因外链问题未能重算。" : "保留原模型与原判断，修改集中在本轮相关范围。", scenario.result][activeStage]}</span></div></div>
            {activeStage === 0 && <section className={styles.section}><SectionHeading title="本轮固定资料" />{[changes[0], changes[1]].map((change) => <button className={styles.artifactLink} key={change.id} onClick={() => inspect(change)}><FileText size={20} /><div><strong>{change.source}</strong><small>{change.location} · 2026.08.28 · 演示来源</small></div><ArrowUpRight size={16} /></button>)}</section>}
            {activeStage !== 0 && <section className={styles.section}><SectionHeading title={activeStage === 2 ? "哪些判断受到影响" : "本轮变化与依据"}><span className={styles.muted}>{items.length} 项 · 点击查看来源</span></SectionHeading>{items.length ? <ChangeTable items={items} conflict={state.scenario === "conflict"} inspect={inspect} /> : <div className={styles.inlineEmpty}><CheckCheck size={22} /><p>没有发现需要调整的内容。保留 F01 / M01，仅记录本次检查。</p></div>}</section>}
            <ResultPair state={state} />
            {state.scenario === "conflict" && <div className={styles.warning}><CircleAlert size={19} /><div><strong>口径未确认，暂不提出数值修订</strong><p>演示报告采用固定汇率口径，另一份资料含汇率影响。需要取得口径调节表；不得将两者直接计算为预测误差。</p></div></div>}
            {failedModel && <div className={styles.warning}><CircleAlert size={19} /><div><strong>模型重算失败，不阻止保存有效的研究判断</strong><p>示例外链 MarketData.xlsx 无法解析。当前 M01 保留，M02 不得作为下一轮模型基线。</p></div></div>}
            {reviewing && <div className={styles.reviewBar}><div><strong>{failedModel ? "审阅框架变化，模型继续沿用 M01" : "采用这轮局部修订？"}</strong><p>检查来源与差异后决定，原版本始终保留。</p></div><div><button className={styles.secondary} onClick={() => openDecision("reject")}>保留当前版本</button><button className={styles.primary} onClick={() => openDecision("approve")}>审阅{failedModel ? "框架" : "并发布"}<ArrowRight size={15} /></button></div></div>}
            {state.decisionNote && <div className={styles.reviewRecord}><ShieldCheck size={18} /><div><strong>{state.phase === "published" ? "已采用本轮修订" : "已保留当前版本"}</strong><p>{state.decisionNote}</p><button className={styles.textButton} onClick={() => navigate("history")}>查看版本记录<ArrowRight size={14} /></button></div></div>}
            <div className={styles.roundFoot}><span>本页审批与发布仅为交互演示。</span><button className={styles.textButton} onClick={() => changeScenario(state.scenario)}><RotateCcw size={14} />重新演示这一轮</button></div>
          </>}
        </>}

        {view === "model" && <>
          <div className={styles.modelHeading}><div><FileSpreadsheet size={22} /><div><strong>远川消费财务模型</strong><small>示例模型 · 人民币 · 百万元 · 2026 H1 起滚动更新</small></div></div><button className={styles.secondary} disabled title="Excel 产物尚未接入，此预览不会生成虚假的工作簿"><Download size={15} />Excel 下载待接入</button></div>
          <div className={styles.segmented} role="group" aria-label="模型版本"><button aria-pressed={modelTab === "baseline"} onClick={() => setModelTab("baseline")}>当前基线 · {versions.model}</button><button disabled={!hasCandidate} aria-pressed={modelTab === "candidate"} onClick={() => setModelTab("candidate")}>本轮模型 · M02{failedModel ? "（不可用）" : state.phase === "rejected" ? "（未采用）" : state.phase === "published" ? "（已采用）" : "（候选）"}</button><button aria-pressed={modelTab === "original"} onClick={() => setModelTab("original")}>初始基线 · M01</button></div>
          {modelTab === "candidate" && state.phase === "rejected" && <div className={styles.warning}><CircleAlert size={18} /><div><strong>候选修订未采用，当前仍为 F01 / M01</strong><p>{state.decisionNote}</p></div></div>}
          {modelTab === "candidate" && failedModel ? <div className={styles.warning}><CircleAlert size={20} /><div><strong>M02 未通过重算，无法提供新估值</strong><p>外部链接缺失。继续使用 M01，待计算校验通过后再评估新版本。</p></div></div> : <div className={styles.modelMetrics}>{[
            { label: "H1 中国区收入增长", value: snapshot.revenue, kind: snapshot.actual ? "已披露实际 · 演示" : "原模型预测 · 演示", change: changes[0] },
            { label: "H2 中国区增长假设", value: snapshot.growth, kind: "未来假设 · 非实际结果", change: changes[1] },
            { label: "新品贡献", value: "待核实", kind: "未单独披露 · 不倒推数值", change: changes[2] },
          ].map((metric) => <button key={metric.label} onClick={() => inspect(metric.change)}><span>{metric.label}<ArrowUpRight size={14} /></span><strong>{metric.value}</strong><small>{metric.kind}</small></button>)}</div>}
          <section className={styles.section}><SectionHeading title="从经营输入到估值输出"><Badge>示例路径</Badge></SectionHeading><div className={styles.modelPath}>{["地区增长假设", "集团收入", "利润与现金流", "估值输出"].map((label, index) => <div key={label}><span>0{index + 1}</span><strong>{label}</strong><small>{["输入与实际 / 预测边界", "沿原模型聚合", "保留成本与现金流公式", "仅使用通过重算的结果"][index]}</small>{index < 3 && <ChevronRight size={18} />}</div>)}</div><button className={styles.textButton} onClick={() => inspect(changes[1])}>追踪增长假设的单元格路径<ArrowRight size={14} /></button></section>
          <div className={styles.bottomGrid}><section className={styles.section}><SectionHeading title="模型理解与校验" /><ul className={styles.checkList}><li><Check size={16} />实际与预测边界已区分<Badge>示例</Badge></li><li><Check size={16} />原公式与上传原件保留<Badge>示例</Badge></li><li><Check size={16} />期间、单位和业务口径可追溯<Badge>示例</Badge></li><li><CircleAlert size={16} />{failedModel ? "外链未解析，重算不可用" : "完整模型重算尚未连接预览"}</li></ul></section><section className={styles.section}><SectionHeading title="可交付文件" /><button className={styles.artifactLink} disabled={!finished} onClick={() => download("changes")}><FileSpreadsheet size={20} /><div><strong>本轮修改清单</strong><small>CSV · 原值、新值、类型与依据</small></div><Download size={16} /></button><button className={styles.artifactLink} disabled={!finished} onClick={() => download("report")}><FileText size={20} /><div><strong>研究更新说明</strong><small>Markdown · 含状态与未解决问题</small></div><Download size={16} /></button><p className={styles.footnote}>以上为可下载的演示文件。真实 Excel 将在模型产物接入后开放。</p></section></div>
        </>}

        {view === "evidence" && <>
          <div className={styles.evidenceToolbar}><label className={styles.search}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料、指标或来源" aria-label="搜索资料与证据" /></label><span className={styles.muted}>2 份资料 · 3 处示例证据</span></div>
          <section className={styles.section}><SectionHeading title="本轮来源与定位"><Badge>全部为演示摘录</Badge></SectionHeading><div className={styles.evidenceList}>{changes.filter((change) => `${change.metric} ${change.source} ${change.location}`.toLowerCase().includes(query.toLowerCase())).map((change) => <button key={change.id} onClick={() => inspect(change)}><span className={styles.documentIcon}><FileText size={22} /></span><div><strong>{change.source}</strong><p>{change.metric} · {change.location}</p><small>{change.period}</small></div><Badge>{change.id === "growth" ? "管理层展望" : change.id === "thesis" ? "披露限制" : "实际数据"}</Badge><ArrowUpRight size={17} /></button>)}</div>{!changes.some((change) => `${change.metric} ${change.source} ${change.location}`.toLowerCase().includes(query.toLowerCase())) && <div className={styles.inlineEmpty}>没有匹配的演示资料。试试“收入”或“报告”。</div>}</section>
          <div className={styles.warning}><CircleAlert size={18} /><div><strong>还需要哪些证据</strong><p>新品收入贡献、同店增长与门店效率。缺少披露的指标保留为未知，不用其他指标推算替代。</p></div></div>
        </>}

        {view === "history" && <div className={styles.historyGrid}>
          <section className={styles.section}><SectionHeading title="研究版本与检查记录" /><div className={styles.historyList}><button aria-pressed={historySelection === "round"} onClick={() => setHistorySelection("round")}><span className={styles.historyDot} /><div><small>本轮 · 2026.08.28</small><strong>半年度经营更新</strong><p>{phaseLabel(state.phase)} · {scenario.label}</p><Badge tone={statusTone}>{state.phase === "published" ? "当前框架 F02" : phaseLabel(state.phase)}</Badge></div><ChevronRight size={16} /></button><button aria-pressed={historySelection === "baseline"} onClick={() => setHistorySelection("baseline")}><span className={styles.historyDot} /><div><small>初始基线 · 2026.06.30</small><strong>首版研究与模型理解</strong><p>框架 F01 · 模型 M01</p><Badge>{versions.framework === "F01" ? "当前框架基线" : "历史版本"}</Badge></div><ChevronRight size={16} /></button></div></section>
          <section className={styles.section}><SectionHeading eyebrow={historySelection === "round" ? "UPDATE 002" : "BASELINE 001"} title={historySelection === "round" ? "这一轮为什么改变" : "首版研究基线"} /><p className={styles.historySummary}>{historySelection === "round" ? scenario.summary : "基于原始模型梳理地区增长、利润和现金流的传导关系。新品贡献与门店效率列为后续验证重点。"}</p>{historySelection === "round" ? <><ResultPair state={state} /><dl className={styles.historyDetails}><div><dt>采用的资料</dt><dd>半年度报告、管理层业绩交流（演示）</dd></div><div><dt>处理结果</dt><dd>{finished ? scenario.result : "尚未完成本轮检查"}</dd></div><div><dt>审阅意见</dt><dd>{state.decisionNote || (state.phase === "published" ? "仅补实际值，按演示规则自动发布。" : "暂无人工审批记录。")}</dd></div><div><dt>下一轮基线</dt><dd>框架 {versions.framework} / 模型 {versions.model}</dd></div></dl><button className={styles.textButton} onClick={() => navigate("updates")}>回看本轮差异与证据<ArrowRight size={14} /></button></> : <><div className={styles.baselineStatement}><BookOpen size={22} /><h3>品牌与渠道优势仍在，增长兑现是下一步关键。</h3><p>增长假设：H1 中国区 +8%，H2 +12%。这是当时的预测，不代表后来披露的实际。</p></div><ul className={styles.checkList}><li><Check size={16} />研究资料与预测版本已冻结（演示）</li><li><Check size={16} />两项关键不确定性保持开放</li><li><Check size={16} />后续更新不覆盖这份原始判断</li></ul><button className={styles.textButton} onClick={() => { setModelTab("original"); navigate("model"); }}>查看模型输入与路径<ArrowRight size={14} /></button></>}</section>
        </div>}
        <footer className={styles.pageFoot}><span>PE Workbench · 研究工作台预览</span><span>证据 → 判断 → 模型 → 版本</span></footer>
      </div>
    </main>

    <dialog ref={detailDialog} className={styles.drawer} aria-labelledby="evidence-title"><div className={styles.drawerHeader}><span className={styles.eyebrow}>EVIDENCE & MODEL TRACE</span><button className={styles.iconButton} aria-label="关闭证据详情" onClick={() => detailDialog.current?.close()}><X size={19} /></button></div><div className={styles.drawerBody}><Badge>{selected.kind} · 演示</Badge><h2 id="evidence-title">{selected.metric}</h2><p className={styles.muted}>{selected.period}</p><div className={styles.comparePair}><div><span>原模型 / 判断</span><strong>{selected.before}</strong></div><ArrowRight size={17} /><div><span>{state.scenario === "conflict" ? "当前处理" : state.phase === "rejected" ? "候选 · 未采用" : state.phase === "published" ? "本轮处理" : "本轮候选"}</span><strong>{state.scenario === "conflict" ? "待核实" : selected.proposed}</strong></div></div><section><h3>为什么需要关注</h3><p>{selected.reason}</p></section><section><h3><FileText size={16} />来源摘录</h3><span className={styles.muted}>{selected.source} · {selected.location}</span><blockquote>{selected.quote}</blockquote><small className={styles.footnote}>这是用于测试交互的虚构原文，不是实际公司披露。</small></section><section><h3><Link2 size={16} />影响与计算路径</h3><ol className={styles.trace}>{selected.path.map((cell, index) => <li key={cell}><span>{index + 1}</span><code>{cell}</code></li>)}</ol></section><section className={styles.drawerIssue}><CircleAlert size={17} /><div><strong>仍需核实</strong><p>变化能否持续，以及其对未来利润和现金流的影响。未来预测不等于已经发生的事实。</p></div></section></div><div className={styles.drawerFooter}><button className={styles.secondary} onClick={() => detailDialog.current?.close()}>返回当前比较</button></div></dialog>

    <dialog ref={decisionDialog} className={styles.dialog} aria-labelledby="decision-title"><form onSubmit={(event) => { event.preventDefault(); if (note.trim().length < 8 || !reviewing) return; dispatch({ type: "decide", decision, note }); decisionDialog.current?.close(); setReceipt(decision === "approve" ? "本轮演示已发布，可在版本历史中查看。" : "已保留原版本，审阅原因已记录。"); }}><div className={styles.dialogHeading}><ShieldCheck size={25} /><button type="button" className={styles.iconButton} aria-label="关闭审阅" onClick={() => decisionDialog.current?.close()}><X size={18} /></button></div><h2 id="decision-title">{decision === "approve" ? failedModel ? "仅发布框架更新" : "采用本轮局部修订" : "保留当前研究版本"}</h2><p>{decision === "reject" ? "候选记录保留，下一轮继续从 F01 / M01 开始。" : failedModel ? "框架更新至 F02；模型继续使用 M01，不发布重算失败的候选模型。" : "框架与模型更新为 F02 / M02。原始版本、证据与未解决问题继续保留。"}</p><div className={styles.decisionSummary}><span>关键假设</span><strong>{failedModel ? "新品论据降低置信度" : "H2 中国区增长 +12% → +6%"}</strong><span>需要继续跟踪</span><strong>新品贡献、门店效率</strong></div><label className={styles.field}>审阅意见<textarea autoFocus rows={4} value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明采用或保留的理由，至少 8 个字符" minLength={8} required /></label><small className={styles.footnote}>演示操作，不发布到真实项目。</small><div className={styles.dialogActions}><button type="button" className={styles.secondary} onClick={() => decisionDialog.current?.close()}>取消</button><button className={styles.primary} type="submit" disabled={note.trim().length < 8}>{decision === "approve" ? "确认发布（演示）" : "确认保留原版本"}</button></div></form></dialog>

    <dialog ref={settingsDialog} className={styles.dialog} aria-labelledby="tracking-title"><div className={styles.settingsBody}><div className={styles.dialogHeading}><Bell size={23} /><button className={styles.iconButton} aria-label="关闭跟踪设置" onClick={() => settingsDialog.current?.close()}><X size={18} /></button></div><h2 id="tracking-title">持续跟踪计划</h2><p>本面板展示未来业务入口，当前仅切换演示状态。</p><dl className={styles.historyDetails}><div><dt>检查频率</dt><dd>每 24 小时</dd></div><div><dt>关注来源</dt><dd>官方财报、公司公告、经营数据</dd></div><div><dt>发布规则</dt><dd>仅补实际值可自动发布；重大假设需审阅</dd></div></dl><button className={styles.primary} onClick={() => { dispatch({ type: "tracking" }); settingsDialog.current?.close(); setReceipt(state.tracking ? "演示跟踪状态已暂停；未操作真实任务。" : "演示跟踪状态已开启；未启动真实任务。"); }}>{state.tracking ? <Pause size={15} /> : <Play size={15} />}{state.tracking ? "暂停演示跟踪" : "开启演示跟踪"}</button></div></dialog>
    {receipt && <div className={styles.toast} role="status"><Check size={16} /><span>{receipt}</span><button aria-label="关闭提示" onClick={() => setReceipt("")}><X size={15} /></button></div>}
  </div>;
}
