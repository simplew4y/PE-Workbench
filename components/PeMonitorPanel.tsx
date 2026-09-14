"use client";

import { useState } from "react";
import type { FrameworkState, MonitorConfig, getResearchMonitor } from "@earendil-works/pe-boot";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { PeSourceCitation } from "./PeSourceCitation";
import styles from "./PeFrameworkPanel.module.css";

const categories = ["news", "announcements", "financials", "events", "holders", "quote"] as const;
const names = { news: "新闻", announcements: "公告", financials: "财务报告", events: "人事及公司事件", holders: "股东", quote: "行情", inputs: "资料检测", research: "框架复盘", evidence: "证据读取", publication: "版本发布" };
const states: Record<string, string> = { running: "复盘中", fetching: "查询中", saved: "响应已保存", unchanged: "未变更", checked: "已检查", draft: "草稿已生成", published: "框架已更新", review_required: "等待人工确认", failed: "失败", source_error: "来源异常", no_change: "无新增变更", interrupted: "运行中断" };
type Monitor = ReturnType<typeof getResearchMonitor>;

// Quote a complete consequence clause; the full comparison remains one click away.
function changeExcerpt(text: string) {
  const sentences = text.split(/[；。]/u).map((part) => part.trim()).filter(Boolean);
  const consequence = /需|须|失效|冲突|不可用|过时|不再|下调|上调/u;
  const sentence = sentences.find((part) => consequence.test(part)) ?? sentences[0] ?? text;
  if (sentence.length <= 85) return sentence;
  const clauses = sentence.split("，").filter((part) => consequence.test(part));
  const excerpt = clauses.slice(-2).join("，");
  return excerpt.length <= 85 ? excerpt || sentence : clauses.at(-1) ?? sentence;
}

function EvidenceProgress({ detail }: { detail: string }) {
  if (!detail.startsWith("读取证据：")) return <p>{detail}</p>;
  let location: string | null = null;
  try {
    const request: unknown = JSON.parse(detail.slice("读取证据：".length));
    if (request && typeof request === "object") location = "sheet" in request ? ` · ${String(request.sheet)} ${"range" in request ? String(request.range) : ""}` : "page" in request ? ` · 第 ${String(request.page)} 页` : " · 快照正文";
  } catch { /* Older records may only contain descriptive text. */ }
  if (location === null) return <p>{detail}</p>;
  return <><p>读取原始资料{location}</p><details><summary>查看读取位置</summary><small>{detail}</small></details></>;
}

