"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IterationModelConfig, IterationModelMapping, IterationModelUpdateResult, IterationObservations, MonitorConfig, MonitorRun } from "@earendil-works/pe-boot";
import type { PeProjectDocumentSummary } from "@/lib/pe-project-types";
import { mappingFromObservation, modelDeliveryLabels, modelSkipLabels, parseModelLiteral } from "@/lib/research-workflow-form";
import styles from "./ResearchWorkflowControls.module.css";

interface Snapshot {
  modelConfig: IterationModelConfig | null;
  modelResult: IterationModelUpdateResult | null;
  modelVersions: { doc_id: string; current_version_id: string | null; versions: { version_id: string; promoted: boolean }[] } | null;
  modelError: string | null;
  observations: IterationObservations | null;
  documents: PeProjectDocumentSummary[];
  monitor: { config: MonitorConfig | null; revision: number; nextRunAt: number | null; workerOnline: boolean; runs: MonitorRun[] };
  serverRuntime: { available: boolean; modelId: string | null; reason: string | null };
}
type MappingDraft = IterationModelMapping & { literal: string };
interface Editor { docId: string; revision: number; mappings: MappingDraft[] }

async function json<ResponseBody>(response: Response): Promise<ResponseBody> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || "请求失败");
  return body;
}

export function ResearchWorkflowControls(props: { datasetId: string; runId: string; modelOnly?: boolean; onRefresh?: () => Promise<void> | void }) {
  return <WorkflowControls key={`${props.datasetId}:${props.runId}`} {...props} />;
}

