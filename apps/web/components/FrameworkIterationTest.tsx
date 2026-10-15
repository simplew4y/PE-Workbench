"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Check, FileText, FlaskConical, Play, Upload, X } from "lucide-react";
import type { FrameworkContent, FrameworkIteration, FrameworkState, IterationChangeReview, IterationImpacts, IterationObservations, InformationCollection, InformationSourceQueryRecord, IterationSourceData as SourceData } from "@earendil-works/pe-boot";
import type { PeProjectCatalog, PeProjectSummary } from "@/lib/pe-project-types";
import { PeSourceCitation } from "./PeSourceCitation";
import { FrameworkText } from "./PeFrameworkPanel";
import { FrameworkChangeReview } from "./FrameworkChangeReview";
import { IterationSourceData } from "./IterationSourceData";
import { ResearchWorkflowControls } from "./ResearchWorkflowControls";
import { windReviewTasks } from "@/lib/iteration-source-data";
import { getPeModelServiceState, type PeModelServiceClientState } from "@/lib/pe-account-client";
import { createIterationLoader, createIterationSubmission, defaultIterationRun, iterationNextStep, mergeIterationHistory, type IterationHistory, type IterationHistoryPage } from "./framework-iteration-workspace";
import styles from "./FrameworkIterationTest.module.css";