export function PeMonitorPanel({ project, monitor, framework, refresh }: {
  project: PeProjectSummary; monitor: Monitor; framework: FrameworkState; refresh: () => void;
}) {
  const subject = project.companyName || project.name;
  const [config, setConfig] = useState<MonitorConfig>(monitor.config ?? {
    enabled: false, mode: "auto", intervalHours: 24, includeMemos: true,
    objective: `持续复盘 ${subject} 的投资框架。先核对公司与证券身份，区分事实、预测与观点。仅在新证据或已保存观点产生实质影响时修改条目，在 rationale 写清变更原因；无变化原样返回。无数据、来源报错、其他公司公告不能支持判断。`,
    queries: [
      { category: "news", query: `${subject} 最近30天的相关新闻，保留原始发布方、发布时间和链接` },
      { category: "announcements", query: `${subject} 最近30天的公司公告，核对发行人，保留原始链接` },
      { category: "financials", query: `${subject} 最新已发布年度及半年度财报，注明报告期、单位与发布时间` },
      { category: "events", query: `${subject} 最近30天的高管、董事及重大公司事件` },
      { category: "holders", query: `${subject} 最新主要股东及持股比例，注明证券代码与截止日期` },
      { category: "quote", query: project.companyTicker || subject },
    ],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function request(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/pe/frameworks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: project.datasetId, action, ...extra }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败，记录已保留");
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const online = monitor.workerOnline;
  const latest = monitor.runs[0];
  const candidate = framework.drafts.find((draft) => draft.id === latest?.draftId);
  const current = framework.versions.find((version) => version.id === framework.currentVersionId);
  const changedItems = latest?.changes?.filter((change) => !["title", "objective", "horizon", "coverageGaps"].includes(change.id)) ?? [];
  const awaiting = candidate?.status === "open";
  const stale = awaiting && candidate.baseVersionId !== framework.currentVersionId;
  const updated = latest?.status === "published" || candidate?.status === "published";
  const gap = current?.content.coverageGaps.find((text) => /待核验|未完成|冲突|未核实/.test(text));
  const failedSources = latest?.events.filter((event) => event.status === "failed") ?? [];
  const headline = !latest ? "让研究持续跟上变化" : latest.status === "running" ? "正在检查最新资料" : candidate?.status === "rejected" ? "本次建议未采用" : stale ? "这份建议需要重新复盘" : awaiting ? "有一份调整建议待你确认" : updated ? "投资框架已更新" : latest.status === "no_change" ? "本次复盘未调整框架" : "本次检查尚未完成";
  return <article className={`${styles.document} ${styles.monitor}`}>
    <div className={styles.trackingLine}><span>{monitor.config?.enabled ? online ? "自动跟踪中" : "自动跟踪暂时中断" : "自动跟踪未开启"}</span>{monitor.config?.enabled && <small>每 {monitor.config.intervalHours} 小时检查</small>}</div>
    <div className={styles.updateCard}>
      <small>最新动态{latest ? ` · ${new Date(latest.startedAt).toLocaleDateString()}` : ""}</small>
      <h2 role="status">{headline}</h2>
      <p>{!latest ? "开启后会检查新资料，重要变化会出现在这里。" : latest.status === "running" ? "完成后会告诉你哪些判断受到影响。" : candidate?.status === "rejected" ? "保留现有框架，后续继续跟踪。" : stale ? "当前框架已有更新，请基于最新版本重新检查。" : awaiting ? "查看变化后，可以接受或暂不调整。" : updated ? `本轮调整了 ${changedItems.length} 项判断，历史版本已保留。` : latest.status === "no_change" ? "当前框架保留。这不代表已排除所有风险。" : "当前框架保留，暂不能据此判断没有重要变化。"}</p>
      {(updated || awaiting) && changedItems.length > 0 && <><small>变化摘录</small><ul className={styles.keyChanges}>{changedItems.slice(0, 2).map((change) => <li key={change.id}><p className={styles.excerpt}>{change.after ? changeExcerpt(change.after) : "一项原有判断已移除，请查看变化依据。"}</p></li>)}</ul></>}
      {gap && <details className={styles.attention}><summary>仍需核实：{gap.includes("：") ? gap.split("：")[0] : "存在资料缺口"}</summary>{current?.content.coverageGaps.map((item, index) => <p key={index}>{item}</p>)}</details>}
      {failedSources.length > 0 && <p className={styles.sourceNotice}>{[...new Set(failedSources.map((event) => names[event.stage as keyof typeof names] ?? "部分资料"))].join("、")}暂未核实，相关结论仍有信息缺口。</p>}
      {awaiting && <div className={styles.monitorActions}>
        <button type="button" disabled={busy || stale} onClick={() => void request("publish", { draftId: candidate.id, revision: candidate.revision, expectedVersionId: candidate.baseVersionId, requestId: `review_${candidate.id}_${candidate.revision}` })}>接受调整</button>
        <button type="button" disabled={busy} onClick={() => void request("reject", { draftId: candidate.id, revision: candidate.revision, content: candidate.content })}>暂不调整</button>
      </div>}
      {!!latest?.changes?.length && <details><summary>查看变化</summary>{latest.changes.map((change) => <section key={change.id}><p><small>原判断</small><br />{change.before ?? "新增条目"}</p><p><small>新判断</small><br />{change.after ?? "已移除"}</p><p><small>调整依据</small><br />{change.reason}</p></section>)}</details>}
      {latest?.events.some((event) => event.evidenceId) && <details><summary>查看依据</summary>{latest.events.filter((event) => event.evidenceId).map((event, index) => <p key={index}>{names[event.stage as keyof typeof names] ?? "资料"} · <PeSourceCitation cwd={project.root} evidenceId={event.evidenceId!}>原始来源</PeSourceCitation></p>)}</details>}
    </div>
    {error && <p role="alert">{error}</p>}
    <details className={styles.trackingSettings}>
      <summary>自动跟踪设置</summary>
    <div className={styles.monitorActions}>
      <button type="button" disabled={busy || !framework.currentVersionId} onClick={() => void request("monitor-save", { config: { ...(monitor.config?.enabled ? monitor.config : config), enabled: !monitor.config?.enabled }, revision: monitor.revision })}>{monitor.config?.enabled ? "暂停跟踪" : "启用跟踪"}</button>
      <button type="button" disabled={busy || !monitor.config?.enabled || (latest?.status === "running" && online)} onClick={() => void request("monitor-run")}>{online ? "现在检查" : "恢复自动跟踪"}</button>
    </div>
    {!framework.currentVersionId && <p>先保存首版投资框架，再启用跟踪。</p>}
      {monitor.config?.enabled && monitor.nextRunAt && <small>下次检查：{new Date(monitor.nextRunAt).toLocaleString()}</small>}
      <label>更新方式<select value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value as MonitorConfig["mode"] })}><option value="auto">自动更新框架，保留历史版本</option><option value="review">生成草稿，由我确认</option></select></label>
      <label>检查间隔（小时）<input type="number" min={1} max={168} value={config.intervalHours} onChange={(e) => setConfig({ ...config, intervalHours: Number(e.target.value) })} /></label>
      <label><input type="checkbox" checked={config.includeMemos} onChange={(e) => setConfig({ ...config, includeMemos: e.target.checked })} /> 纳入已保存的 Memo 观点</label>
      <details><summary>关注内容与资料来源</summary>
      <label>关注内容<textarea rows={4} value={config.objective} onChange={(e) => setConfig({ ...config, objective: e.target.value })} /></label>
      <p><small>留空的类别不调用。行情只填公司名或 Wind 代码；其他类别填写主体、期间和指标。检索结果不保证覆盖全部披露。</small></p>
      {categories.map((category) => <label key={category}>{names[category]}<textarea rows={2} value={config.queries.find((q) => q.category === category)?.query ?? ""} onChange={(e) => setConfig({ ...config, queries: [...config.queries.filter((q) => q.category !== category), ...(e.target.value.trim() ? [{ category, query: e.target.value }] : [])] })} /></label>)}
      </details>
      <button type="button" disabled={busy} onClick={() => void request("monitor-save", { config: { ...config, enabled: monitor.config?.enabled ?? false }, revision: monitor.revision })}>保存设置</button>
    <details className={styles.monitorHistory}><summary>历史检查与运行详情</summary>{monitor.runs.length === 0 && <p>尚未执行。启用后会立即开始首轮。</p>}
      {monitor.runs.map((run) => {
        const draft = framework.drafts.find((d) => d.id === run.draftId);
        const version = framework.versions.find((v) => v.id === run.versionId);
        const stale = draft?.baseVersionId !== framework.currentVersionId;
        return <details key={run.id} className={styles.monitorRun}>
          <summary>{states[run.status] ?? run.status}{version ? ` · v${version.version}` : ""}{run.events.some((e) => e.status === "failed") ? ` · ${run.events.filter((e) => e.status === "failed").length} 个来源异常` : ""} · {new Date(run.startedAt).toLocaleString()}</summary>
          {run.error && <p role="alert">{run.error}</p>}
          {run.events.map((event, i) => <div key={i} className={styles.monitorEvent}>
            <small>{new Date(event.at).toLocaleTimeString()} · {names[event.stage as keyof typeof names] ?? event.stage} · {states[event.status] ?? event.status}</small>
            {event.stage === "evidence" ? <EvidenceProgress detail={event.detail} /> : <p>{event.detail}</p>}{event.evidenceId && <PeSourceCitation cwd={project.root} evidenceId={event.evidenceId}>查看原始响应</PeSourceCitation>}
          </div>)}
          {!!run.changes?.length && <div><h3>框架为什么改变</h3>{run.changes.map((change) => <section key={change.id}>
            <small>{change.id}</small><p>之前：{change.before ?? "无此条目"}</p><p>现在：{change.after ?? "已移除"}</p><p>依据：{change.reason}</p>
          </section>)}</div>}
          {draft?.status === "open" && <div className={styles.monitorActions}>
            <button type="button" disabled={busy || stale} onClick={() => void request("publish", { draftId: draft.id, revision: draft.revision, expectedVersionId: draft.baseVersionId, requestId: `review_${draft.id}_${draft.revision}` })}>{stale ? "基准已变，请重新复盘" : "确认更新框架"}</button>
            <button type="button" disabled={busy} onClick={() => void request("reject", { draftId: draft.id, revision: draft.revision, content: draft.content })}>拒绝草稿</button>
          </div>}
          {run.status !== "running" && <a href={`/api/files/${project.root.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/generated/monitoring/${run.id}.md?type=download`}>下载本轮 Markdown</a>}
        </details>;
      })}
    </details>
    </details>
  </article>;
}
