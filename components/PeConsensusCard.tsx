"use client";

import type { PeConsensusCard, PeCardSide } from "@/lib/pe-consensus";
import { PeSourceCitation } from "./PeSourceCitation";

interface Props { card: PeConsensusCard; cwd: string; }
function cardSourceFor(card: PeConsensusCard, claimId: string) { return card.sources.find((source) => source.claim_id === claimId); }
function sides(card: PeConsensusCard, values: PeCardSide[], cwd: string) {
  if (values.length === 0) return <div className="text-xs text-[var(--text-dim)]">无</div>;
  return <div className="space-y-1">{values.slice(0, 4).map((side) => <div key={side.claim_id} className="text-xs text-[var(--text)]"><span className="font-medium">{side.issuer_name}</span>{side.value_display ? ` · ${side.value_display}` : ""}{side.reason ? `：${side.reason}` : ""}{cardSourceFor(card, side.claim_id)?.evidence_ids?.[0] && <span className="ml-1"><PeSourceCitation cwd={cwd} evidenceId={cardSourceFor(card, side.claim_id)?.evidence_ids[0] as string}><span className="cursor-pointer text-[var(--accent)]">来源</span></PeSourceCitation></span>}</div>)}</div>;
}
export function PeConsensusCardView({ card, cwd }: Props) {
  return <article data-card-id={card.card_id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3">
    <div className="flex items-start justify-between gap-2"><div><div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{card.card_type}</div><h3 className="m-0 mt-1 text-sm font-semibold text-[var(--text)]">{card.title || card.question}</h3></div><span className="shrink-0 text-[10px] text-[var(--text-muted)]">{card.issuer_count}/{card.coverage_total}</span></div>
    <div className="mt-2 text-xs text-[var(--text-muted)]">{card.period_canonical || "当前期间"}{card.measure ? ` · ${card.measure}` : ""} · as of {card.as_of_date}</div>
    {card.narrative?.root_cause && <p className="mt-2 text-xs leading-5 text-[var(--text)]">{card.narrative.root_cause}</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2"><div><div className="mb-1 text-[10px] text-[var(--text-muted)]">乐观方</div>{sides(card, card.bull, cwd)}</div><div><div className="mb-1 text-[10px] text-[var(--text-muted)]">谨慎方</div>{sides(card, card.bear, cwd)}</div></div>
    {card.sources.length > 0 && <div className="mt-3 border-t border-[var(--border)] pt-2 text-[10px] text-[var(--text-muted)]">{card.sources.length} 条底层观点可回溯</div>}
  </article>;
}
