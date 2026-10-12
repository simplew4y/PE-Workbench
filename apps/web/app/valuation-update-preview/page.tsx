"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileCheck2,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  Link2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import styles from "./preview.module.css";

type PageId = "overview" | "changes" | "evidence" | "history";
type Decision = "candidate" | "reviewed" | "rejected";
type DecisionAction = "approve" | "reject";

const navigation: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "更新概览", icon: LayoutDashboard },
  { id: "changes", label: "模型修改", icon: FileSpreadsheet },
  { id: "evidence", label: "依据与问题", icon: FileCheck2 },
  { id: "history", label: "版本历史", icon: History },
];

const changes = [
  {
    id: "actual",
    location: "China Revenue!F18",
    label: "中国区 H1 收入增长",
    kind: "实际值",
    before: "+2%",
    after: "-4%",
    impact: -2,
    reason: "H1 财报披露的可比口径实际值替代原占位预测。",
    evidence: ["H1 2026 财报，第 18 页", "管理层业绩电话会，第 12 分钟"],
    formulaPath: ["China Revenue!F18", "Income Statement!F24", "DCF!B37"],
  },
  {
    id: "assumption",
    location: "Assumptions!J12",
    label: "中国区下半年收入增长",
    kind: "假设修订",
    before: "+12%",
    after: "+3%",
    impact: -9,
    reason: "原预测与实际、行业方向相反，且没有足以支持逆势高增长的公司特异性证据。",
    evidence: ["中国奢侈品行业跟踪，2026-07-28", "财报前一致预期：+1%"],
    formulaPath: ["Assumptions!J12", "China Revenue!J18", "EPS!J31", "DCF!B37"],
  },
] as const;

const valuationBridge = [
  { id: "start", label: "原模型", value: 110, delta: 0 },
  { id: "actual", label: "实际值与汇率", value: 108, delta: -2 },
  { id: "assumption", label: "中国区假设", value: 99, delta: -9 },
] as const;

function StatusTag({ decision }: { decision: Decision }) {
  const labels = { candidate: "Candidate", reviewed: "Reviewed", rejected: "Rejected" };
  return <span className={styles.statusTag} data-status={decision}>{labels[decision]}</span>;
}

