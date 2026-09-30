"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
      await json(await fetch("/api/pe/framework-iterations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, runId, action: name, ...extra }) }));
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
  return <main className={styles.page}>
    <header><h1>投资框架迭代测试</h1><p>新增资料 → 提取信息 → 分析影响 → 修订框架 → 校验与提交</p><Link href="/">返回工作区</Link></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {platform?.source !== "platform" && <p>请登录并在工作区模型设置中选择平台模型，本页不会使用自定义 API。</p>}
    <section className={styles.panel}><h2>输入</h2>
      <label>项目<select value={datasetId} disabled={busy} onChange={(event) => { setDatasetId(event.target.value); setRunId(""); setSnapshot(null); setFiles([]); requestId.current = null; }}>{projects.map((p) => <option key={p.datasetId} value={p.datasetId}>{p.name}</option>)}</select></label>
      <p>平台模型：{snapshot?.modelId || platform?.platform.selected_model || "未连接"} · 基线：{basis ? `v${basis.version}` : "请先在聊天中确认七节框架"}</p>
      {snapshot && <label><input type="checkbox" checked={snapshot.settings.testProject} disabled={busy || snapshot.runs.some((r) => ["queued", "running", "review_required"].includes(r.status))} onChange={(event) => void action("test-project", { enabled: event.target.checked })} />明确登记此项目为测试项目，校验通过后自动发布</label>}
      <p>{snapshot?.settings.testProject ? "测试项目：新版本将自动成为有效框架。" : "普通项目：生成草稿后由你确认。"}</p>
      {snapshot?.files?.length ? <p>本轮资料：{snapshot.files.map((f) => f.originalFilename).join("、")}</p> : null}
      <label>新增资料（PDF / XLSX / XLSM）<input type="file" multiple accept=".pdf,.xlsx,.xlsm" disabled={busy} onChange={(event) => { setFiles(Array.from(event.target.files || [])); requestId.current = null; }} /></label>
      <button disabled={busy || !files.length || !snapshot?.framework.currentVersionId || platform?.source !== "platform" || snapshot.runs.some((r) => ["queued", "running"].includes(r.status))} onClick={() => void start()}>上传并运行完整流程</button>
    </section>
    <section className={styles.panel}><h2>运行过程</h2>
      <label>运行记录<select value={runId} onChange={(event) => setRunId(event.target.value)}><option value="">选择运行</option>{snapshot?.runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {states[r.status]}</option>)}</select></label>
      {run && <><p role="status">{states[run.status]} · {stages[run.stage]} · 模型 {run.modelId}</p><small>运行 {run.id}</small>
        <p>已记录调用 {run.usage.reduce((n, u) => n + u.requests, 0)} 次 · 未缓存输入 {run.usage.reduce((n, u) => n + u.inputTokens, 0)} Token · 缓存读取 {run.usage.reduce((n, u) => n + (u.cacheReadTokens || 0), 0)} Token · 输出 {run.usage.reduce((n, u) => n + u.outputTokens, 0)} Token · 平台目录估算 ¥{run.usage.reduce((n, u) => n + u.cost, 0).toFixed(4)}（实际结算以平台为准）</p>
        <ol className={styles.steps}>{Object.entries(stages).map(([key, label]) => <li key={key}>{label}：{run.artifacts.some((a) => a.stage === key) || key === "publish" && run.status === "published" ? "完成" : run.stage === key ? states[run.status] : "未执行"}</li>)}</ol>
        {run.error && <p role="alert">{run.error}</p>}
        {["blocked", "failed", "queued"].includes(run.status) && <button disabled={busy} onClick={() => void action("resume")}>从有效检查点恢复</button>}
        {["running", "queued", "blocked", "failed", "review_required"].includes(run.status) && <button disabled={busy} onClick={() => void action("cancel")}>取消</button>}
        {run.status === "review_required" && <><button disabled={busy} onClick={() => void action("accept")}>接受并发布</button><button disabled={busy} onClick={() => void action("reject")}>拒绝草稿</button></>}
        <a href={`/api/pe/framework-iterations?${new URLSearchParams({ datasetId, runId, download: "report" })}`}>下载运行报告</a>
        <details><summary>查看完整阶段产物与解析警告</summary><pre>{JSON.stringify({ validArtifacts: run.artifacts, invalidArtifacts: run.invalidArtifacts }, null, 2)}</pre></details>
      </>}
    </section>
    <section className={styles.panel}><h2>结果与依据</h2>
      {observations && <><h3>提取信息</h3><div className={styles.table}><table><thead><tr><th>主体 / 指标</th><th>值 / 期间 / 单位</th><th>角色 / 原文 / 缺口</th><th>来源</th></tr></thead><tbody>{observations.observations.map((o) => <tr key={o.id}><td>{o.subject}<br />{o.metric}</td><td>{o.value ?? "未披露"}<br />{o.period || "期间未知"} / {o.unit || "单位未知"}</td><td>{o.role}<br />{o.quote}<br />{o.gaps.join("；")}</td><td>{o.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>原文</PeSourceCitation>)}</td></tr>)}</tbody></table></div><details><summary>读取覆盖与未覆盖内容</summary><pre>{JSON.stringify(observations.coverage, null, 2)}</pre></details></>}
      {impacts && <><h3>判断影响</h3><p>{impacts.summary}</p>{impacts.impacts.map((i, index) => <article key={index}><strong>{i.judgmentIds.join("、") || "新增信息"} · {i.relation}</strong><p>{i.reason}</p><p>{i.proposedChange || "保留当前判断"}</p><small>{i.comparable ? "口径可比" : "不能直接比较"}</small></article>)}<p>{impacts.gaps.join("；")}</p></>}
      {project && basis && <details><summary>原框架 · v{basis.version}</summary><FrameworkText content={basis.content} cwd={project.root} /></details>}
      {candidate && "sections" in candidate && <><h3>前后变化与原因</h3>{candidate.sections.evidenceAndChanges.changes.map((c, index) => <article key={index}><strong>{c.judgmentIds.join("、")}</strong><p>原判断：{c.before}</p><p>新判断：{c.after}</p><p>原因：{c.reason}</p>{c.evidenceIds.map((id) => <PeSourceCitation key={id} cwd={project?.root || ""} evidenceId={id}>新证据</PeSourceCitation>)}</article>)}</>}
      {project && candidate && <details open><summary>{published ? `已发布 v${published.version}` : "候选框架"}</summary><FrameworkText content={candidate} cwd={project.root} /></details>}
      {run?.status === "no_change" && <p>本轮没有实质影响，当前有效框架保留。</p>}
    </section>
  </main>;
}
