"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { BookOpen, ChartNoAxesCombined, FileText, Settings } from "lucide-react";
import type { FrameworkContent, FrameworkState, ResearchContinuation, getPeMemoVersion, getResearchMonitor } from "@earendil-works/pe-boot";
import type { PeProjectCatalog, PeProjectSummary } from "@/lib/pe-project-types";
import type { FrameworkProposal } from "@/lib/framework-proposal";
import { PeSourceCitation } from "./PeSourceCitation";
import { MarkdownBody } from "./MarkdownBody";
import { FrameworkTimeline } from "./FrameworkTimeline";
import { PeMonitorPanel } from "./PeMonitorPanel";
import { PeStockTracking } from "./PeStockTracking";
import { FrameworkConfirmation, ResearchRail } from "./research-ui/ResearchUI";
import { frameworkReportMarkdown, reportParagraphs, reportCoverage } from "@/lib/framework-report";
export { frameworkReportMarkdown } from "@/lib/framework-report";
import styles from "./PeFrameworkPanel.module.css";

type Snapshot = { framework: FrameworkState; memos: ReturnType<typeof getPeMemoVersion>[]; continuations: ResearchContinuation[]; monitor: ReturnType<typeof getResearchMonitor> };
type View = "framework" | "memo" | "tracking" | "notebook" | null;