type PublicRun = Omit<FrameworkIteration, "leaseToken" | "leaseUntil">;
interface Snapshot { run: PublicRun | null; runRuntime: "server" | "platform" | null; files: { originalFilename: string; status: string }[]; runs: PublicRun[]; nextCursor: string | null; settings: { testProject: boolean }; framework: FrameworkState; modelId: string; modelError: string | null; changeReview: IterationChangeReview | null; sourceQueries: InformationSourceQueryRecord[]; sourceData: SourceData[]; availableSources: {id: string;name: string;available: boolean;reason: string|null}[] }
type WorkspaceView = "overview" | "updates" | "evidence" | "model" | "history";
const views: [WorkspaceView, string][] = [["overview", "概览"], ["updates", "本轮更新"], ["evidence", "证据"], ["model", "模型与追踪"], ["history", "版本历史"]];
const states: Record<string, string> = { queued: "排队", running: "执行中", blocked: "待处理", review_required: "待确认", no_change: "无需调整", published: "已发布", failed: "失败", cancelled: "已取消", rejected: "未采用" };
const stages: Record<string, string> = { ingest: "解析入库", collect: "规划与采集", extract: "提取信息", impact: "分析判断影响", revise: "修订框架", validate: "程序校验", review: "人工审查", publish: "发布" };
const roles: Record<string, string> = { fact: "事实", guidance: "指引", forecast: "预测", opinion: "观点", unknown: "角色待核实" };
const relations: Record<string, string> = { supports: "支持", weakens: "削弱", overturns: "推翻", supplements: "补充", unresolved: "待核实", unrelated: "无关" };
async function json<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || value.message || "请求失败");
  return value;
}
export function FrameworkIterationTest({ workspace = false }: { workspace?: boolean }) {
  const [projects, setProjects] = useState<PeProjectSummary[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runId, setRunId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<IterationHistory<PublicRun> | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [platform, setPlatform] = useState<PeModelServiceClientState | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<WorkspaceView>("overview");
  const [versionId, setVersionId] = useState("");
  const [retrySubmission, setRetrySubmission] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [changeReviewMode, setChangeReviewMode] = useState(true);
  const [inputMode, setInputMode] = useState<"documents"|"sources">("documents");
  const [identityDraft, setIdentityDraft] = useState<{datasetId:string;companyName:string;companyTicker:string}|null>(null);
  const loadedRun = useRef("");
  const loader = useRef(createIterationLoader<Snapshot>());
  const historyRequest = useRef<AbortController | null>(null);
  const submission = useRef(createIterationSubmission<RequestInit>());
  const mutating = useRef(false);
  const mounted = useRef(false);
  const autoSelect = useRef(true);
  const scope = useRef("");
  const scopeKey = JSON.stringify([datasetId, runId]);
  const project = projects.find((p) => p.datasetId === datasetId);
  const loadedHistory = snapshot ? mergeIterationHistory(history, datasetId, {
    runs: [...snapshot.runs, ...(snapshot.run ? [snapshot.run] : [])],
    nextCursor: snapshot.nextCursor,
  }, "snapshot") : history?.datasetId === datasetId ? history : null;
  const allRuns = loadedHistory?.runs ?? [];
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; historyRequest.current?.abort(); historyRequest.current = null; };
  }, []);
  useEffect(() => {
    scope.current = scopeKey;
    return () => { scope.current = ""; };
  }, [scopeKey]);
  useEffect(() => {
    const controller = new AbortController();
    setInitializing(true);
    void fetch("/api/pe/projects", { signal: controller.signal }).then(json<PeProjectCatalog>).then((catalog) => {
      if (controller.signal.aborted) return;
      setProjects(catalog.projects); setLoadError("");
      const params = new URLSearchParams(window.location.search);
      setDatasetId(params.get("datasetId") || catalog.activeDatasetId || catalog.projects[0]?.datasetId || "");
      setRunId(params.get("runId") || "");
      setInputMode(params.get("input") === "sources" ? "sources" : "documents");
    }).catch((cause) => { if (!controller.signal.aborted) setLoadError(String(cause.message)); })
      .finally(() => { if (!controller.signal.aborted) setInitializing(false); });
    void getPeModelServiceState().then((model) => { if (!controller.signal.aborted) setPlatform(model); }).catch(() => {});
    return () => controller.abort();
  }, [catalogRevision]);
  const refresh = useCallback(async () => {
    if (!datasetId || !mounted.current || mutating.current || scope.current !== scopeKey) return;
    const params = new URLSearchParams({ datasetId, ...(runId ? { runId } : {}) });
    await loader.current.load(params.toString(), async (signal) => json<Snapshot>(await fetch(`/api/pe/framework-iterations?${params}`, { cache: "no-store", signal })), (result) => {
      setSnapshot(result);
      setHistory(current => mergeIterationHistory(current, datasetId, {
        runs: [...result.runs, ...(result.run ? [result.run] : [])],
        nextCursor: result.nextCursor,
      }, "snapshot"));
      setLoadError("");
      if (autoSelect.current && !runId) {
        autoSelect.current = false;
        const selected = defaultIterationRun(result.runs);
        if (selected) { scope.current = ""; setRunId(selected); return; }
      }
      if (result.run && loadedRun.current !== result.run.id) { loadedRun.current = result.run.id; setInputMode(result.run.sourceMode ?? "documents"); }
    }, (cause) => setLoadError(cause instanceof Error ? cause.message : "读取失败，请重试。"));
  }, [datasetId, runId, scopeKey]);
  useEffect(() => {
    if (!datasetId) return;
    let stopped = false;
    let timer: number | undefined;
    const activeLoader = loader.current;
    async function update() {
      await refresh();
      if (!stopped) timer = window.setTimeout(update, 2000);
    }
    void update();
    return () => { stopped = true; activeLoader.invalidate(); window.clearTimeout(timer); };
  }, [datasetId, runId, refresh]);
  useEffect(() => {
    if (!datasetId) return;
    const url = new URL(window.location.href); url.search = new URLSearchParams({ datasetId, input: inputMode, ...(runId ? { runId } : {}) }).toString(); window.history.replaceState(null, "", url);
  }, [datasetId, runId, inputMode]);
  const sourceIdentity = identityDraft?.datasetId === datasetId ? identityDraft : {datasetId,companyName:project?.companyName || "",companyTicker:project?.companyTicker || ""};
  async function loadMoreHistory() {
    if (!loadedHistory?.nextCursor || historyRequest.current || !mounted.current) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistory({ ...loadedHistory, paged: true }); setHistoryLoading(true); setHistoryError("");
    const params = new URLSearchParams({ datasetId, historyOnly: "1", historyBefore: loadedHistory.nextCursor });
    try {
      const page = await json<IterationHistoryPage<PublicRun>>(await fetch(`/api/pe/framework-iterations?${params}`, { cache: "no-store", signal: controller.signal }));
      if (historyRequest.current === controller && !controller.signal.aborted) {
        setHistory(current => mergeIterationHistory(current, datasetId, page, "older"));
      }
    } catch (cause) {
      if (historyRequest.current === controller && !controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "历史加载失败，请重试。");
    } finally {
      if (historyRequest.current === controller) { historyRequest.current = null; setHistoryLoading(false); }
    }
  }
  function selectRun(id: string) {
    if (mutating.current) return;
    const selected = allRuns.find(entry => entry.id === id);
    if (id !== runId) scope.current = "";
    loader.current.invalidate();
    autoSelect.current = false;
    setSnapshot(null); setLoadError(""); setError("");
    setRunId(id);
    if (selected) { loadedRun.current = selected.id; setInputMode(selected.sourceMode ?? "documents"); }
  }
  async function action(name: string, extra: Record<string, unknown> = {}) {
    if (mutating.current) return;
    mutating.current = true;
    loader.current.invalidate();
    setBusy(true); setError("");
    try {
      await json(await fetch("/api/pe/framework-iterations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, runId: runId || snapshot?.run?.id || "", action: name, ...extra }) }));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally {
      mutating.current = false;
      if (mounted.current) { await refresh(); setBusy(false); }
    }
  }
  async function start() {
    if (!snapshot?.framework.currentVersionId || mutating.current || !canStart) return;
    mutating.current = true;
    loader.current.invalidate();
    setBusy(true); setError("");
    try {
      const pending = submission.current.prepare((requestId) => {
        if (inputMode === "sources") return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create-sources", datasetId, basisVersionId: snapshot.framework.currentVersionId, requestId, sourceIds: ["wind-financials"], companyName: sourceIdentity.companyName, companyTicker: sourceIdentity.companyTicker }) };
        const form = new FormData(); form.set("datasetId", datasetId); form.set("basisVersionId", snapshot.framework.currentVersionId!); form.set("requestId", requestId); form.set("changeReview", String(workspace || changeReviewMode));
        for (const file of files) form.append("files", file);
        return { method: "POST", body: form };
      });
      const result = await json<{ run: PublicRun }>(await fetch("/api/pe/framework-iterations", pending.payload));
      submission.current.clear();
      if (mounted.current) {
        autoSelect.current = false;
        if (result.run.id !== runId) scope.current = "";
        setRunId(result.run.id); setSnapshot(null); setFiles([]); setRetrySubmission(false); setView("updates");
      }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "启动失败"); setRetrySubmission(true); }
    } finally { mutating.current = false; if (mounted.current) setBusy(false); }
  }
  const run = snapshot?.run;
  const serverRun = snapshot?.runRuntime === "server";
  const requestCount = run ? Math.max(run.usage.reduce((count, usage) => count + usage.requests, 0), run.diagnostics.filter((entry) => entry.tool === "pe_iteration_model").length) : 0;
  const basis = snapshot?.framework.versions.find((v) => v.id === (run?.basisVersionId || snapshot.framework.currentVersionId));
  const latest = snapshot?.framework.versions.find((v) => v.id === snapshot.framework.currentVersionId);
  const draft = snapshot?.framework.drafts.find((d) => d.id === run?.draftId);
  const published = snapshot?.framework.versions.find((v) => v.id === run?.versionId);
  const observations = run?.artifacts.find((a) => a.stage === "extract")?.value as IterationObservations | undefined;
  const impacts = run?.artifacts.find((a) => a.stage === "impact")?.value as IterationImpacts | undefined;
  const candidate = run?.artifacts.find((a) => a.stage === "revise")?.value as FrameworkContent | undefined || draft?.content;
  const activeRun = snapshot?.runs.some((r) => ["queued", "running"].includes(r.status));
  const windSource = snapshot?.availableSources?.find(source=>source.id === "wind-financials");
  const sourceReady = !!windSource?.available && !!sourceIdentity.companyName.trim() && /^[A-Z0-9.-]+\.[A-Z]{1,3}$/i.test(sourceIdentity.companyTicker.trim());
  const baselineReady = !!latest && "sections" in latest.content;
  const canStart = !busy && !loadError && !!snapshot?.modelId && baselineReady && (retrySubmission || (!activeRun && (inputMode === "sources" ? sourceReady : !!files.length)));
  const startHint = !datasetId ? "先选择一个研究项目" : !snapshot ? "正在读取项目框架…" : !baselineReady ? "请先在工作区确认七节研究框架" : !snapshot.modelId ? snapshot.modelError || "请先在工作区配置可用平台模型" : retrySubmission ? "重试将复用同一请求和冻结输入，不创建重复轮次。" : activeRun ? "当前项目已有运行中的任务" : inputMode === "sources" ? !windSource?.available ? windSource?.reason || "Wind 暂不可用" : !sourceReady ? "请补充公司名称和完整证券代码" : "按框架自动取数，结果留待逐项审查" : !files.length ? "添加资料后即可开始" : `已准备 ${files.length} 份资料`;
  const shownStages = Object.entries(stages).filter(([key])=>key !== ((run?.sourceMode ?? inputMode) === "sources" ? "ingest" : "collect"));
  const reviewTasks = windReviewTasks(run?.reviewReasons ?? []);
  const collection = run?.artifacts.find(artifact=>artifact.stage === "collect")?.value as InformationCollection|undefined;
  const nextStep = iterationNextStep(run?.status);
  const selectedVersion = snapshot?.framework.versions.find((version) => version.id === versionId) ?? latest;
  const pendingRuns = snapshot?.runs.filter((entry) => entry.status === "review_required") ?? [];
  const showUpdates = !workspace || view === "updates";
  const showEvidence = !workspace || view === "evidence";
  function resetSubmission() {
    submission.current.clear(); setRetrySubmission(false);
  }
  function selectProject(id: string) {
    if (mutating.current || id === datasetId) return;
    scope.current = ""; loader.current.invalidate(); autoSelect.current = true; loadedRun.current = "";
    historyRequest.current?.abort(); historyRequest.current = null;
    setHistory(null); setHistoryLoading(false); setHistoryError("");
    setDatasetId(id); setRunId(""); setSnapshot(null); setVersionId(""); setFiles([]); setError(""); setLoadError(""); resetSubmission();
  }
  function prepareNext() {
    selectRun(""); setFiles([]); resetSubmission(); setView("updates");
    document.getElementById("iteration-preparation")?.scrollIntoView({ block: "start" });
  }
  function addFiles(incoming: File[]) {
    if (mutating.current) return;
    const accepted = incoming.filter((file) => /\.(pdf|xlsx|xlsm)$/i.test(file.name));
    if (accepted.length !== incoming.length) setError("仅支持 PDF、XLSX 和 XLSM 文件。");
    const additions = accepted.filter((file) => !files.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified));
    if (!additions.length) return;
    setFiles((current) => [...current, ...additions]);
    resetSubmission();
  }
  const historyPagination = loadedHistory && <div className={styles.actions} aria-label="轮次历史分页">
    <p className={styles.caption}>已加载 {allRuns.length} 轮{loadedHistory?.nextCursor ? " · 每次最多加载 100 轮" : " · 已到历史末尾"}</p>
    {historyError && <p role="alert" className={styles.error}>{historyError}，已加载的历史仍保留。</p>}
    {loadedHistory?.nextCursor && <button disabled={historyLoading || busy} onClick={() => void loadMoreHistory()}>{historyLoading ? "正在加载历史…" : historyError ? "重试加载历史" : "加载更早轮次"}</button>}
  </div>;
  return <main className={styles.page}>
    <div className={styles.shell}>
    <nav className={styles.topbar} aria-label="页面导航"><span className={styles.brand}><FlaskConical size={19} /> PE Workbench {!workspace && <span className={styles.labTag}>测试</span>}</span><Link href="/"><ArrowLeft size={15} />返回研究对话</Link></nav>
    <header className={styles.heading}><div><span className={styles.eyebrow}>研究追踪 / 证据驱动迭代</span><h1>{workspace ? "研究追踪工作台" : "投资框架迭代测试"}</h1><p>{workspace ? "从新增证据到正式判断，每一轮变化都有依据。" : "用新增资料和外部信息检验判断，追溯每一次框架变化。"}</p></div><span className={styles.headerNote}>资料 · 判断 · 证据</span></header>
    {error && <div role="alert" className={styles.error}><p>{error}</p><p>未确认成功的操作不会被显示为完成。{retrySubmission ? "可在准备区重试原请求；修改输入则视为新的更新。" : "请先刷新状态，核查保存结果后再操作。"}</p><button disabled={busy} onClick={() => void refresh()}>核查最新状态</button></div>}
    {loadError && <div role="alert" className={styles.error}><p>{loadError}</p><p>{snapshot ? "展示上次成功读取的内容，恢复连接前不能发布。" : "暂时无法读取真实研究数据。"}</p><button disabled={busy || initializing} onClick={() => datasetId ? void refresh() : setCatalogRevision(value => value + 1)}>重新读取</button>{runId && <button disabled={busy} onClick={() => { selectRun(""); setView("history"); }}>返回项目历史</button>}</div>}
    {workspace && <nav className={styles.workspaceNav} aria-label="研究工作台视图">{views.map(([id, label]) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{label}{id === "updates" && pendingRuns.length > 0 && <span>{pendingRuns.length} 待审</span>}</button>)}</nav>}
    <div className={styles.workspace} data-wide={workspace && view === "model"}>
    <aside className={styles.sidebar} hidden={workspace && view === "model"}>
    <section className={styles.panel} id="iteration-preparation"><div className={styles.sectionHeading}><span className={styles.sectionNumber}>01</span><h2>{workspace ? "准备更新" : "准备测试"}</h2></div>
      <label className={styles.field}>研究项目<select value={datasetId} disabled={busy || initializing} onChange={(event) => selectProject(event.target.value)}>{!projects.length && <option value="">{initializing ? "正在读取项目…" : "暂无可用项目"}</option>}{projects.map((p) => <option key={p.datasetId} value={p.datasetId}>{p.name}</option>)}</select></label>
      <dl className={styles.context}><div><dt>下一轮基线</dt><dd>{latest ? `v${latest.version}` : "尚未确认"}</dd></div><div><dt>平台模型</dt><dd>{snapshot ? snapshot.modelId || "不可用" : platform?.platform.selected_model || "未连接"}</dd></div></dl>
      {snapshot && (snapshot.modelError || !snapshot.modelId) && <p className={styles.notice} role="status">{snapshot.modelError || "暂未连接可用模型。"} 历史与已生成结果仍可查阅。在<Link href="/">工作区模型设置</Link>中处理后，<button disabled={busy} onClick={() => void refresh()}>重新检查</button>。</p>}
      <div className={styles.inputTabs} role="tablist" aria-label="迭代信息入口">{([['documents','上传文档'],['sources','其他信息源']] as const).map(([mode,label])=><button key={mode} id={`input-tab-${mode}`} role="tab" aria-selected={inputMode===mode} aria-controls={`input-panel-${mode}`} disabled={busy} onClick={()=>{if (mode !== inputMode) { setInputMode(mode);resetSubmission(); }}}>{label}</button>)}</div>
      {inputMode === "documents" ? <div role="tabpanel" id="input-panel-documents" aria-labelledby="input-tab-documents">
      <label className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
        <Upload size={25} strokeWidth={1.5} /><strong>添加新增资料</strong><span>点击选择，或拖入文件</span><small>PDF / XLSX / XLSM · 支持多份资料</small>
        <input aria-label="新增资料（PDF / XLSX / XLSM）" type="file" multiple accept=".pdf,.xlsx,.xlsm" disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      </label>
      {!!files.length && <ul className={styles.fileList}>{files.map((file, index) => <li key={`${file.name}-${index}`}><FileText size={16} /><span>{file.name}<small>{file.size < 1048576 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / 1048576).toFixed(1)} MB`}</small></span><button className={styles.iconButton} aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => { setFiles((current) => current.filter((_, i) => i !== index)); resetSubmission(); }}><X size={15} /></button></li>)}</ul>}
      </div> : <div role="tabpanel" id="input-panel-sources" aria-labelledby="input-tab-sources" className={styles.sourceInput}>
        <strong>Wind 财务数据</strong><p className={styles.caption}>{windSource?.available ? "已连接服务端配置" : windSource?.reason || "正在检查来源可用性…"}</p>
        <label className={styles.field}>公司名称<input value={sourceIdentity.companyName} readOnly={!!project?.companyName} disabled={busy} onChange={event=>{setIdentityDraft({...sourceIdentity,companyName:event.target.value});resetSubmission();}} /></label>
        <label className={styles.field}>Wind 证券代码<input value={sourceIdentity.companyTicker} placeholder="例如 9660.HK" disabled={busy} onChange={event=>{setIdentityDraft({...sourceIdentity,companyTicker:event.target.value});resetSubmission();}} /></label>
        <p>根据当前判断和证据缺口自动查询，覆盖最近三个已披露年度及最新中报或季报。最多四个查询，含必要补查。</p><small>使用 Wind 调用额度；没有数据会保留缺口，不推算数值。</small>
      </div>}
      <div className={styles.publishMode}><label><input type="checkbox" checked={workspace || inputMode === "sources" || changeReviewMode} disabled={workspace || busy || inputMode === "sources"} onChange={(event) => { setChangeReviewMode(event.target.checked); resetSubmission(); }} /><span>逐项审查后发布<small>选择采用内容，保存理由与来源</small></span></label><p>{inputMode === "sources" ? "其他信息源始终留待逐项审查，不自动发布。" : workspace || changeReviewMode ? "本轮停在草稿，审查决定保存后可撤回。" : "使用原测试流程的整份草稿确认方式。"}</p></div>
      <details><summary>测试与调试设置</summary>
      {snapshot && inputMode === "documents" && <details><summary>测试项目发布设置</summary><div className={styles.publishMode}><label><input type="checkbox" checked={snapshot.settings.testProject} disabled={busy || snapshot.runs.some((r) => ["queued", "running", "review_required"].includes(r.status))} onChange={(event) => void action("test-project", { enabled: event.target.checked })} /><span>登记为测试项目<small>关闭逐项审查时，校验通过且无疑点可自动发布</small></span></label><p>{changeReviewMode ? "逐项审查模式始终等待你的发布决定。" : snapshot.settings.testProject ? "有待核实问题时，仍需人工确认。" : "当前为普通项目，发布前需人工确认。"}</p></div></details>}
      <p className={styles.caption}>生产工作台始终逐项审查。原测试入口保留整份确认与测试项目设置。</p><Link href={`/framework-iteration-test?${new URLSearchParams({ datasetId, ...(runId ? { runId } : {}) })}`}>打开迭代测试页</Link>{workspace && <p><Link href="/research-workbench/demo">打开独立界面演示（非真实数据）</Link></p>}
      </details>
      <button className={styles.primary} disabled={!canStart || !!loadError} onClick={() => void start()}><Play size={15} />{busy ? "正在处理…" : retrySubmission ? "重试原启动请求" : inputMode === "sources" ? "采集并开始更新" : "上传并开始更新"}</button><p className={styles.startHint}>{startHint}</p>
    </section>
    {!workspace && !!allRuns.length && <details className={styles.panel}><summary>全部迭代轮次 · 已加载 {allRuns.length}</summary><div className={styles.runHistory} aria-label="迭代轮次历史">{allRuns.map((entry) => {
      const base = snapshot?.framework.versions.find((version) => version.id === entry.basisVersionId);
      const result = snapshot?.framework.versions.find((version) => version.id === entry.versionId);
      return <button key={entry.id} disabled={busy} aria-current={entry.id === runId ? "page" : undefined} onClick={() => selectRun(entry.id)}><strong>{base ? `v${base.version}` : "基线"} → {result ? `v${result.version}` : states[entry.status]}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.modelId}</small></button>;
    })}</div>{historyPagination}</details>}
    <div className={styles.help}><strong>原框架不会被草稿替代</strong><p>上传资料或采集信息后，在本轮更新中审查差异；发布后才形成新的有效框架。</p><Link href="/">前往研究对话<ArrowUpRight size={14} /></Link></div>
    </aside>
    <div className={styles.content}>
    {workspace && view === "model" && <>
      <section className={styles.panel}><div className={styles.modelContext}><label className={styles.field}>研究项目<select value={datasetId} disabled={busy || initializing} onChange={event => selectProject(event.target.value)}>{!projects.length && <option value="">{initializing ? "正在读取项目…" : "暂无可用项目"}</option>}{projects.map(entry => <option key={entry.datasetId} value={entry.datasetId}>{entry.name}</option>)}</select></label><label className={styles.field}>查看模型交付轮次<select value={runId} disabled={busy || !snapshot} onChange={event => selectRun(event.target.value)}><option value="">准备下一轮模型</option>{allRuns.map(entry => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {states[entry.status]}</option>)}</select></label></div>{historyPagination}<p>框架发布、Excel 交付与下一轮基线分别确认。映射设置不追溯更改历史轮次。</p>{snapshot?.modelError && <p className={styles.notice} role="status">手动启动模型：{snapshot.modelError}。后台追踪使用独立服务端配置，状态见下方。</p>}</section>
      {datasetId && <ResearchWorkflowControls datasetId={datasetId} runId={runId} onRefresh={refresh} />}
    </>}
    {initializing && <section className={styles.panel} role="status">正在读取研究项目…</section>}
    {!initializing && !projects.length && !loadError && <section className={styles.panel}><h2>先创建一个研究项目</h2><p>在研究对话中建立项目、加入公司资料并确认投资框架，再回到这里持续追踪。</p><Link href="/">前往创建研究项目<ArrowUpRight size={14} /></Link></section>}
    {datasetId && !snapshot && !loadError && <section className={styles.panel} role="status">正在读取{runId ? "所选轮次" : "项目框架"}…</section>}
    {snapshot && !baselineReady && <section className={`${styles.panel} ${styles.nextStep}`}><span className={styles.eyebrow}>开始之前</span><h2>先确认一份完整研究基线</h2><p>{latest ? "当前是旧版条目框架，仍可查阅。请先补齐完整框架。" : ""}在研究对话中生成完整的七节投资框架，点击「确定投资框架」。确认后，新增证据才有可比较的原判断。</p><div className={styles.actions}><Link href="/">前往研究对话</Link><button disabled={busy} onClick={() => void refresh()}>已确认，重新读取</button></div></section>}
    {workspace && view === "overview" && snapshot && <>
      <section className={`${styles.panel} ${styles.nextStep}`}>
        <span className={styles.eyebrow}>{project?.name || "当前项目"} · 下一步</span><h2>{latest ? nextStep.title : "建立可追溯的研究起点"}</h2><p>{latest ? nextStep.detail : "确认基线后，系统才能区分新增事实、预期差异和需要调整的判断。"}</p>
        <div className={styles.overviewStats}><div><span>当前有效框架</span><strong>{latest ? `v${latest.version}` : "待确认"}</strong></div><div><span>待审轮次</span><strong>{pendingRuns.length}</strong></div><div><span>当前轮次</span><strong>{run ? states[run.status] : "尚未开始"}</strong></div></div>
        {latest && <div className={styles.actions}><button disabled={busy} onClick={() => { setView("updates"); if (!run) document.getElementById("iteration-preparation")?.scrollIntoView({ block: "start" }); }}>{nextStep.title}<ArrowUpRight size={14} /></button>{run && <button disabled={busy} onClick={prepareNext}>准备下一轮</button>}</div>}
        {!!pendingRuns.length && <p className={styles.caption}>有 {pendingRuns.length} 轮修改待审，未发布前不改变当前有效判断。</p>}
      </section>
      {run && <section className={styles.panel}><h2>本轮发现</h2><p>{impacts?.summary || collection?.summary || "尚未形成影响结论，请查看本轮进度。"}</p><p>{observations?.observations.length ?? 0} 条提取信息 · {snapshot.changeReview?.plan.changes.length ?? 0} 处候选修改 · {run.reviewReasons.length} 条待核查记录</p>{run.error && <p role="alert" className={styles.error}>{run.error}</p>}<div className={styles.actions}><button onClick={() => setView("updates")}>查看变化与原因</button><button onClick={() => setView("evidence")}>核查原文来源</button></div></section>}
      {latest && project && <section className={styles.panel}><h2>当前研究结果 · v{latest.version}</h2><p>这是正式发布的框架，不包含尚未接受的候选修改。</p><FrameworkText key={latest.id} content={latest.content} cwd={project.root} downloadUrl={`/api/pe/frameworks?${new URLSearchParams({ datasetId, download: latest.id })}`} /></section>}
    </>}
    {workspace && view === "history" && snapshot && <>
      <section className={styles.panel}><h2>更新轮次 · 已加载 {allRuns.length}</h2><p>成功发布、无需调整、未采用和异常运行均保留。选择一轮查看证据、审查与执行记录；更早记录按需加载。</p><div className={styles.runHistory}>{allRuns.map((entry) => {
        const base = snapshot.framework.versions.find(version => version.id === entry.basisVersionId);
        const result = snapshot.framework.versions.find(version => version.id === entry.versionId);
        return <button key={entry.id} disabled={busy} aria-current={entry.id === runId ? "page" : undefined} onClick={() => { selectRun(entry.id); setView("updates"); }}><strong>{base ? `v${base.version}` : "基线"} → {result ? `v${result.version}` : states[entry.status]}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.sourceMode === "sources" ? "信息源采集" : "新增文档"} · {entry.modelId}</small></button>;
      })}</div>{historyPagination}{!allRuns.length && <p>尚无更新轮次。已发布的基线仍可在下方查阅。</p>}</section>
      <section className={styles.panel}><h2>正式框架版本 · {snapshot.framework.versions.length}</h2><label className={styles.field}>查看已发布版本<select value={selectedVersion?.id ?? ""} onChange={event => setVersionId(event.target.value)}>{!snapshot.framework.versions.length && <option value="">尚无正式版本</option>}{snapshot.framework.versions.map(version => <option key={version.id} value={version.id}>v{version.version}{version.id === latest?.id ? " · 当前有效" : " · 历史版本"}</option>)}</select></label>{selectedVersion && project && <FrameworkText key={selectedVersion.id} content={selectedVersion.content} cwd={project.root} downloadUrl={`/api/pe/frameworks?${new URLSearchParams({ datasetId, download: selectedVersion.id })}`} />}</section>
    </>}
    {workspace && (view === "updates" || view === "evidence") && snapshot && <section className={styles.panel}><label className={styles.field}>当前查看轮次<select value={runId} disabled={busy} onChange={event => selectRun(event.target.value)}><option value="">准备新一轮</option>{allRuns.map(entry => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {states[entry.status]}</option>)}</select></label>{historyPagination}{run && <p className={styles.caption}>以下内容仅属于所选轮次。{run.id === snapshot.runs[0]?.id ? "" : "你正在回看历史轮次。"}</p>}</section>}
    {(showUpdates || showEvidence) && <section className={styles.panel}><div className={styles.sectionHeading}><span className={styles.sectionNumber}>02</span><h2>{workspace && view === "evidence" ? "原文与采集记录" : "运行过程"}</h2>{run && <span className={styles.statusBadge} data-status={run.status} role="status">{states[run.status]}</span>}</div>
      {!workspace && <>
      <label className={styles.field}>运行记录<select value={runId} disabled={busy} onChange={(event) => selectRun(event.target.value)}><option value="">准备新一轮</option>{allRuns.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {states[r.status]}</option>)}</select></label>
      </>}
      {showUpdates && <>
      <ol className={styles.steps}>{shownStages.map(([key, label], index) => {
        const complete = !!run && (run.artifacts.some((a) => a.stage === key) || key === "publish" && run.status === "published" || key === "review" && !!snapshot?.changeReview?.publication);
        const current = key === "review" ? run?.status === "review_required" : !!run && ["queued", "running", "blocked", "failed"].includes(run.status) && run.stage === key && !complete;
        const skipped = key === "review" && run && !run.changeReview && run.status === "published";
        return <li key={key} data-state={complete ? "complete" : current ? "current" : "pending"} aria-current={current ? "step" : undefined}><span className={styles.stepDot}>{complete ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><small>{complete ? "完成" : current ? states[run!.status] : skipped ? "原流程" : run ? "未执行" : "等待开始"}</small></li>;
      })}</ol></>}
      {!run && <div className={styles.empty}><FlaskConical size={32} strokeWidth={1.25} /><h3>开始一次框架迭代</h3><p>选择项目并添加资料后，流程会在这里逐步展开。<br />每个阶段的结果与依据都可以回看。</p></div>}
      {run && <><div className={styles.runMeta}><span>当前阶段：{run.status === "review_required" ? "人工审查" : stages[run.stage] || run.stage}</span><span>本轮基线：{basis ? `v${basis.version}` : "版本待读取"}</span><span>模型：{run.modelId}</span>{published && <span>发布结果：v{published.version}</span>}</div>
        {!!snapshot?.files?.length && <p className={styles.muted}>本轮资料：{snapshot.files.map((f) => f.originalFilename).join("、")}</p>}
        {showEvidence && run.sourceMode === "sources" && <div className={styles.sourceResults}>
          <strong>Wind 财务采集 · {run.sourceConfig?.companyName} · {run.sourceConfig?.companyTicker}</strong>
          <p>业务查询 {snapshot?.sourceQueries.length || 0} / 4 · 调用尝试 {snapshot?.sourceQueries.reduce((count,query)=>count+query.attempts.length,0) || 0} 次 · Wind 费用不可获取</p>
          {collection && <p role="status">{collection.coverage === "complete" ? "计划查询完成；结果不代表全面覆盖" : collection.coverage === "partial" ? "部分成功：研究结论仅针对已取得的数据" : "未获得有效数据"}。{collection.summary}</p>}
          {snapshot?.sourceQueries.map(query=>{
            const last=query.attempts.at(-1);
            const state=last ? ({running:"采集中",saved:"已保存",empty:"无有效数据",failed:"失败",interrupted:"中断"} as const)[last.status] : "排队";
            const rawUrl=`/api/pe/framework-iterations?${new URLSearchParams({datasetId,runId:run.id,sourceQueryId:query.id,download:"source-raw"})}`;
            return <details key={query.id}><summary>{query.query.definitionChecks?.length ? "口径补查 · " : "指标采集 · "}{query.query.purpose} · {state}</summary><p>关联判断：{query.query.judgmentIds.join("、") || "新增核查"}</p><p>{query.actualQuery}</p>{!!query.query.definitionChecks?.length && <p>系统已请求补查：{query.query.definitionChecks.map(check => ({period:"期间类型",currency:"币种",scope:"报表口径",role:"实际或预测",definition:"指标定义"})[check]).join("、")}。已请求不代表供应商已返回；确认结果以采集字段为准。</p>}<p>返回指标：{last?.metrics?.join("、") || "暂无"}</p>{last?.error && <p role="alert">{last.error}</p>}<ul>{last?.gaps?.map(gap=><li key={gap}>{gap}</li>)}</ul><div className={styles.sourceLinks}>{last?.evidenceId && <PeSourceCitation cwd={project?.root || ""} evidenceId={last.evidenceId}>证据文本与字段出处</PeSourceCitation>}{last?.rawPath && <a href={rawUrl}>下载原始响应</a>}{last?.viewDocId && <a href={rawUrl.replace("source-raw","source-text")}>下载可读文本</a>}</div><small>{last?.startedAt && new Date(last.startedAt).toLocaleString()} · {last?.elapsedMs === undefined ? "请求尚未结束" : `${(last.elapsedMs/1000).toFixed(1)} 秒`}</small></details>;
          })}
        </div>}
        <details><summary>调用用量与费用 · {requestCount} 次模型调用</summary><dl className={styles.usage}><div><dt>模型调用</dt><dd>{requestCount}<small> 次</small></dd></div><div><dt>输入 / 缓存读取</dt><dd>{run.usage.reduce((n, u) => n + u.inputTokens, 0).toLocaleString()}<small> / {run.usage.reduce((n, u) => n + (u.cacheReadTokens || 0), 0).toLocaleString()}</small></dd></div><div><dt>输出 Token</dt><dd>{run.usage.reduce((n, u) => n + u.outputTokens, 0).toLocaleString()}</dd></div><div><dt>{serverRun ? "后台模型费用" : "估算费用"}</dt><dd>{serverRun ? <small>供应商计费，未估算</small> : `¥${run.usage.reduce((n, u) => n + u.cost, 0).toFixed(4)}`}</dd></div></dl><p className={styles.caption}>{serverRun ? "后台使用独立服务端凭据；未取得定价，费用以供应商账单为准，不计作平台免费调用。" : run.status === "running" ? "当前模型阶段的 Token 与费用将在阶段结束后汇总。" : "输入为未缓存 Token；实际费用以平台结算为准。"}流程完成后仍需核查研究结论。</p></details>
        {run.error && <p role="alert">{run.error}</p>}
        {!!run.reviewReasons?.length && <div className={styles.review} role="status"><strong>{run.sourceMode === "sources" ? "未解决的核查问题" : "需要人工核查"}</strong>{run.sourceMode === "sources" ? <><p>按问题合并展示；合并只减少重复提示，不表示缺口已解决。你可以采用有价值的取证动作，暂不采用缺乏依据的改判。</p>{reviewTasks.map(task => <details key={task.title}><summary>{task.title} · {task.reasons.length} 条相关记录</summary><p>{task.action}</p><ul>{task.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>)}</> : <ul>{run.reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>}
        {showUpdates && <div className={styles.actions}>
        {["blocked", "failed", "queued"].includes(run.status) && <button disabled={busy || (!serverRun && !snapshot?.modelId) || !!loadError} onClick={() => void action("resume")}>从有效检查点恢复</button>}
        {["running", "queued", "blocked", "failed", "review_required"].includes(run.status) && <button disabled={busy} onClick={() => void action("cancel")}>取消</button>}
        {run.status === "review_required" && !run.changeReview && !snapshot?.changeReview?.events.length && <><button disabled={busy || !!loadError} onClick={() => void action("accept")}>整份接受并发布</button><button disabled={busy || !!loadError} onClick={() => void action("reject")}>拒绝整份草稿</button></>}
        {["published", "no_change", "rejected", "cancelled"].includes(run.status) && <button disabled={busy} onClick={prepareNext}>基于当前版本准备下一轮</button>}
        {workspace && <button onClick={() => setView("evidence")}>核查原文与来源</button>}
        <a href={`/api/pe/framework-iterations?${new URLSearchParams({ datasetId, runId: run.id, download: "report" })}`}>下载运行报告<ArrowUpRight size={14} /></a>
        </div>}
        <details><summary>调试与执行记录</summary>
        <details><summary>实际冻结资料范围与版本</summary><pre>{JSON.stringify(run.inputs, null, 2)}</pre><p>资料纳入时间：{run.createdAt}。纳入时间不等于资料披露日期，新增资料后的统一信息截止日待核实。</p></details>
        <details><summary>运行标识</summary><code>{run.id}</code></details>
        <details><summary>执行与异常记录 · {run.executionAttempts?.length || 1} 次执行</summary><ol className={styles.reviewHistory}>{run.stageAttempts?.map((attempt, index) => <li key={index}><strong>{stages[attempt.stage]} · {attempt.status === "completed" ? "完成" : attempt.status === "failed" ? "失败" : attempt.status === "running" ? "执行中" : attempt.status}</strong><span>{new Date(attempt.startedAt).toLocaleString()}{attempt.finishedAt ? ` → ${new Date(attempt.finishedAt).toLocaleString()}` : ""}</span></li>)}</ol>{run.diagnostics.filter((entry) => entry.tool === "pe_iteration_execution_error").map((entry, index) => <p key={index}>{new Date(entry.at).toLocaleString()} · {entry.error}</p>)}</details>
        <details><summary>查看完整阶段产物与解析警告</summary><pre>{JSON.stringify({ validArtifacts: run.artifacts, invalidArtifacts: run.invalidArtifacts }, null, 2)}</pre></details>
        </details>
      </>}
    </section>}
    {showEvidence && project && run?.sourceMode === "sources" && <IterationSourceData key={run.id} rows={snapshot?.sourceData ?? []} observations={observations} cwd={project.root} />}
    {showUpdates && project && snapshot?.changeReview && <FrameworkChangeReview key={snapshot.changeReview.plan.id} review={snapshot.changeReview} observations={observations} cwd={project.root} editable={run?.status === "review_required"} busy={busy || !!loadError}
      onDecide={async (changeIds, decision, note) => { await action("review-decide", { planId: snapshot.changeReview!.plan.id, revision: snapshot.changeReview!.revision, changeIds, decision, note }); }}
      onPublish={async (acknowledgeWarnings) => { await action("review-publish", { planId: snapshot.changeReview!.plan.id, revision: snapshot.changeReview!.revision, acknowledgeWarnings }); }}
      onReject={async () => { await action("reject"); }} />}
    {(showUpdates || showEvidence) && <section className={styles.panel}><div className={styles.sectionHeading}><span className={styles.sectionNumber}>03</span><h2>{workspace ? showEvidence ? "提取信息与原文" : "判断影响与交付结果" : "结果与依据"}</h2>{observations && <span className={styles.count}>{observations.observations.length} 条信息</span>}</div>
      {!observations && !impacts && !candidate && <div className={`${styles.empty} ${styles.resultEmpty}`}><FileText size={28} strokeWidth={1.25} /><h3>证据先行，变化可追溯</h3><p>提取的信息、判断影响和框架前后变化将在这里展示。</p></div>}
      {showEvidence && observations && <><h3>提取信息</h3><p className={styles.caption}>分析说明使用简体中文；原文引用及期间、单位、口径字段保留资料原始写法，可能包含繁体字。历史运行内容保留原样。</p><div className={styles.table}><table><thead><tr><th>主体 / 指标</th><th>值 / 期间 / 单位</th><th>角色 / 原文 / 缺口</th><th>来源</th></tr></thead><tbody>{observations.observations.map((o) => <tr key={o.id}><td>{o.subject}<br />{o.metric}</td><td>{o.value ?? "未披露"}<br />{o.period || "期间未知"} / {o.unit || "单位未知"}</td><td>{roles[o.role] || o.role}<br />{o.quote}<br />{o.gaps.join("；")}</td><td>{o.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>原文</PeSourceCitation>)}</td></tr>)}</tbody></table></div><details><summary>读取覆盖与未覆盖内容</summary><pre>{JSON.stringify(observations.coverage, null, 2)}</pre></details></>}
      {showEvidence && !observations && <p>本轮尚无提取结果。原文来源会在解析或采集完成后出现。</p>}
      {showUpdates && <>
      {impacts && <><h3>判断影响</h3><p>{impacts.summary}</p>{impacts.impacts.map((i, index) => <article key={index}><strong>{i.judgmentIds.join("、") || "新增信息"} · {relations[i.relation] || i.relation}</strong><p>{i.reason}</p><p>{i.proposedChange || "保留当前判断"}</p><small>{i.comparable ? "口径可比" : "不能直接比较"}</small></article>)}<p>{impacts.gaps.join("；")}</p></>}
      {project && basis && <details><summary>原框架 · v{basis.version}</summary><FrameworkText content={basis.content} cwd={project.root} /></details>}
      {candidate && "sections" in candidate && <><h3>前后变化与原因</h3>{candidate.sections.evidenceAndChanges.changes.map((c, index) => <article key={index}><strong>{c.judgmentIds.join("、")}</strong><p>原判断：{c.before}</p><p>新判断：{c.after}</p><p>原因：{c.reason}</p>{c.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>新证据</PeSourceCitation>)}</article>)}</>}
      {project && candidate && <details><summary>完整模型候选（保留所有建议）</summary><FrameworkText content={candidate} cwd={project.root} /></details>}
      {project && published && <details open><summary>已发布 v{published.version} · 实际采用内容</summary><FrameworkText content={published.content} cwd={project.root} /></details>}
      {run?.status === "no_change" && <p>{collection?.coverage === "partial" ? "在已取得的数据范围内没有需要发布的实质变化；仍有采集或口径缺口。" : "本轮没有实质影响，当前有效框架保留。"}</p>}
      </>}
    </section>}
    </div></div>
    <footer className={styles.footer}>PE Workbench<span>{workspace ? "研究追踪工作台 · 真实项目数据" : "投资框架迭代测试"}</span></footer>
    </div>
  </main>;
}
