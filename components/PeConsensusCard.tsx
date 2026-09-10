"use client";

import { useI18n } from "@/hooks/useI18n";
import { consensusRecord, consensusText, type PeConsensusCardData } from "@/lib/pe-consensus";
import { PeSourceCitation } from "./PeSourceCitation";

export function PeConsensusCard({ card, cwd }: { card: PeConsensusCardData; cwd: string }) {
  const { t } = useI18n();
  const stats = card.stats;
  const sample = consensusRecord(stats.sample);
  const ratios = consensusRecord(sample.stance_ratios);
  const missing = Array.isArray(sample.not_mentioned)
    ? sample.not_mentioned.map((item) => consensusText(consensusRecord(item).issuer_name)).filter(Boolean) : [];
  const metrics = ["median", "mean", "range", "iqr", "mad", "spread"] as const;
  const sides = [["bull", card.bull], ["bear", card.bear]] as const;
  const narrative = ["root_cause", "financial_impact", "recent_changes_line", "verification_evidence"] as const;
  return (
    <article className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-5">
      <header>
        <div className="flex flex-wrap items-center gap-x-2 text-[var(--text-muted)]">
          <span>{t("consensus.type." + card.card_type)}</span>
          {card.period && <span>{card.period}</span>}
          <span>{t("consensus.coverage", { count: card.issuer_count, total: card.coverage_total })}</span>
        </div>
        <h3 className="m-0 font-semibold">{card.title || card.question}</h3>
        {card.as_of_date && <div className="text-[var(--text-dim)]">{t("consensus.asOf", { date: card.as_of_date })}</div>}
      </header>
      {card.narrative.consensus_line && <p className="m-0">{card.narrative.consensus_line}</p>}
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1">
        {metrics.map((key) => {
          const value = consensusText(stats[key + "_display"]);
          return value ? <div key={key}><dt className="text-[var(--text-muted)]">{t("consensus." + key)}</dt><dd className="m-0">{value}</dd></div> : null;
        })}
      </dl>
      {consensusText(stats.scope_note) && <p className="m-0">{t("consensus.scope")}: {consensusText(stats.scope_note)}</p>}
      {(Number(stats.excluded_unit_mismatch) > 0 || Number(stats.excluded_scope_mismatch) > 0) && (
        <p className="m-0 text-[var(--text-muted)]">{t("consensus.excluded", {
          unit: consensusText(stats.excluded_unit_mismatch) || "0", scope: consensusText(stats.excluded_scope_mismatch) || "0",
        })}</p>
      )}
      {sample.included_count !== undefined && (
        <p className="m-0 text-[var(--text-muted)]">{t("consensus.stanceSample", { count: consensusText(sample.included_count) })}</p>
      )}
      <div className="flex flex-wrap gap-x-3 text-[var(--text-muted)]">
        {(["bullish", "bearish", "neutral"] as const).map((key) => {
          const count = card.stance_counts[key];
          const ratio = ratios[key];
          return typeof count === "number" ? <span key={key}>{t("consensus.stance." + key)} {count}
            {typeof ratio === "number" && Number.isFinite(ratio) ? " (" + (ratio * 100).toFixed(0) + "%)" : ""}</span> : null;
        })}
      </div>
      {sides.map(([key, entries]) => entries.length > 0 && (
        <div key={key}>
          <strong>{t("consensus." + key)}</strong>
          {entries.map((entry) => <p className="m-0" key={entry.claim_id}>
            {entry.issuer_name}{entry.value_display ? " · " + entry.value_display : ""}: {entry.reason}
          </p>)}
        </div>
      ))}
      {card.company_view && <p className="m-0"><strong>{t("consensus.company")}</strong>: {card.company_view.value_display} {card.company_view.reason}</p>}
      {narrative.map((key) => card.narrative[key] && <p className="m-0" key={key}>
        <strong>{t("consensus." + key)}</strong>: {card.narrative[key]}
      </p>)}
      {missing.length > 0 && <p className="m-0 text-[var(--text-muted)]">{t("consensus.notMentioned")}: {missing.join("、")}</p>}
      <details>
        <summary className="cursor-pointer text-[var(--text-muted)]">{t("consensus.sources", { count: card.sources.length })}</summary>
        {card.sources.map((source) => {
          // 不直接拿 evidence_ids[0]：缺失/跨项目引用只能告警，不能伪装为已核验来源。
          const resolved = source.evidence_ids.filter((id) => !source.unresolved_evidence_ids.includes(id)
            && source.source_links.some((link) => new URLSearchParams(link.split("?", 2)[1]).get("evidence_id") === id));
          return <div className="mt-2 border-t border-[var(--border)] pt-2" key={source.claim_id}>
            <strong>{source.issuer_name}</strong>{source.as_of_date && " · " + source.as_of_date}
            {resolved.map((id, index) => {
              const citation = source.citations[index] || source.issuer_name;
              const label = /^\[([^\]]+)\]\(/u.exec(citation)?.[1] || citation;
              return <PeSourceCitation key={id} cwd={cwd} evidenceId={id}>{label}</PeSourceCitation>;
            })}
            <p className="m-0">{source.claim_text}</p>
            {source.quotes.map((quote, index) => <blockquote className="my-1 ml-0 border-l-2 border-[var(--border)] pl-2 text-[var(--text-muted)]" key={index}>{quote.quote}</blockquote>)}
            {source.unresolved_evidence_ids.length > 0 && <p className="m-0 text-amber-700 dark:text-amber-300">{t("consensus.unresolved")}</p>}
          </div>;
        })}
      </details>
    </article>
  );
}