export function usePeResearch(cwd: string | undefined, settledKey: string) {
  const [loaded, setLoaded] = useState<{ cwd: string; project: PeProjectSummary; snapshot: Snapshot } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<View>(null);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    if (view !== "framework") return;
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [view, refresh]);
  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    async function load() {
      try {
        const catalogResponse = await fetch("/api/pe/projects", { signal: controller.signal, cache: "no-store" });
        if (!catalogResponse.ok) throw new Error("无法读取项目，请稍后重试。");
        const catalog: PeProjectCatalog = await catalogResponse.json();
        const project = catalog.projects.find((entry) => entry.root === cwd);
        if (!project) { if (!controller.signal.aborted) setLoaded(null); return; }
        const response = await fetch(`/api/pe/frameworks?${new URLSearchParams({ datasetId: project.datasetId })}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("成果暂时无法读取，请稍后重试。");
        const snapshot: Snapshot = await response.json();
        if (!controller.signal.aborted) { setLoaded({ cwd: cwd!, project, snapshot }); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
      }
    }
    void load();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [cwd, settledKey, reload, refresh]);
  const data = loaded?.cwd === cwd ? loaded : null;
  return { ...data, error, refresh, view, setView, settledKey };
}
type Research = ReturnType<typeof usePeResearch>;

function ReportText({ text }: { text: string }) {
  return <>{reportParagraphs(text).map((paragraph, index) => {
    const label = paragraph.match(/^(原判断|新证据|外部证据|调整原因|新增条目|新证据为|证据可得性)：/);
    return <p key={index}>{label ? <><strong>{label[0]}</strong>{paragraph.slice(label[0].length)}</> : paragraph}</p>;
  })}</>;
}

export function FrameworkText({ content, cwd, downloadUrl }: { content: FrameworkContent; cwd: string; downloadUrl?: string }) {
  const [filter, setFilter] = useState("all");
  const [report, setReport] = useState(true);
  const Item = report ? "section" : "details";
  const ItemHeading = report ? "div" : "summary";
  function downloadReport() {
    const url = URL.createObjectURL(new Blob([frameworkReportMarkdown(content)], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${content.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const gaps = reportCoverage(content.coverageGaps);
  const kinds = { thesis: "核心论点", hypothesis: "关键假设", metric: "跟踪指标", question: "待核实问题", event: "经营事件" };
  const items = content.items.filter((item) => report || filter === "all" || item.kind === filter);
  return <article className={`${styles.document} ${styles.framework}`}>
    <div className={styles.reportActions}>
      <div role="group" aria-label="报告展示方式"><button type="button" aria-pressed={report} onClick={() => setReport(true)}>完整报告</button><button type="button" aria-pressed={!report} onClick={() => setReport(false)}>按条目浏览</button></div>
      {downloadUrl ? <a href={downloadUrl} download>下载完整报告 · Markdown</a> : <button type="button" onClick={downloadReport}>下载完整报告 · Markdown</button>}
    </div>
    <h2>{content.title}</h2>
    {report ? <div className={styles.reportIntro}><h3>研究目标</h3><ReportText text={content.objective} /><h3>研究期限</h3><ReportText text={content.horizon} /></div> : <details className={styles.scope}><summary>研究目标与期限</summary><ReportText text={content.objective} /><ReportText text={content.horizon} /></details>}
    {!report && <div className={styles.frameworkToolbar}>
      <strong>判断与跟踪 <span>{content.items.length}</span></strong>
      <select aria-label="筛选框架条目" value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">全部条目</option>
        {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select>
    </div>}
    {items.map((item) => <Item className={styles.frameworkItem} key={`${report}-${item.id}`}>
      <ItemHeading>
        <span className={styles.itemMeta}>{kinds[item.kind]}{item.origin === "user" ? " · 用户假设，待验证" : ""}</span>
        <h3>{item.subject}</h3>
        {!report && <span className={styles.claimPreview}>{item.claim}</span>}
      </ItemHeading>
      <div className={styles.itemBody}>
        <div className={styles.fullClaim}><ReportText text={item.claim} /></div>
        {!report && <><h4>判断依据</h4><ReportText text={item.rationale} /></>}
        <dl className={styles.verification}><div><dt>如何验证</dt><dd><ReportText text={item.verification} /></dd></div><div><dt>何时失效</dt><dd><ReportText text={item.invalidation} /></dd></div></dl>
        {item.evidenceIds.length > 0 && <div className={styles.sources}>{item.evidenceIds.map((id, i) => <PeSourceCitation key={id} cwd={cwd} evidenceId={id}>来源 {i + 1}</PeSourceCitation>)}</div>}
      </div>
    </Item>)}
    {items.length === 0 && <p className={styles.empty}>当前框架没有此类条目。</p>}
    {gaps.length > 0 && <Item className={styles.coverage} key={String(report)}><ItemHeading>影响判断的关键限制</ItemHeading><ul>{gaps.map((gap, i) => <li key={i}><ReportText text={gap} /></li>)}</ul></Item>}
  </article>;
}

export function PeFrameworkConfirmation({ proposal, research, sessionId, ensureEventsConnected }: { proposal: FrameworkProposal; research: Research; sessionId: string | null; ensureEventsConnected: (sessionId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const [saved, setSaved] = useState<ResearchContinuation | null>(null);
  const [continuationError, setContinuationError] = useState("");
  const continuation = saved ?? research.snapshot?.continuations?.find((item) => item.draftId === proposal.draftId);
  const draft = research.snapshot?.framework.drafts.find((entry) => entry.id === proposal.draftId);
  if (!research.project || research.project.datasetId !== proposal.datasetId || !draft) return null;
  const published = !!saved || draft.status === "published";
  const stale = !published && (draft.revision !== proposal.revision || draft.baseVersionId !== research.snapshot?.framework.currentVersionId || draft.status !== "open");
  async function resume(receipt: ResearchContinuation) {
    if (receipt.sessionId !== sessionId) throw new Error("请回到生成框架的来源会话继续研究。");
    await ensureEventsConnected(receipt.sessionId);
    const response = await fetch("/api/pe/frameworks", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasetId: proposal.datasetId, action: "continue", versionId: receipt.versionId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "框架已确认，继续研究失败，请重试。");
    setSaved(result.continuation);
    setContinuationError(result.continuation.error ?? "");
  }
  async function confirm() {
    if (inFlight.current || !draft || !sessionId) return;
    inFlight.current = true;
    setBusy(true); setError("");
    setContinuationError("");
    try {
      const response = await fetch("/api/pe/frameworks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId: proposal.datasetId, action: "confirm", draftId: draft.id, revision: proposal.revision, expectedVersionId: draft.baseVersionId, sessionId, toolCallId: proposal.toolCallId }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "框架或资料已更新，请在对话中让 Agent 基于最新内容重新整理。" : "未能确认，草稿已保留，请重试。");
      research.refresh(); research.setView("framework");
      const result = await response.json();
      setSaved(result.continuation);
      try { await resume(result.continuation); }
      catch (cause) { setContinuationError(cause instanceof Error ? cause.message : "继续研究失败"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "确认失败，请重试。"); }
    finally { inFlight.current = false; setBusy(false); research.refresh(); }
  }
  return <div>
    <FrameworkConfirmation status={published ? "confirmed" : busy ? "pending" : stale || !sessionId ? "stale" : error ? "error" : "draft"}
      onConfirm={() => void confirm()} error={error} preview={!stale && <FrameworkText content={draft.content} cwd={research.project.root} />} />
    {published && continuation && <div className={styles.confirmation}>
      <p role="status">{busy ? "正在连接来源会话…" : continuation.status === "delivered" ? "确认已交给 Agent；执行结果请查看对话。" : "框架已保存，等待继续研究。"}</p>
      {(continuationError || continuation.error) && <p role="alert">{continuationError || continuation.error}</p>}
      {continuation.sessionId === sessionId && (continuation.status !== "delivered" || continuationError) && <button className={styles.confirm} type="button" disabled={busy} onClick={async () => {
        if (inFlight.current) return; inFlight.current = true; setBusy(true); setContinuationError("");
        try { await resume(continuation); } catch (cause) { setContinuationError(cause instanceof Error ? cause.message : "继续研究失败"); }
        finally { inFlight.current = false; setBusy(false); research.refresh(); }
      }}>{continuation.status === "sending" || continuation.status === "delivered" ? "检查续接状态" : "继续研究"}</button>}
    </div>}
  </div>;
}

export function PeResearchRail({ research, model, agentUnavailable = false, notebook }: {
  research: Research; model?: { provider: string; modelId: string }; agentUnavailable?: boolean; notebook?: ReactNode;
}) {
  const { project, snapshot, view, setView, error } = research;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const current = snapshot?.framework.versions.find((entry) => entry.id === snapshot.framework.currentVersionId);
  const displayed = snapshot?.framework.versions.find((entry) => entry.id === selectedVersion) ?? current;
  if (!project && !error) return null;
  const failure = error && <p role="alert">{error}<button type="button" onClick={research.refresh}>重试</button></p>;
  return <ResearchRail selectedId={view} onSelect={(id) => setView(id === "framework" || id === "memo" || id === "tracking" || id === "notebook" ? id : null)} artifacts={[
    ...(notebook ? [{ id: "notebook", label: "研究积累", icon: <BookOpen size={18} />, subtitle: project?.name, content: notebook, footer: false as const }] : []),
    { id: "framework", label: "投资框架", icon: <BookOpen size={18} />, subtitle: `${project?.name ?? ""}${displayed ? ` · 阅读 v${displayed.version}${displayed.id === current?.id ? " · 最新版本" : " · 历史版本"}` : ""}`,
      headerActions: <Popover.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Popover.Trigger aria-label="投资框架设置" title="投资框架设置"><Settings size={18} /></Popover.Trigger>
        <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={10} className={styles.settingsPositioner}>
          <Popover.Popup className={styles.settingsPopup} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSettingsOpen(false); } }}>
            <Popover.Title className={styles.settingsTitle}>投资框架设置</Popover.Title>
            {project && snapshot?.monitor && <PeMonitorPanel key={`settings-${project.datasetId}-${snapshot.monitor.revision}`} project={project} monitor={snapshot.monitor} framework={snapshot.framework} refresh={research.refresh} mode="settings" />}
          </Popover.Popup>
        </Popover.Positioner></Popover.Portal>
      </Popover.Root>,
      content: <>{failure}{displayed && project ? <div className={styles.frameworkReader}><FrameworkTimeline key={project.datasetId} versions={snapshot?.framework.versions ?? []} selectedId={displayed.id} currentId={snapshot?.framework.currentVersionId ?? null} onSelect={setSelectedVersion} /><FrameworkText key={displayed.id} content={displayed.content} cwd={project.root} downloadUrl={`/api/pe/frameworks?${new URLSearchParams({ datasetId: project.datasetId, download: displayed.id })}`} /></div> : <div className={styles.empty}><h2>让判断在对话中成形</h2><p>和 Agent 讨论投资逻辑，生成后点击回复下方的「确定投资框架」。</p></div>}{project && snapshot?.monitor && <details className={styles.trackingDisclosure}><summary>最新变化与自动跟踪{snapshot.monitor.runs[0]?.status === "review_required" ? " · 有待确认的调整" : ""}</summary><PeMonitorPanel key={`${project.datasetId}-${snapshot.monitor.revision}`} project={project} monitor={snapshot.monitor} framework={snapshot.framework} refresh={research.refresh} mode="activity" /></details>}</> },
    { id: "memo", label: "Memo", icon: <FileText size={18} />, subtitle: project?.name,
      content: <>{failure}{snapshot?.memos.length && project ? snapshot.memos.map((memo) => <article className={styles.document} key={memo.memo_version_id}><small>Memo · v{memo.version_no} · {memo.as_of_date}</small><h2>{memo.series_title}</h2>{memo.sections.map((section) => <section key={section.section_id}><h3>{section.title}</h3><MarkdownBody cwd={project.root}>{section.content}</MarkdownBody>{section.needs_review && <small>待进一步验证</small>}{section.evidence_ids.map((id, i) => <PeSourceCitation key={id} cwd={project.root} evidenceId={id}>来源 {i + 1}</PeSourceCitation>)}</section>)}</article>) : <div className={styles.empty}><h2>研究沉淀成文</h2><p>在对话中让 Agent 生成 Memo，完成后会自动出现在这里。</p></div>}</> },
    { id: "tracking", label: "股票追踪", icon: <ChartNoAxesCombined size={18} />, subtitle: project?.name, wide: true, footer: false,
      content: <>{failure}{project && <PeStockTracking key={project.datasetId} project={project} model={model} agentUnavailable={agentUnavailable} settledKey={research.settledKey} />}</> },
  ]} />;
}
