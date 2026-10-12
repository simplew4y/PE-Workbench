"use client";

import { useState } from "react";
import { Check, GitCompareArrows, History, RotateCcw, X } from "lucide-react";
import type { IterationChange, IterationChangeDecision, IterationChangeReview, IterationObservations } from "@earendil-works/pe-boot";
import { parseSourceId } from "@earendil-works/pe-boot/source";
import { PeSourceCitation } from "./PeSourceCitation";
import { FrameworkText } from "./PeFrameworkPanel";
import styles from "./FrameworkIterationTest.module.css";

const sections: Record<string, string> = {
  researchSetup: "研究设定", currentAssessment: "当前判断", businessModel: "商业机制", investmentJudgments: "投资判断",
  valuation: "估值与回报", monitoring: "监控与改判", evidenceAndChanges: "证据与缺口",
};
const fields: Record<string, string> = {
  claim: "判断", rationale: "判断依据", verification: "验证方式", invalidation: "失效条件", confidence: "置信度",
  level: "等级", reason: "理由", summary: "摘要", status: "状态", evidenceIds: "来源关联", counterEvidenceIds: "反面证据",
  alternativeExplanations: "其他解释", objective: "研究范围", informationCutoff: "信息截止日", changesSinceLastVersion: "本轮变化",
  sources: "证据目录", coverageGaps: "覆盖缺口", openQuestions: "待核实问题", drivers: "经营驱动", kpis: "关键指标",
  scenarios: "估值情景", rules: "监控规则", returnDrivers: "回报来源", keyUncertainties: "不确定性",
  items: "判断", question: "问题", evidenceNeeded: "所需证据", forecastComparisons: "预期与预测", marketExpectations: "市场预期",
  catalysts: "催化因素", id: "编号", kind: "类型", subject: "主体", origin: "提出者", quality: "资料质量", description: "资料说明",
  limitations: "资料限制", from: "驱动因素", to: "影响目标", mechanism: "作用机制", name: "名称", period: "期间", value: "数值",
  impact: "影响", metric: "指标", marketExpectation: "市场预期", ownForecast: "原预测", difference: "差异", assumptions: "假设",
  unit: "单位", asOf: "截至日期", expectedReturn: "预期回报", calculation: "计算说明", judgmentIds: "关联判断", evidenceId: "来源",
  event: "事件", expectedAt: "预计时间", source: "核查来源", frequency: "频率", warningThreshold: "预警条件",
  invalidationThreshold: "失效条件", action: "处理方式", thresholdBasis: "条件依据", horizon: "研究期限", preferences: "研究偏好",
};
const decisions = { pending: "待决定", accepted: "已接受", rejected: "未采用" };
function sourceDescription(id: string, documents: IterationChangeReview["plan"]["documents"]): string {
  const source = parseSourceId(id);
  const file = documents.find((document) => document.docId === source?.docId);
  const position = source?.location;
  const location = position?.kind === "pdf" ? `第 ${position.pageStart}${position.pageEnd !== position.pageStart ? `–${position.pageEnd}` : ""} 页`
    : position?.kind === "excel" ? `${position.sheet} · ${position.range}` : position?.kind === "text" ? `第 ${position.lineStart}–${position.lineEnd} 行` : "原文位置";
  return `${file?.filename || "资料"} · ${location}`;
}
function SourceLabel({ id, cwd, documents }: { id: string; cwd: string; documents: IterationChangeReview["plan"]["documents"] }) {
  const label = sourceDescription(id, documents);
  return <span className={styles.citationItem}><span>{label}</span><PeSourceCitation cwd={cwd} evidenceId={id}>{label}</PeSourceCitation></span>;
}
function ChangeValue({ value, exists = true, cwd, documents }: { value: unknown; exists?: boolean; cwd: string; documents: IterationChangeReview["plan"]["documents"] }) {
  if (!exists) return <p>（无此内容）</p>;
  if (value === null || value === undefined) return <p className={styles.caption}>待补充或未核实</p>;
  if (typeof value === "string" && parseSourceId(value)) return <SourceLabel id={value} cwd={cwd} documents={documents} />;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((entry, index) => <li key={index}><ChangeValue value={entry} cwd={cwd} documents={documents} /></li>)}</ul> : <p className={styles.caption}>（空）</p>;
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{fields[key] || key}</dt><dd><ChangeValue value={entry} cwd={cwd} documents={documents} /></dd></div>)}</dl>;
  return <p>{String(value)}</p>;
}
function location(change: IterationChange, documents: IterationChangeReview["plan"]["documents"]): string {
  return change.path.slice(1).map((segment) => sections[segment] || fields[segment] || (segment.startsWith("@order:") ? "展示顺序" : segment.startsWith("@evidenceId:") ? sourceDescription(segment.slice(12), documents) : segment.startsWith("@") ? segment.slice(segment.indexOf(":") + 1) : segment)).join(" / ");
}
export function FrameworkChangeReview({ review, observations, cwd, editable, busy, onDecide, onPublish, onReject }: {
  review: IterationChangeReview; observations?: IterationObservations; cwd: string; editable: boolean; busy: boolean;
  onDecide: (ids: string[], decision: IterationChangeDecision, note: string) => Promise<void>;
  onPublish: (acknowledgeWarnings: boolean) => Promise<void>; onReject: () => Promise<void>;
}) {
  const [section, setSection] = useState("all");
  const [filter, setFilter] = useState("all");
  const [notes, setNotes] = useState<Record<string, { value: string; at: string }>>({});
  const [acknowledgment, setAcknowledgment] = useState({ revision: -1, checked: false });
  const acknowledged = acknowledgment.revision === review.revision && acknowledgment.checked;
  const changes = review.plan.changes;
  const counts = { pending: 0, accepted: 0, rejected: 0 };
  for (const change of changes) counts[review.decisions[change.id].decision]++;
  const shown = changes.filter((change) => (section === "all" || change.section === section) &&
    (filter === "all" || review.decisions[change.id].decision === filter));
  const canPublish = editable && !busy && counts.accepted > 0 && review.errors.length === 0 && !!review.preview &&
    (!review.warnings.length || acknowledged);
  function revealChange(id: string) {
    setSection("all"); setFilter("all");
    window.requestAnimationFrame(() => document.getElementById(`change-${id}`)?.scrollIntoView({ block: "center" }));
  }
  return <section className={`${styles.panel} ${styles.changeReview}`} aria-label="逐项审查框架修改">
    <div className={styles.sectionHeading}><GitCompareArrows size={19} /><h2>审查框架修改</h2><span className={styles.count}>{changes.length} 处修改</span></div>
    <p className={styles.reviewIntro}>每处修改可独立接受或不采用，决定保存后可撤回。关联位置供你核查，可展开后显式批量处理；发布前检查实际组装内容。</p>
    <div className={styles.reviewStats}><span>待决定 <strong>{counts.pending}</strong></span><span>已接受 <strong>{counts.accepted}</strong></span><span>未采用 <strong>{counts.rejected}</strong></span><span>审查记录 <strong>r{review.revision}</strong></span></div>
    <div className={styles.reviewToolbar}>
      <label>筛选决定<select aria-label="筛选审查决定" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部修改</option>{Object.entries(decisions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {editable && <div><button disabled={busy} onClick={() => void onDecide(changes.map((change) => change.id), "accepted", "全部接受")}>接受全部</button><button disabled={busy} onClick={() => void onDecide(changes.map((change) => change.id), "rejected", "全部不采用")}>全部不采用</button></div>}
    </div>
    <div className={styles.reviewGrid}>
      <nav className={styles.changeNav} aria-label="修改章节"><button aria-current={section === "all" ? "page" : undefined} onClick={() => setSection("all")}>全部章节<span>{changes.length}</span></button>{Object.entries(sections).filter(([key]) => changes.some((change) => change.section === key)).map(([key, label]) => <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>{label}<span>{changes.filter((change) => change.section === key).length}</span></button>)}</nav>
      <div className={styles.changeList}>
        {shown.map((change) => {
          const decision = review.decisions[change.id];
          const linked = changes.filter((entry) => entry.groupId === change.groupId);
          const related = changes.filter((entry) => entry.groupId !== change.groupId &&
            (change.dependencies.includes(entry.groupId) || change.judgmentIds.some((id) => entry.judgmentIds.includes(id))));
          const facts = observations?.observations.filter((entry) => change.observationIds.includes(entry.id)) || [];
          const draftNote = notes[change.id];
          const note = draftNote?.at === decision.at ? draftNote.value : decision.note;
          const title = location(change, review.plan.documents);
          return <article className={styles.changeCard} data-decision={decision.decision} key={change.id} id={`change-${change.id}`}>
            <header><div><small>{sections[change.section]}{change.judgmentIds.length ? ` · ${change.judgmentIds.join("、")}` : ""}</small><h3>{title}</h3></div><span className={styles.decisionTag}>{decisions[decision.decision]}</span></header>
            <div className={styles.diffPair}><div className={styles.diffBefore}><span>− 基线内容</span><div className={styles.diffValue}><ChangeValue value={change.before} exists={change.beforeExists} cwd={cwd} documents={review.plan.documents} /></div></div><div className={styles.diffAfter}><span>＋ 模型建议</span><div className={styles.diffValue}><ChangeValue value={change.after} exists={change.afterExists} cwd={cwd} documents={review.plan.documents} /></div></div></div>
            <details><summary>修改原因与证据{change.evidenceIds.length ? ` · ${change.evidenceIds.length} 个来源` : ""}</summary>
              {change.reasons.length ? change.reasons.map((reason, index) => <p key={index}>{reason}</p>) : <p>本项为框架范围、整体说明或证据目录的配套修改，请结合本轮判断影响核查。</p>}
              {facts.map((fact) => <blockquote key={fact.id}><strong>{fact.metric} · {fact.period || "期间待核实"} · {fact.unit || "单位待核实"}</strong><p>{fact.quote}</p>{fact.gaps.length > 0 && <small>{fact.gaps.join("；")}</small>}<div className={styles.changeSources}>{fact.evidenceIds.map((id) => <SourceLabel key={id} id={id} cwd={cwd} documents={review.plan.documents} />)}</div></blockquote>)}
              <div className={styles.changeSources}>{change.evidenceIds.map((id) => <SourceLabel key={id} id={id} cwd={cwd} documents={review.plan.documents} />)}</div>
            </details>
            {editable && <div className={styles.changeDecision}>
              <label>审查备注<textarea value={note} maxLength={2000} aria-label={`审查备注 ${title}`} onChange={(event) => setNotes((current) => ({ ...current, [change.id]: { value: event.target.value, at: decision.at } }))} placeholder="记录本项采纳理由、证据疑点或未采用原因" /></label>
              <div><button disabled={busy} onClick={() => void onDecide([change.id], "accepted", note)}><Check size={14} />接受本项</button><button disabled={busy} onClick={() => void onDecide([change.id], "rejected", note)}><X size={14} />不采用本项</button><button disabled={busy || decision.decision === "pending"} onClick={() => void onDecide([change.id], "pending", note)}><RotateCcw size={13} />撤回本项决定</button></div>
              {linked.length > 1 && <details><summary>批量处理同判断或章节的修改（{linked.length}处）</summary><p>仅批量操作会同时决定以下位置，并使用本项备注。关联不表示必须一起采纳。</p><ul>{linked.map((entry) => <li key={entry.id}><a href={`#change-${entry.id}`} onClick={(event) => { event.preventDefault(); revealChange(entry.id); }}>{location(entry, review.plan.documents)}</a> · {decisions[review.decisions[entry.id].decision]}</li>)}</ul><div><button disabled={busy} onClick={() => void onDecide(linked.map((entry) => entry.id), "accepted", note)}>接受以上{linked.length}处</button><button disabled={busy} onClick={() => void onDecide(linked.map((entry) => entry.id), "rejected", note)}>不采用以上{linked.length}处</button></div></details>}
              {!!related.length && <details><summary>其他关联位置（{related.length}处）</summary><p>这些位置可分别决定，请核查结论、依据和配套内容是否一致。</p><ul>{related.map((entry) => <li key={entry.id}><a href={`#change-${entry.id}`} onClick={(event) => { event.preventDefault(); revealChange(entry.id); }}>{location(entry, review.plan.documents)}</a> · {decisions[review.decisions[entry.id].decision]}</li>)}</ul></details>}
            </div>}
            {decision.at && <small className={styles.decisionMeta}>{new Date(decision.at).toLocaleString()} · {decision.note || "已保存审查决定"}</small>}
          </article>;
        })}
        {!shown.length && <p className={styles.reviewIntro}>当前筛选下没有修改。</p>}
      </div>
    </div>
    {editable && <div className={styles.reviewPublish}>
      {review.errors.length > 0 && <details open><summary>发布前待处理事项</summary><ul>{review.errors.map((error) => <li key={error}>{error}</li>)}</ul></details>}
      {review.warnings.length > 0 && <><ul>{review.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledgment({ revision: review.revision, checked: event.target.checked })} />已核查组装框架并确认以上限制</label></>}
      {review.preview && <details><summary>查看已接受修改组装后的完整框架</summary><FrameworkText cwd={cwd} content={review.preview} /></details>}
      <div className={styles.reviewFooter}><p>只有已接受内容进入新版本。原候选和所有审查决定永久保留。</p><button disabled={!canPublish} onClick={() => void onPublish(acknowledged)}>发布已接受的修改</button>{counts.pending === 0 && counts.accepted === 0 && <button disabled={busy} onClick={() => void onReject()}>结束本轮，不新增版本</button>}</div>
    </div>}
    {!editable && !review.events.length && <p className={styles.reviewIntro}>本轮由旧流程完成，没有逐项人工审查记录。此处仅展示模型候选与基线的差异。</p>}
    {!editable && !!review.warnings.length && <ul>{review.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    {review.publication && <p className={styles.publicationReceipt}>已发布 · 审查 r{review.publication.revision} · {new Date(review.publication.at).toLocaleString()}</p>}
    <details><summary><History size={14} />审查轨迹 · {review.events.length} 次操作</summary><ol className={styles.reviewHistory}>{review.events.map((event) => <li key={event.revision}><strong>r{event.revision} · {decisions[event.decision]} · {event.changeIds.length} 处</strong><span>{new Date(event.at).toLocaleString()} · 操作人 {event.actorId}</span><p>{event.note || "未填写备注"}</p></li>)}</ol><details><summary>模型与候选标识</summary><pre>{JSON.stringify({ planId: review.plan.id, baseline: review.plan.basisVersionId, modelId: review.plan.modelId, processorVersion: review.plan.processorVersion }, null, 2)}</pre></details></details>
  </section>;
}