export default function ValuationUpdatePreview() {
  const [page, setPage] = useState<PageId>("overview");
  const [decision, setDecision] = useState<Decision>("candidate");
  const [selectedChange, setSelectedChange] = useState<(typeof changes)[number]["id"]>("assumption");
  const [dialogAction, setDialogAction] = useState<DecisionAction>("approve");
  const [reviewNote, setReviewNote] = useState("");
  const [keepOpenIssue, setKeepOpenIssue] = useState(true);
  const [receipt, setReceipt] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selected = changes.find((change) => change.id === selectedChange) ?? changes[0];
  const canConfirm = reviewNote.trim().length >= 8 && (dialogAction === "reject" || keepOpenIssue);

  function openDecision(action: DecisionAction) {
    setDialogAction(action);
    setReviewNote("");
    setKeepOpenIssue(true);
    dialogRef.current?.showModal();
  }

  function confirmDecision() {
    if (!canConfirm) return;
    const nextDecision = dialogAction === "approve" ? "reviewed" : "rejected";
    setDecision(nextDecision);
    setReceipt(
      nextDecision === "reviewed"
        ? "v2026.07 已成为当前基线；下一轮将从该版本继续更新。"
        : "候选假设已拒绝；H1 实际值版本仍为当前基线。",
    );
    dialogRef.current?.close();
  }

  function downloadChangeSet() {
    const rows = [
      ["位置", "类型", "原值", "新值", "估值影响", "原因"],
      ...changes.map((change) => [change.location, change.kind, change.before, change.after, `${change.impact}`, change.reason]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "hermes-2026h1-model-change-set.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setReceipt("修改清单已下载。正式接入后，同一位置将下载重算后的 Excel。 ");
  }

  return (
    <main className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><span>研</span><strong>投研工作台</strong></div>
        <p className={styles.navLabel}>估值模型</p>
        <nav className={styles.navigation} aria-label="估值模型页面">
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} type="button" className={page === item.id ? styles.activeNav : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => setPage(item.id)}><Icon size={17} />{item.label}</button>;
          })}
        </nav>
        <div className={styles.sidebarFoot}>
          <Link href="/"><ArrowLeft size={15} />返回工作区</Link>
          <small>交互预览 · 模拟数据</small>
        </div>
      </aside>

      <section className={styles.main}>
        <header className={styles.topbar}>
          <div><strong>Hermès International</strong><span>H1 2026 滚动更新</span></div>
          <div className={styles.baseline}><span />{decision === "reviewed" ? "当前基线：v2026.07" : "当前基线：v2026.06"}</div>
        </header>

        <div className={styles.content}>
          {page === "overview" && <Overview decision={decision} onApprove={() => openDecision("approve")} onReject={() => openDecision("reject")} onDownload={downloadChangeSet} onInspect={(id) => { setSelectedChange(id); setPage("changes"); }} />}
          {page === "changes" && <Changes decision={decision} selectedId={selectedChange} onSelect={setSelectedChange} selected={selected} />}
          {page === "evidence" && <Evidence onInspect={() => { setSelectedChange("assumption"); setPage("changes"); }} />}
          {page === "history" && <VersionHistory decision={decision} />}
        </div>
        {receipt && <div className={styles.receipt} role="status"><Check size={16} />{receipt}<button type="button" aria-label="关闭提示" onClick={() => setReceipt("")}><X size={15} /></button></div>}
      </section>

      <dialog ref={dialogRef} className={styles.dialog} onClose={() => setReviewNote("")}>
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <header><div className={styles.dialogIcon}>{dialogAction === "approve" ? <ShieldCheck size={22} /> : <CircleAlert size={22} />}</div><div><h2>{dialogAction === "approve" ? "批准候选版本" : "拒绝候选假设"}</h2><p>{dialogAction === "approve" ? "批准后，v2026.07 将成为下一轮滚动更新基线。" : "拒绝不会删除候选版本，审批记录也不可修改。"}</p></div></header>
          {dialogAction === "approve" && <dl className={styles.dialogSummary}><div><dt>采用情景</dt><dd>基准情景 · 中国区增长 +3%</dd></div><div><dt>目标估值</dt><dd>€99</dd></div><div><dt>未解决问题</dt><dd>2 项继续跟踪</dd></div></dl>}
          <label className={styles.noteField}>审批意见<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="说明批准或拒绝的判断依据（至少 8 个字符）" rows={3} /></label>
          {dialogAction === "approve" && <label className={styles.checkField}><input type="checkbox" checked={keepOpenIssue} onChange={(event) => setKeepOpenIssue(event.target.checked)} /><span>保留“新品与门店扩张能否抵消行业压力”为未解决问题</span></label>}
          <footer><button type="button" onClick={() => dialogRef.current?.close()}>取消</button><button type="button" className={dialogAction === "approve" ? styles.primaryButton : styles.dangerButton} disabled={!canConfirm} onClick={confirmDecision}>{dialogAction === "approve" ? "确认批准并设为基线" : "确认拒绝"}</button></footer>
        </form>
      </dialog>
    </main>
  );
}

