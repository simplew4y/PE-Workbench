"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameworkState, IterationModelUpdateResult, getResearchMonitor } from "@earendil-works/pe-boot";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import styles from "./ResearchWorkflowControls.module.css";

type Monitor = ReturnType<typeof getResearchMonitor>;
interface Snapshot {
  monitor: Monitor;
  modelResult: IterationModelUpdateResult | null;
  latestRunId: string | null;
  serverRuntime: { available: boolean; reason: string | null };
  frameworkRuntime: { available: boolean; reason: string | null };
}

export function PeFrameworkUpdates({ project, monitor, framework, refresh }: {
  project: PeProjectSummary; monitor: Monitor; framework: FrameworkState; refresh: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    const response = await fetch(`/api/pe/research-workflow?${new URLSearchParams({ datasetId: project.datasetId, latest: "1" })}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "更新状态暂时无法读取。");
    if (mounted.current && !signal?.aborted && request === sequence.current) setSnapshot(data);
  }, [project.datasetId]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5000); }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [load]);

  const state = snapshot?.monitor ?? monitor;
  const plan = state.config;
  const latest = state.runs[0];
  const latestVersion = useRef(framework.currentVersionId);
  useEffect(() => {
    if (latest?.status === "published" && latest.versionId && latest.versionId !== latestVersion.current) {
      latestVersion.current = latest.versionId;
      refresh();
    }
  }, [latest?.status, latest?.versionId, refresh]);
  const running = latest?.status === "running" || state.manualRequested;
  const weekly = plan?.updatePolicy === "direct" && plan.enabled;
  const model = snapshot?.modelResult;
  async function post(action: string, extra: Record<string, unknown> = {}) {
    const response = await fetch("/api/pe/research-workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: project.datasetId, action, ...extra }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "未能完成更新。");
    return data as { monitor: Monitor; workerError?: string | null };
  }
  async function act(action: "run" | "weekly" | "pause") {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      let message = "设置已保存。";
      if (action === "pause") await post("monitor-pause", { revision: state.revision });
      else if (action === "run") { await post("updates-run"); message = "正在读取当前空间资料和 Wind 数据，生成新版投资框架。"; }
      else {
        const saved = await post("updates-save", { enabled: true, revision: state.revision, applyUpdates: true });
        if (saved.workerError) message = saved.workerError;
      }
      if (!mounted.current) return;
      setNotice(message);
      await load(); refresh();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "更新失败"); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className={styles.panel} aria-label="投资框架更新">
    <header><h2>更新研究</h2><span>{weekly ? "每周更新" : "手动更新"}</span></header>
    <p>读取当前空间资料和 Wind 数据，生成并显示新版投资框架，保留历史版本。</p>
    <div className={styles.actions}>
      <button type="button" disabled={busy || !snapshot || !framework.currentVersionId || !!running || !snapshot.frameworkRuntime.available} onClick={() => void act("run")}>{running ? "正在更新…" : "立即更新"}</button>
      <button type="button" disabled={busy || !snapshot || (!weekly && (!framework.currentVersionId || !!running || !snapshot.frameworkRuntime.available))} onClick={() => void act(weekly ? "pause" : "weekly")}>{weekly ? "关闭自动更新" : "开启自动更新"}</button>
    </div>
    {weekly && state.nextRunAt && <p>下次：{new Date(state.nextRunAt).toLocaleString()}。本机休眠或服务关闭期间暂停执行。</p>}
    {weekly && !state.workerOnline && <p>后台未在线，点击“立即更新”可重启。</p>}
    {!framework.currentVersionId && <p>先在对话中保存一份投资框架。</p>}
    {snapshot && !snapshot.frameworkRuntime.available && <p role="alert">{snapshot.frameworkRuntime.reason || "暂时无法连接分析服务，请稍后重试。"}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {latest && <div aria-live="polite">
      <h3>{latest.status === "running" ? "正在分析最新资料" : latest.status === "published" ? "投资框架已更新" : latest.status === "no_change" ? "本轮保留原框架" : ["cancelled", "rejected"].includes(latest.status) ? "本轮已结束" : "这轮更新需要处理"}</h3>
      {latest.events.filter((event) => ["prepare", "analysis", "model"].includes(event.stage)).map((event, index) => <p key={index}>{event.detail}</p>)}
      {latest.changes?.map((change) => <div key={change.id}><p>{change.reason}</p><p>之前：{change.before || "无"}<br />现在：{change.after || "无"}</p></div>)}
      {latest.error && <p role="alert">{latest.error}</p>}
      {model?.status === "running" && <p>模型正在重算，完成后会提供新版文件。</p>}
      {model?.status === "unavailable" && <p role="alert">模型更新未完成，继续使用原模型。{model.error}</p>}
      {model?.status === "candidate" && <p><a href={`/api/pe/research-workflow?${new URLSearchParams({ datasetId: project.datasetId, runId: snapshot!.latestRunId!, download: "model" })}`}>下载{model.promotionReceipt ? "当前" : "本轮"}模型文件</a>{!model.promotionReceipt && " · 尚未设为当前模型"}</p>}
      {model?.status === "candidate" && model.manifest?.validation.recalculated && Object.keys(model.manifest.outputs).length > 0 && <details><summary>模型重算结果</summary>{Object.entries(model.manifest.outputs).map(([name, value]) => <p key={name}>{name}：{value === null ? "未返回" : String(value)}</p>)}</details>}
    </div>}
    <details><summary>以前的更新记录</summary>{state.runs.map((run) => <div key={run.id}><p>{new Date(run.startedAt).toLocaleString()} · {run.status === "published" ? "框架已更新" : run.status === "no_change" ? "框架未调整" : run.status === "running" ? "更新中" : "本轮未完成更新"}</p>{run.events.filter((event) => ["analysis", "model"].includes(event.stage)).map((event, index) => <p key={index}>{event.detail}</p>)}</div>)}</details>
    {latest?.pipeline === "script" ? latest.versionId && <p><a href={`/api/pe/frameworks?${new URLSearchParams({ datasetId: project.datasetId, download: latest.versionId })}`}>下载本轮投资框架</a></p> : <p><a href={`/research-workbench?${new URLSearchParams({ datasetId: project.datasetId, ...(snapshot?.latestRunId ? { runId: snapshot.latestRunId } : {}) })}`}>查看完整记录</a></p>}
  </section>;
}
