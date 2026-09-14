"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FileText } from "lucide-react";
import type { FrameworkContent, FrameworkState, ResearchContinuation, getPeMemoVersion, getResearchMonitor } from "@earendil-works/pe-boot";
import type { PeProjectCatalog, PeProjectSummary } from "@/lib/pe-project-types";
import type { FrameworkProposal } from "@/lib/framework-proposal";
import { PeSourceCitation } from "./PeSourceCitation";
import { MarkdownBody } from "./MarkdownBody";
import { PeMonitorPanel } from "./PeMonitorPanel";
import { ArtifactVersions, FrameworkConfirmation, ResearchRail } from "./research-ui/ResearchUI";
import styles from "./PeFrameworkPanel.module.css";

type Snapshot = { framework: FrameworkState; memos: ReturnType<typeof getPeMemoVersion>[]; continuations: ResearchContinuation[]; monitor: ReturnType<typeof getResearchMonitor> };
type View = "framework" | "memo" | null;

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
  return { ...data, error, refresh, view, setView };
}
type Research = ReturnType<typeof usePeResearch>;

function FrameworkText({ content, cwd }: { content: FrameworkContent; cwd: string }) {
  return <article className={styles.document}>
    <h2>{content.title}</h2><p>{content.objective}</p><small>{content.horizon}</small>
    {content.items.map((item, index) => <section key={item.id}>
      <small>{String(index + 1).padStart(2, "0")} · {item.subject}</small>
      <h3>{item.claim}</h3><p>{item.rationale}</p>
      <dl><dt>如何验证</dt><dd>{item.verification}</dd><dt>何时失效</dt><dd>{item.invalidation}</dd></dl>
      {item.origin === "user" && <small>待验证假设</small>}
      {item.evidenceIds.map((id, i) => <PeSourceCitation key={id} cwd={cwd} evidenceId={id}>来源 {i + 1}</PeSourceCitation>)}
    </section>)}
    {content.coverageGaps.length > 0 && <section><h3>还需要了解</h3>{content.coverageGaps.map((gap, i) => <p key={i}>{gap}</p>)}</section>}
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

export function PeResearchRail({ research }: { research: Research }) {
  const { project, snapshot, view, setView, error } = research;
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const current = snapshot?.framework.versions.find((entry) => entry.id === snapshot.framework.currentVersionId);
  const displayed = snapshot?.framework.versions.find((entry) => entry.id === selectedVersion) ?? current;
  const versions = [...(snapshot?.framework.versions ?? [])].reverse().map((entry) => ({ id: entry.id, label: `v${entry.version}${entry.id === current?.id ? " · 当前版本" : " · 历史版本"}` }));
  if (!project && !error) return null;
  const failure = error && <p role="alert">{error}<button type="button" onClick={research.refresh}>重试</button></p>;
  return <ResearchRail selectedId={view} onSelect={(id) => setView(id === "framework" || id === "memo" ? id : null)} artifacts={[
    { id: "framework", label: "投资框架", icon: <BookOpen size={18} />, subtitle: `${project?.name ?? ""}${current ? ` · 当前 v${current.version}` : ""}`,
      content: <>{failure}{project && snapshot?.monitor && <PeMonitorPanel key={`${project.datasetId}-${snapshot.monitor.revision}`} project={project} monitor={snapshot.monitor} framework={snapshot.framework} refresh={research.refresh} />}{displayed && project ? <details className={styles.frameworkReader}><summary>完整框架与历史版本</summary><ArtifactVersions versions={versions} selectedId={displayed.id} onSelect={setSelectedVersion} /><FrameworkText content={displayed.content} cwd={project.root} /></details> : <div className={styles.empty}><h2>让判断在对话中成形</h2><p>和 Agent 讨论投资逻辑，生成后点击回复下方的「确定投资框架」。</p></div>}</> },
    { id: "memo", label: "Memo", icon: <FileText size={18} />, subtitle: project?.name,
      content: <>{failure}{snapshot?.memos.length && project ? snapshot.memos.map((memo) => <article className={styles.document} key={memo.memo_version_id}><small>Memo · v{memo.version_no} · {memo.as_of_date}</small><h2>{memo.series_title}</h2>{memo.sections.map((section) => <section key={section.section_id}><h3>{section.title}</h3><MarkdownBody cwd={project.root}>{section.content}</MarkdownBody>{section.needs_review && <small>待进一步验证</small>}{section.evidence_ids.map((id, i) => <PeSourceCitation key={id} cwd={project.root} evidenceId={id}>来源 {i + 1}</PeSourceCitation>)}</section>)}</article>) : <div className={styles.empty}><h2>研究沉淀成文</h2><p>在对话中让 Agent 生成 Memo，完成后会自动出现在这里。</p></div>}</> },
  ]} />;
}