function Overview({ decision, onApprove, onReject, onDownload, onInspect }: { decision: Decision; onApprove: () => void; onReject: () => void; onDownload: () => void; onInspect: (id: (typeof changes)[number]["id"]) => void }) {
  return <>
    <div className={styles.heading}><div><p>估值模型 / 更新批次 2026-H1</p><h1>{decision === "candidate" ? "本轮更新需要你的判断" : decision === "reviewed" ? "本轮更新已复核" : "候选假设未采用"}</h1><span>实际值已补入；中国区收入假设与最新证据存在实质冲突。</span></div><button type="button" className={styles.secondaryButton} onClick={onDownload}><Download size={16} />下载修改清单</button></div>
    <div className={styles.metrics}>
      <Metric label="原模型估值" value="€110" note="v2026.03 正式版本" />
      <Metric label="补实际值后" value="€108" note="-1.8% · 汇率与利润率" tone="negative" />
      <Metric label="候选基准情景" value="€99" note="-10.0% · 假设调整" tone="negative" />
      <Metric label="版本状态" value={decision === "candidate" ? "待复核" : decision === "reviewed" ? "已复核" : "已拒绝"} note={decision === "candidate" ? "不可进入下一轮基线" : decision === "reviewed" ? "下一轮从此版本继续" : "继续沿用 v2026.06"} />
    </div>
    <div className={styles.decisionBanner} data-decision={decision}><CircleAlert size={19} /><div><strong>{decision === "candidate" ? "强冲突：原预测与实际、行业方向相反" : decision === "reviewed" ? "候选版本已成为新的滚动更新基线" : "候选假设已拒绝，旧假设暂时保留"}</strong><span>{decision === "candidate" ? "系统没有覆盖旧值，而是生成了可复核的三情景候选版本。" : "原始版本、修改证据和审批意见继续保留。"}</span></div><StatusTag decision={decision} /></div>
    <div className={styles.overviewGrid}>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><div><p>估值变化归因</p><h2>€110 → €99</h2></div><span>单位：每股</span></div>
        <div className={styles.bridge} aria-label="估值变化归因：原模型110欧元，实际值与汇率影响负2欧元，中国区假设影响负9欧元，候选估值99欧元">
          {valuationBridge.map((item, index) => <button type="button" key={item.id} className={styles.bridgeItem} onClick={() => item.id !== "start" && onInspect(item.id)} disabled={item.id === "start"}><span className={styles.bridgeValue}>€{item.value}</span><span className={styles.bridgeBar} style={{ height: `${Math.max(32, item.value - 72)}%` }} /><strong>{item.label}</strong><small>{index === 0 ? "起点" : `${item.delta} 欧元`}</small></button>)}
          <div className={styles.bridgeConnector} aria-hidden="true" />
        </div>
        <p className={styles.caption}>归因来自按变更组依次重算的结果。点击影响项查看单元格与公式路径。</p>
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeading}><div><p>需要复核的假设</p><h2>中国区收入增长</h2></div><span className={styles.warningPill}>方向冲突</span></div>
        <div className={styles.comparison}><div><span>原预测</span><strong>+12%</strong></div><div><span>一致预期</span><strong>+1%</strong></div><div><span>实际</span><strong className={styles.negative}>-4%</strong></div></div>
        <ul className={styles.reasons}><li>实际与原预测方向相反，偏差 16 个百分点。</li><li>行业维持负增长，暂无足以支持逆势高增长的证据。</li></ul>
        <div className={styles.scenarios}><div><span>悲观</span><i><b style={{ width: "20%" }} /></i><strong>-5%</strong></div><div><span>基准</span><i><b style={{ width: "52%" }} /></i><strong>+3%</strong></div><div><span>乐观</span><i><b style={{ width: "72%" }} /></i><strong>+8%</strong></div></div>
        <button type="button" className={styles.textButton} onClick={() => onInspect("assumption")}>查看证据与模型传导<ArrowRight size={14} /></button>
        <div className={styles.actions}><button type="button" disabled={decision !== "candidate"} onClick={onReject}>拒绝</button><button type="button" className={styles.primaryButton} disabled={decision !== "candidate"} onClick={onApprove}>{decision === "reviewed" ? "已设为基线" : decision === "rejected" ? "已拒绝" : "审核候选版本"}</button></div>
      </section>
    </div>
  </>;
}

function Changes({ decision, selectedId, onSelect, selected }: { decision: Decision; selectedId: (typeof changes)[number]["id"]; onSelect: (id: (typeof changes)[number]["id"]) => void; selected: (typeof changes)[number] }) {
  return <>
    <div className={styles.heading}><div><p>估值模型 / 变更清单</p><h1>模型修改与传导路径</h1><span>所有写入发生在副本；公式单元格不可直接覆盖。</span></div><StatusTag decision={decision} /></div>
    <div className={styles.changeLayout}>
      <section className={styles.panel}><table className={styles.table}><thead><tr><th>位置与指标</th><th>类型</th><th>原值</th><th>新值</th><th>估值影响</th></tr></thead><tbody>{changes.map((change) => <tr key={change.id} className={selectedId === change.id ? styles.selectedRow : ""} onClick={() => onSelect(change.id)}><td><button type="button" onClick={() => onSelect(change.id)}><strong>{change.label}</strong><small>{change.location}</small></button></td><td>{change.kind}</td><td>{change.before}</td><td>{change.after}</td><td className={styles.negative}>{change.impact} 欧元</td></tr>)}</tbody></table></section>
      <aside className={styles.detailPanel}>
        <div className={styles.detailHeading}><span>{selected.kind}</span><h2>{selected.label}</h2><code>{selected.location}</code></div>
        <section><h3>修改原因</h3><p>{selected.reason}</p></section>
        <section><h3>证据</h3>{selected.evidence.map((item) => <button type="button" className={styles.evidenceLink} key={item}><Link2 size={14} />{item}<ChevronRight size={14} /></button>)}</section>
        <section><h3>下游公式路径</h3><ol className={styles.formulaPath}>{selected.formulaPath.map((cell, index) => <li key={cell}><code>{cell}</code>{index < selected.formulaPath.length - 1 && <ArrowRight size={13} />}</li>)}</ol></section>
        <div className={styles.impactSummary}><span>对目标估值的复算影响</span><strong>{selected.impact} 欧元</strong></div>
      </aside>
    </div>
  </>;
}