function WorkflowControls({ datasetId, runId, modelOnly = false, onRefresh }: { datasetId: string; runId: string; modelOnly?: boolean; onRefresh?: () => Promise<void> | void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [schedule, setSchedule] = useState<{ enabled: boolean; intervalHours: number; collectSources: boolean } | null>(null);
  const [acknowledgeCosts, setAcknowledgeCosts] = useState(false);
  const [acknowledgeModel, setAcknowledgeModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [observationId, setObservationId] = useState("");
  const requestNumber = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!datasetId) return;
    const number = ++requestNumber.current;
    const params = new URLSearchParams({ datasetId, ...(runId ? { runId } : {}), ...(editor?.docId ? { docId: editor.docId } : {}) });
    const result = await json<Snapshot>(await fetch(`/api/pe/research-workflow?${params}`, { cache: "no-store", signal }));
    if (mounted.current && !signal?.aborted && number === requestNumber.current) setSnapshot(result);
  }, [datasetId, runId, editor?.docId]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取追踪设置"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 4000); }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  async function mutate(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await json<{ workerError?: string | null }>(await fetch("/api/pe/research-workflow", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, datasetId, runId, ...extra }),
      }));
      if (!mounted.current) return;
      if (action === "model-save") setEditor(null);
      if (action === "model-promote") setAcknowledgeModel(false);
      if (action === "monitor-save" || action === "monitor-pause") { setSchedule(null); setAcknowledgeCosts(false); }
      setNotice(result.workerError || (action === "model-run" ? "模型任务已提交，当前页面会自动刷新。" : "已保存。"));
      await refresh();
      await onRefresh?.();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { if (mounted.current) setBusy(false); }
  }
  const model = snapshot?.modelResult;
  const config = snapshot?.modelConfig;
  const plan = snapshot?.monitor.config;
  const currentSchedule = schedule ?? { enabled: plan?.enabled ?? false, intervalHours: plan?.intervalHours ?? 24, collectSources: !!plan?.sourceConfig };
  const latestMonitor = snapshot?.monitor.runs[0];
  const promoted = !!model?.modelVersionId && snapshot?.modelVersions?.current_version_id === model.modelVersionId;
  function editModel() {
    setEditor({ docId: config?.docId ?? snapshot?.documents[0]?.docId ?? "", revision: config?.revision ?? 0,
      mappings: config?.mappings.map((mapping) => ({ ...mapping, literal: JSON.stringify(mapping.expectedValue) })) ?? [],
    });
  }
  function updateMapping(index: number, change: Partial<MappingDraft>) {
    setEditor((current) => current ? { ...current, mappings: current.mappings.map((mapping, position) => position === index ? { ...mapping, ...change } : mapping) } : current);
  }
  function addMapping() {
    if (!editor) return;
    try {
      const observation = snapshot?.observations?.observations.find((entry) => entry.id === observationId);
      const mapping: IterationModelMapping = observation ? mappingFromObservation(observation) : {
        id: crypto.randomUUID(), subject: "", metric: "", period: "", periodKind: "single", asOf: null,
        unit: "", scope: "", currency: null, role: "actual", sheet: "", cell: "", expectedValue: null,
      };
      setEditor({ ...editor, mappings: [...editor.mappings, { ...mapping, id: crypto.randomUUID(), literal: "" }] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法添加映射"); }
  }
  function saveModel() {
    if (!editor) return;
    if (snapshot?.modelVersions?.doc_id !== editor.docId) { setError("正在核对所选文件的模型基线，请稍候再保存。"); return; }
    try {
      const mappings = editor.mappings.map(({ literal, ...mapping }) => ({ ...mapping, expectedValue: parseModelLiteral(literal) }));
      void mutate("model-save", { config: {
        expectedRevision: editor.revision, docId: editor.docId, baseVersionId: snapshot?.modelVersions?.current_version_id ?? null,
        mappings, outputs: config?.docId === editor.docId ? config.outputs : undefined, checks: config?.docId === editor.docId ? config.checks : undefined,
      } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "请检查单元格原值"); }
  }
  if (!datasetId) return null;
  return <div className={styles.controls}>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    <section className={styles.panel} aria-labelledby="workflow-model-heading">
      <header><div><small>模型交付</small><h2 id="workflow-model-heading">{modelOnly ? "模型文件与输入" : "框架与 Excel 分开验收"}</h2></div><span>{model?.promotionReceipt ? "本轮模型已验收采用" : model ? modelDeliveryLabels[model.status] : runId ? "尚无本轮模型交付" : "准备下一轮模型"}</span></header>
      <p>{modelOnly ? "选择用于估值的文件，确认需要更新的输入位置。直接更新时，有据可查的实际值、同口径预测或指引会写入新版；重算通过后设为当前模型。没有可靠数据时保留原值。" : "只将口径一致、有明确证据的实际值写入副本。保留公式，重算通过后提供 XLSX；假设修订不自动覆盖。框架发布不等于模型已更新。"}</p>
      <div className={styles.metrics}><span>基线绑定<strong>{config ? `配置 v${config.revision} · ${config.mappings.length} 个输入` : "尚未绑定"}</strong></span><span>本轮实际值<strong>{model?.proposal.length ?? 0} 处</strong></span><span>假设待处理<strong>{model?.manualProposals.length ?? 0} 处</strong></span><span>模型采用状态<strong>{promoted ? "当前模型基线" : model?.promotionReceipt ? "曾采用 · 已非当前基线" : "未采用本轮模型"}</strong></span></div>
      {model?.promotionReceipt && <p>采用回执：{new Date(model.promotionReceipt.promotedAt).toLocaleString()} · 操作者 {model.promotionReceipt.actor} · 配置 v{model.promotionReceipt.configRevisionBefore} → v{model.promotionReceipt.configRevisionAfter}。{!promoted && "当前基线已另行更新，本轮历史采用记录仍保留。"}</p>}
      {model?.error && <p className={styles.error}>{model.error}</p>}
      {snapshot?.modelError && <p role="alert" className={styles.error}>{snapshot.modelError}</p>}
      {model?.status === "unavailable" && <p>请修复重算环境或映射后发起新一轮；本轮原模型和框架记录仍然保留。</p>}
      <div className={styles.actions}>
        <button disabled={busy || !snapshot} onClick={editModel}>{config ? "检查模型输入映射" : "绑定模型输入"}</button>
        {runId && !model && <button disabled={busy} onClick={() => void mutate("model-run")}>补充本轮模型交付</button>}
        {model?.status === "candidate" && <a href={`/api/pe/research-workflow?${new URLSearchParams({ datasetId, runId, download: "model" })}`}>下载已验证 XLSX</a>}
      </div>
      {!!model?.proposal.length && <div className={styles.table}><table><thead><tr><th>模型输入</th><th>原值 → 本轮值</th><th>原因</th></tr></thead><tbody>{model.proposal.map((proposal) => <tr key={proposal.mappingId}><td>{proposal.sheet}!{proposal.cell}</td><td>{String(proposal.expectedValue)} → {String(proposal.newValue)}</td><td>{proposal.reason}</td></tr>)}</tbody></table></div>}
      {!!model?.skips.length && <details><summary>查看未写回项与待处理假设（{model.skips.length}）</summary><ul>{model.skips.map((skip, index) => <li key={index}>{skip.mappingId || skip.observationId || "模型"}：{modelSkipLabels[skip.reason] || skip.reason}</li>)}</ul>{model.manualProposals.map((proposal) => <p key={proposal.mappingId}>{proposal.sheet}!{proposal.cell}：{String(proposal.expectedValue)} → {String(proposal.newValue)}，仅为建议，未写入。</p>)}</details>}
      {model?.status === "candidate" && !promoted && !model.promotionReceipt && <details><summary>单独确认模型，推进下一轮基线</summary><p>请先完成框架审阅。即使框架仅部分采用，这份模型也包含上方全部实际值调整；未写回的假设仍沿用原值。</p><label className={styles.checkbox}><input type="checkbox" checked={acknowledgeModel} disabled={busy} onChange={(event) => setAcknowledgeModel(event.target.checked)} />我已核对下载模型与本轮实际值，确认独立采用这份模型</label><div className={styles.actions}><button disabled={busy || !acknowledgeModel || model.configRevision !== config?.revision} onClick={() => void mutate("model-promote", { revision: config?.revision, acknowledgeIndependentModel: acknowledgeModel })}>设为下一轮模型基线</button></div></details>}
      {editor && <div className={styles.editor}>
        <h3>确认下一轮模型基线</h3><p>配置只用于新一轮，不追溯套用到旧运行。期间、单位、范围必须与原模型一致；含义不明时保留空缺，不猜测。</p>
        <label>模型文件<select value={editor.docId} disabled={busy} onChange={(event) => setEditor({ ...editor, docId: event.target.value, mappings: [] })}><option value="">选择已入库 XLSX</option>{snapshot?.documents.map((document) => <option key={document.docId} value={document.docId}>{document.filename}</option>)}</select></label>
        {!snapshot?.documents.length && <p>请先在工作区上传模型，完成解析后再绑定。XLSM 暂不写回。</p>}
        <div className={styles.actions}><select aria-label="从本轮观察预填口径" value={observationId} onChange={(event) => setObservationId(event.target.value)}><option value="">手动添加输入</option>{snapshot?.observations?.observations.map((observation) => <option key={observation.id} value={observation.id}>{observation.metric} · {observation.period} · {observation.unit}</option>)}</select><button disabled={busy} onClick={addMapping}>添加映射</button></div>
        {editor.mappings.map((mapping, index) => <fieldset key={mapping.id}><legend>输入 {index + 1} · {mapping.metric || "待填写指标"}</legend><div className={styles.fields}>
          {([['subject','主体'],['metric','指标名称'],['period','报告期'],['unit','单位'],['scope','合并/分部范围'],['sheet','工作表'],['cell','可写单元格']] as const).map(([key, label]) => <label key={key}>{label}<input value={mapping[key]} disabled={busy} onChange={(event) => updateMapping(index, { [key]: key === "cell" ? event.target.value.toUpperCase() : event.target.value })} /></label>)}
          <label>期间类型<select value={mapping.periodKind} disabled={busy} onChange={(event) => updateMapping(index, { periodKind: event.target.value as IterationModelMapping["periodKind"] })}><option value="single">单期</option><option value="cumulative">累计</option><option value="point_in_time">时点</option></select></label>
          <label>数据角色<select value={mapping.role} disabled={busy} onChange={(event) => updateMapping(index, { role: event.target.value as "actual" | "assumption" })}><option value="actual">实际值</option><option value="assumption">{modelOnly ? "预测假设" : "预测假设（仅提示）"}</option></select></label>
          {modelOnly && <label>关联的关键假设<input value={mapping.judgmentIds?.join(",") ?? ""} disabled={busy} onChange={(event) => updateMapping(index, { judgmentIds: event.target.value.split(/[,，]/).map((id) => id.trim()).filter(Boolean) })} placeholder="框架判断 ID，多个用逗号分隔" /></label>}
          {modelOnly && <label>敏感性说明<input value={mapping.sensitivity ?? ""} disabled={busy} onChange={(event) => updateMapping(index, { sensitivity: event.target.value || undefined })} placeholder="例如：销量每降低10%，对利润的影响" /></label>}
          <label>币种（非货币指标留空）<input value={mapping.currency ?? ""} disabled={busy} onChange={(event) => updateMapping(index, { currency: event.target.value || null })} placeholder="CNY / HKD" /></label>
          <label>截止日期（无则留空）<input value={mapping.asOf ?? ""} disabled={busy} onChange={(event) => updateMapping(index, { asOf: event.target.value || null })} /></label>
          <label>单元格原值<input value={mapping.literal} disabled={busy} onChange={(event) => updateMapping(index, { literal: event.target.value })} placeholder="空白留空；文本可用双引号" /></label>
        </div><button disabled={busy} onClick={() => setEditor({ ...editor, mappings: editor.mappings.filter((_, position) => position !== index) })}>移除这条映射</button></fieldset>)}
        <div className={styles.actions}><button disabled={busy || !editor.docId || !editor.mappings.length || snapshot?.modelVersions?.doc_id !== editor.docId} onClick={saveModel}>保存下一轮基线</button><button disabled={busy} onClick={() => setEditor(null)}>取消编辑</button></div>
      </div>}
    </section>
    {!modelOnly && <section className={styles.panel} aria-labelledby="workflow-schedule-heading">
      <header><div><small>持续追踪</small><h2 id="workflow-schedule-heading">定时与新公告使用同一流程</h2></div><span>{plan?.enabled ? snapshot?.monitor.workerOnline ? "后台在线" : "已启用 · 后台未就绪" : "未启用"}</span></header>
      <p>后台运行结束后进入同一个待审列表，不另建一套草稿。有待审、失败或阻塞轮次时暂停新运行，避免重复调用。</p>
      {plan && plan.pipeline !== "iteration" && <p className={styles.notice}>此项目使用旧追踪计划。保存这里的设置会切换到统一流程，旧运行历史保留。</p>}
      <div className={styles.fields}>
        <label>运行间隔（小时）<input type="number" min={1} max={168} value={currentSchedule.intervalHours} disabled={busy} onChange={(event) => setSchedule({ ...currentSchedule, intervalHours: Number(event.target.value) })} /></label>
        <label className={styles.checkbox}><input type="checkbox" checked={currentSchedule.enabled} disabled={busy} onChange={(event) => setSchedule({ ...currentSchedule, enabled: event.target.checked })} />启用后台追踪</label>
        <label className={styles.checkbox}><input type="checkbox" checked={currentSchedule.collectSources} disabled={busy} onChange={(event) => setSchedule({ ...currentSchedule, collectSources: event.target.checked })} />无新文档时查询 Wind 财务信息</label>
      </div>
      <p>后台模型：{snapshot?.serverRuntime.modelId || "未配置"}。后台使用服务端独立模型凭据，不借用聊天账户；模型及 Wind 按各自供应商规则计费。</p>
      {snapshot?.serverRuntime.reason && <p className={styles.notice}>{snapshot.serverRuntime.reason}</p>}
      {currentSchedule.enabled && <label className={styles.checkbox}><input type="checkbox" checked={acknowledgeCosts} onChange={(event) => setAcknowledgeCosts(event.target.checked)} />我确认启用该项目的后台模型调用和所选信息源费用</label>}
      <div className={styles.actions}><button disabled={busy || !snapshot || (currentSchedule.enabled && (!snapshot.serverRuntime.available || !acknowledgeCosts))} onClick={() => void mutate("monitor-save", { ...currentSchedule, revision: snapshot?.monitor.revision, acknowledgeServerCosts: acknowledgeCosts })}>保存追踪设置</button>{plan?.enabled && plan.pipeline === "iteration" && <button disabled={busy} onClick={() => void mutate("monitor-run")}>立即检查 / 重启后台</button>}</div>
      {plan?.enabled && snapshot?.monitor.nextRunAt && <p>下次检查：{new Date(snapshot.monitor.nextRunAt).toLocaleString()}。本机休眠或服务退出时不会执行。</p>}
      {plan?.enabled && <button disabled={busy} onClick={() => void mutate("monitor-pause", { revision: snapshot?.monitor.revision })}>立即暂停追踪</button>}
      {latestMonitor && <p>最近调度：{latestMonitor.status}{latestMonitor.error ? ` · ${latestMonitor.error}` : ""}{latestMonitor.iterationId && <> · <a href={`/research-workbench?${new URLSearchParams({ datasetId, runId: latestMonitor.iterationId })}`}>查看对应轮次</a></>}</p>}
    </section>}
  </div>;
}
