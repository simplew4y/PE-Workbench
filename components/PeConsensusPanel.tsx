"use client";

import { useEffect, useState } from "react";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { loadPeConsensusCards, type PeConsensusCardsResult } from "@/lib/pe-consensus";
import { PeConsensusCardView } from "./PeConsensusCard";

interface Props { project?: PeProjectSummary; }
export function PeConsensusPanel({ project }: Props) {
  const [result, setResult] = useState<PeConsensusCardsResult | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!project) { setResult(null); setOpen(false); return; }
    const controller = new AbortController();
    fetch(`/api/pe/consensus?datasetId=${encodeURIComponent(project.datasetId)}&limit=20`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json() as PeConsensusCardsResult & { error?: string }; if (!response.ok) { if (response.status === 404) return null; throw new Error(body.error ?? `HTTP ${response.status}`); } return body; })
      .then((body) => { if (!body) { setResult(null); return; } setResult(body); setError(null); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [project]);
  if (!project || (!error && !result?.cards.length)) return null;
  return <section className="mt-2 rounded-lg border border-[var(--border)]"><button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between border-0 bg-transparent px-3 py-2 text-left text-xs font-semibold text-[var(--text-muted)]"><span>共识与分歧</span><span>{error ? "读取失败" : `${result?.cards.length ?? 0} 张卡片`}</span></button>{open && <div className="grid max-h-[460px] gap-2 overflow-y-auto border-t border-[var(--border)] p-2">{error ? <div role="alert" className="text-xs text-red-600">{error}</div> : result?.cards.map((card) => <PeConsensusCardView key={card.card_id} card={card} cwd={project.root} />)}</div>}</section>;
}