function Evidence({ onInspect }: { onInspect: () => void }) {
  return <>
    <div className={styles.heading}><div><p>估值模型 / 修改依据</p><h1>证据与未解决问题</h1><span>证据和问题随版本保存，不会因下一轮更新被覆盖。</span></div></div>
    <div className={styles.evidenceGrid}>
      <section className={styles.panel}><div className={styles.panelHeading}><div><p>已使用证据</p><h2>3 项可定位来源</h2></div><FileCheck2 size={20} /></div><div className={styles.sourceList}><article><span>公司披露</span><strong>H1 2026 财报</strong><p>亚太地区销售承压，披露日期 2026-07-25。</p><button type="button">查看原文第 18 页<ChevronRight size={14} /></button></article><article><span>行业数据</span><strong>中国奢侈品市场跟踪</strong><p>行业维持负增长，渠道库存去化缓慢。</p><button type="button">查看来源<ChevronRight size={14} /></button></article><article><span>一致预期</span><strong>财报前市场预测</strong><p>中国区收入增长中位数为 +1%。</p><button type="button">查看快照<ChevronRight size={14} /></button></article></div></section>
      <section className={styles.panel}><div className={styles.panelHeading}><div><p>开放问题</p><h2>2 项继续跟踪</h2></div><CircleAlert size={20} /></div><ul className={styles.issueList}><li><strong>新品贡献</strong><span>下半年新品能否抵消客流下降？</span><small>下次检查：Q3 经营更新</small></li><li><strong>门店效率</strong><span>公司未单独披露中国区同店增长。</span><small>等待公司披露或渠道数据</small></li></ul><button type="button" className={styles.textButton} onClick={onInspect}>查看关联假设与单元格<ArrowRight size={14} /></button></section>
    </div>
  </>;
}

function VersionHistory({ decision }: { decision: Decision }) {
  const candidateMeta = decision === "reviewed" ? "当前基线 · 估值 €99 · 研究员已批准" : decision === "rejected" ? "已拒绝 · 估值 €99 · 不参与后续更新" : "候选版本 · 估值 €99 · 等待研究员批准";
  return <>
    <div className={styles.heading}><div><p>估值模型 / 版本历史</p><h1>滚动更新版本链</h1><span>当前基线决定下一轮从哪个模型继续。</span></div></div>
    <section className={styles.panel}><div className={styles.versionList}>
      <article><span className={decision === "reviewed" ? styles.currentDot : styles.versionDot} /><div><strong>v2026.07 · 中国区假设修订</strong><p>{candidateMeta}</p><small>原值 +12% → 基准情景 +3% · 估值影响 -€9</small></div><StatusTag decision={decision} /></article>
      <article><span className={decision === "reviewed" ? styles.versionDot : styles.currentDot} /><div><strong>v2026.06 · H1 实际值更新</strong><p>{decision === "reviewed" ? "历史版本" : "当前基线"} · 估值 €108 · 计算校验通过</p><small>补入财报实际值，未修改未来假设</small></div><span className={styles.neutralTag}>{decision === "reviewed" ? "历史" : "当前"}</span></article>
      <article><span className={styles.versionDot} /><div><strong>v2026.03 · 原始正式模型</strong><p>历史版本 · 估值 €110</p><small>本轮滚动更新的初始比较基线</small></div><span className={styles.neutralTag}>历史</span></article>
    </div></section>
  </>;
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "negative" }) {
  return <section className={styles.metric}><span>{label}</span><strong>{value}</strong><small className={tone === "negative" ? styles.negative : ""}>{note}</small></section>;
}
