"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Check, FileText, FlaskConical, Play, Upload, X } from "lucide-react";
import type { FrameworkContent, FrameworkIteration, FrameworkState, IterationImpacts, IterationObservations } from "@earendil-works/pe-boot";
import type { PeProjectCatalog, PeProjectSummary } from "@/lib/pe-project-types";
import { PeSourceCitation } from "./PeSourceCitation";
import { FrameworkText } from "./PeFrameworkPanel";
import { getPeModelServiceState, type PeModelServiceClientState } from "@/lib/pe-account-client";
import styles from "./FrameworkIterationTest.module.css";

type PublicRun = Omit<FrameworkIteration, "leaseToken" | "leaseUntil">;
interface Snapshot { run: PublicRun | null; files: { originalFilename: string; status: string }[]; runs: PublicRun[]; settings: { testProject: boolean }; framework: FrameworkState; modelId: string }
const states: Record<string, string> = { queued: "排队", running: "执行中", blocked: "待处理", review_required: "待确认", no_change: "无需调整", published: "已发布", failed: "失败", cancelled: "已取消", rejected: "未采用" };
const stages: Record<string, string> = { ingest: "解析入库", extract: "提取信息", impact: "分析判断影响", revise: "修订框架", validate: "校验", publish: "发布" };
async function json<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || value.message || "请求失败");
  return value;
}
export function FrameworkIterationTest() {
  const [projects, setProjects] = useState<PeProjectSummary[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runId, setRunId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [platform, setPlatform] = useState<PeModelServiceClientState | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const requestId = useRef<string | null>(null);
  const project = projects.find((p) => p.datasetId === datasetId);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([fetch("/api/pe/projects", { signal: controller.signal }).then(json<PeProjectCatalog>), getPeModelServiceState()]).then(([catalog, model]) => {
      if (controller.signal.aborted) return;
      setProjects(catalog.projects); setPlatform(model);
      const params = new URLSearchParams(window.location.search);
      setDatasetId(params.get("datasetId") || catalog.activeDatasetId || catalog.projects[0]?.datasetId || "");
      setRunId(params.get("runId") || "");
    }).catch((cause) => { if (!controller.signal.aborted) setError(String(cause.message)); });
    return () => controller.abort();
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!datasetId) return;
    const params = new URLSearchParams({ datasetId, ...(runId ? { runId } : {}) });
    const result = await json<Snapshot>(await fetch(`/api/pe/framework-iterations?${params}`, { cache: "no-store", signal }));
    if (!signal?.aborted) setSnapshot(result);
  }, [datasetId, runId]);
  useEffect(() => {
    if (!datasetId) return;
    const controller = new AbortController();
    const update = () => void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    update(); const timer = window.setInterval(update, 2000);
    const url = new URL(window.location.href); url.search = new URLSearchParams({ datasetId, ...(runId ? { runId } : {}) }).toString(); window.history.replaceState(null, "", url);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [datasetId, runId, refresh]);
  async function action(name: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try {
      await json(await fetch("/api/pe/framework-iterations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, runId: runId || snapshot?.run?.id || "", action: name, ...extra }) }));
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function start() {
    if (!snapshot?.framework.currentVersionId) return;
    setBusy(true); setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const form = new FormData(); form.set("datasetId", datasetId); form.set("basisVersionId", snapshot.framework.currentVersionId); form.set("requestId", requestId.current);
      for (const file of files) form.append("files", file);
      const result = await json<{ run: PublicRun }>(await fetch("/api/pe/framework-iterations", { method: "POST", body: form }));
      setRunId(result.run.id); requestId.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "启动失败"); }
    finally { setBusy(false); }
  }
  const run = snapshot?.run;
  const basis = snapshot?.framework.versions.find((v) => v.id === (run?.basisVersionId || snapshot.framework.currentVersionId));
  const draft = snapshot?.framework.drafts.find((d) => d.id === run?.draftId);
  const published = snapshot?.framework.versions.find((v) => v.id === run?.versionId);
  const observations = run?.artifacts.find((a) => a.stage === "extract")?.value as IterationObservations | undefined;
  const impacts = run?.artifacts.find((a) => a.stage === "impact")?.value as IterationImpacts | undefined;
  const candidate = published?.content || draft?.content || run?.artifacts.find((a) => a.stage === "revise")?.value as FrameworkContent | undefined;
  const activeRun = snapshot?.runs.some((r) => ["queued", "running"].includes(r.status));
  const canStart = !busy && !!files.length && !!snapshot?.framework.currentVersionId && platform?.source === "platform" && !activeRun;
  const startHint = !datasetId ? "先选择一个研究项目" : !snapshot ? "正在读取项目框架…" : !snapshot.framework.currentVersionId ? "请先在工作区确认七节研究框架" : platform?.source !== "platform" ? "请先在工作区选择平台模型" : activeRun ? "当前项目已有运行中的任务" : !files.length ? "添加资料后即可开始" : `已准备 ${files.length} 份资料`;
  function addFiles(incoming: File[]) {
    if (busy) return;
    const accepted = incoming.filter((file) => /\.(pdf|xlsx|xlsm)$/i.test(file.name));
    if (accepted.length !== incoming.length) setError("仅支持 PDF、XLSX 和 XLSM 文件。");
    setFiles((current) => [...current, ...accepted.filter((file) => !current.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified))]);
    requestId.current = null;
  }
  return <main className={styles.page}>
    <div className={styles.shell}>
    <nav className={styles.topbar} aria-label="页面导航"><span className={styles.brand}><FlaskConical size={19} /> PE Workbench <span className={styles.labTag}>测试</span></span><Link href="/"><ArrowLeft size={15} />返回工作区</Link></nav>
    <header className={styles.heading}><div><span className={styles.eyebrow}>研究工具 / 文档驱动迭代</span><h1>投资框架迭代测试</h1><p>用新增资料检验判断，追溯每一次框架变化。</p></div><span className={styles.headerNote}>资料 · 判断 · 证据</span></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.workspace}>
    <aside className={styles.sidebar}>
    <section className={styles.panel}><div className={styles.sectionHeading}><span className={styles.sectionNumber}>01</span><h2>准备测试</h2></div>
      <label className={styles.field}>研究项目<select value={datasetId} disabled={busy} onChange={(event) => { setDatasetId(event.target.value); setRunId(""); setSnapshot(null); setFiles([]); requestId.current = null; }}>{!projects.length && <option value="">暂无可用项目</option>}{projects.map((p) => <option key={p.datasetId} value={p.datasetId}>{p.name}</option>)}</select></label>
      <dl className={styles.context}><div><dt>有效基线</dt><dd>{basis ? `v${basis.version}` : "尚未确认"}</dd></div><div><dt>平台模型</dt><dd>{snapshot?.modelId || platform?.platform.selected_model || "未连接"}</dd></div></dl>
      {platform?.source !== "platform" && <p className={styles.notice}>在<Link href="/">工作区模型设置</Link>中选择平台模型后开始。</p>}
      <label className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
        <Upload size={25} strokeWidth={1.5} /><strong>添加新增资料</strong><span>点击选择，或拖入文件</span><small>PDF / XLSX / XLSM · 支持多份资料</small>
        <input aria-label="新增资料（PDF / XLSX / XLSM）" type="file" multiple accept=".pdf,.xlsx,.xlsm" disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      </label>
      {!!files.length && <ul className={styles.fileList}>{files.map((file, index) => <li key={`${file.name}-${index}`}><FileText size={16} /><span>{file.name}<small>{file.size < 1048576 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / 1048576).toFixed(1)} MB`}</small></span><button className={styles.iconButton} aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => { setFiles((current) => current.filter((_, i) => i !== index)); requestId.current = null; }}><X size={15} /></button></li>)}</ul>}
      {snapshot && <div className={styles.publishMode}><label><input type="checkbox" checked={snapshot.settings.testProject} disabled={busy || snapshot.runs.some((r) => ["queued", "running", "review_required"].includes(r.status))} onChange={(event) => void action("test-project", { enabled: event.target.checked })} /><span>登记为测试项目<small>校验通过且无疑点时自动发布</small></span></label><p>{snapshot.settings.testProject ? "有待核实问题时，仍需人工确认。" : "当前为普通项目，发布前需人工确认。"}</p></div>}
      <button className={styles.primary} disabled={!canStart} onClick={() => void start()}><Play size={15} />{busy ? "正在处理…" : "上传并运行完整流程"}</button><p className={styles.startHint}>{startHint}</p>
    </section>
    <div className={styles.help}><strong>先建立基线，再添加新资料</strong><p>在工作区确认七节研究框架后，上传本轮新增文件。每个测试场景建议独立运行。</p><Link href="/">前往工作区<ArrowUpRight size={14} /></Link></div>
    </aside>
    <div className={styles.content}>
    <section className={styles.panel}><div className={styles.sectionHeading}><span className={styles.sectionNumber}>02</span><h2>运行过程</h2>{run && <span className={styles.statusBadge} data-status={run.status} role="status">{states[run.status]}</span>}</div>
      <label className={styles.field}>运行记录<select value={runId} disabled={busy} onChange={(event) => setRunId(event.target.value)}><option value="">最新运行</option>{snapshot?.runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {states[r.status]}</option>)}</select></label>
      <ol className={styles.steps}>{Object.entries(stages).map(([key, label], index) => {
        const complete = !!run && (run.artifacts.some((a) => a.stage === key) || key === "publish" && run.status === "published");
        const current = run?.stage === key && !complete;
        return <li key={key} data-state={complete ? "complete" : current ? "current" : "pending"} aria-current={current ? "step" : undefined}><span className={styles.stepDot}>{complete ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><small>{complete ? "完成" : current ? states[run!.status] : run ? "未执行" : "等待开始"}</small></li>;
      })}</ol>
      {!run && <div className={styles.empty}><FlaskConical size={32} strokeWidth={1.25} /><h3>开始一次框架迭代</h3><p>选择项目并添加资料后，流程会在这里逐步展开。<br />每个阶段的结果与依据都可以回看。</p></div>}
      {run && <><div className={styles.runMeta}><span>当前阶段：{stages[run.stage]}</span><span>模型：{run.modelId}</span></div>
        {!!snapshot?.files?.length && <p className={styles.muted}>本轮资料：{snapshot.files.map((f) => f.originalFilename).join("、")}</p>}
        <dl className={styles.usage}><div><dt>模型调用</dt><dd>{run.usage.reduce((n, u) => n + u.requests, 0)}<small> 次</small></dd></div><div><dt>输入 / 缓存读取</dt><dd>{run.usage.reduce((n, u) => n + u.inputTokens, 0).toLocaleString()}<small> / {run.usage.reduce((n, u) => n + (u.cacheReadTokens || 0), 0).toLocaleString()}</small></dd></div><div><dt>输出 Token</dt><dd>{run.usage.reduce((n, u) => n + u.outputTokens, 0).toLocaleString()}</dd></div><div><dt>估算费用</dt><dd>¥{run.usage.reduce((n, u) => n + u.cost, 0).toFixed(4)}</dd></div></dl><p className={styles.caption}>输入为未缓存 Token；实际费用以平台结算为准。流程完成后仍需核查研究结论。</p>
        {run.error && <p role="alert">{run.error}</p>}
        {!!run.reviewReasons?.length && <div className={styles.review} role="status"><strong>需要人工核查</strong><ul>{run.reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
        <div className={styles.actions}>
        <details><summary>实际冻结资料范围与版本</summary><pre>{JSON.stringify(run.inputs, null, 2)}</pre><p>资料纳入时间：{run.createdAt}。纳入时间不等于资料披露日期，新增资料后的统一信息截止日待核实。</p></details>
        {["blocked", "failed", "queued"].includes(run.status) && <button disabled={busy} onClick={() => void action("resume")}>从有效检查点恢复</button>}
        {["running", "queued", "blocked", "failed", "review_required"].includes(run.status) && <button disabled={busy} onClick={() => void action("cancel")}>取消</button>}
        {run.status === "review_required" && <><button disabled={busy} onClick={() => void action("accept")}>接受并发布</button><button disabled={busy} onClick={() => void action("reject")}>拒绝草稿</button></>}
        <a href={`/api/pe/framework-iterations?${new URLSearchParams({ datasetId, runId: run.id, download: "report" })}`}>下载运行报告<ArrowUpRight size={14} /></a>
        </div>
        <details><summary>运行标识</summary><code>{run.id}</code></details>
        <details><summary>查看完整阶段产物与解析警告</summary><pre>{JSON.stringify({ validArtifacts: run.artifacts, invalidArtifacts: run.invalidArtifacts }, null, 2)}</pre></details>
      </>}
    </section>
    <section className={styles.panel}><div className={styles.sectionHeading}><span className={styles.sectionNumber}>03</span><h2>结果与依据</h2>{observations && <span className={styles.count}>{observations.observations.length} 条信息</span>}</div>
      {!observations && !impacts && !candidate && <div className={`${styles.empty} ${styles.resultEmpty}`}><FileText size={28} strokeWidth={1.25} /><h3>证据先行，变化可追溯</h3><p>提取的信息、判断影响和框架前后变化将在这里展示。</p></div>}
      {observations && <><h3>提取信息</h3><div className={styles.table}><table><thead><tr><th>主体 / 指标</th><th>值 / 期间 / 单位</th><th>角色 / 原文 / 缺口</th><th>来源</th></tr></thead><tbody>{observations.observations.map((o) => <tr key={o.id}><td>{o.subject}<br />{o.metric}</td><td>{o.value ?? "未披露"}<br />{o.period || "期间未知"} / {o.unit || "单位未知"}</td><td>{o.role}<br />{o.quote}<br />{o.gaps.join("；")}</td><td>{o.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>原文</PeSourceCitation>)}</td></tr>)}</tbody></table></div><details><summary>读取覆盖与未覆盖内容</summary><pre>{JSON.stringify(observations.coverage, null, 2)}</pre></details></>}
      {impacts && <><h3>判断影响</h3><p>{impacts.summary}</p>{impacts.impacts.map((i, index) => <article key={index}><strong>{i.judgmentIds.join("、") || "新增信息"} · {i.relation}</strong><p>{i.reason}</p><p>{i.proposedChange || "保留当前判断"}</p><small>{i.comparable ? "口径可比" : "不能直接比较"}</small></article>)}<p>{impacts.gaps.join("；")}</p></>}
      {project && basis && <details><summary>原框架 · v{basis.version}</summary><FrameworkText content={basis.content} cwd={project.root} /></details>}
      {candidate && "sections" in candidate && <><h3>前后变化与原因</h3>{candidate.sections.evidenceAndChanges.changes.map((c, index) => <article key={index}><strong>{c.judgmentIds.join("、")}</strong><p>原判断：{c.before}</p><p>新判断：{c.after}</p><p>原因：{c.reason}</p>{c.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>新证据</PeSourceCitation>)}</article>)}</>}
      {project && candidate && <details open><summary>{published ? `已发布 v${published.version}` : "候选框架"}</summary><FrameworkText content={candidate} cwd={project.root} /></details>}
      {run?.status === "no_change" && <p>本轮没有实质影响，当前有效框架保留。</p>}
    </section>
    </div></div>
    <footer className={styles.footer}>PE Workbench<span>投资框架迭代测试</span></footer>
    </div>
  </main>;
}
