"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { consensusText, fetchPeConsensusCards, type PeConsensusResult } from "@/lib/pe-consensus";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { PeConsensusCard } from "./PeConsensusCard";

interface Props {
  project: PeProjectSummary | null;
  refreshKey?: number;
}

type State = { status: "loading" | "disabled" } | { status: "error"; message: string }
  | { status: "ready"; result: PeConsensusResult };

function ProjectConsensus({ project, refreshKey }: { project: PeProjectSummary; refreshKey: number }) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ status: "loading" });
  const [expanded, setExpanded] = useState(true);
  const [reload, setReload] = useState(0);
  const datasetId = project.datasetId;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: "loading" });
    const load = async () => {
      try {
        const result = await fetchPeConsensusCards(datasetId, controller.signal);
        if (controller.signal.aborted) return;
        setState(result ? { status: "ready", result } : { status: "disabled" });
        // 只轮询进行中的分析；刷新卡片是只读操作，不能偷偷启动模型分析。
        if (result?.status === "running") timer = setTimeout(load, 5000);
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [datasetId, refreshKey, reload]);

  if (state.status === "disabled") return null;
  const result = state.status === "ready" ? state.result : null;
  const statusLabels: Record<string, string> = {
    not_analyzed: "consensus.notAnalyzed", skipped_disabled: "consensus.analysisDisabled",
    skipped_no_model: "consensus.noModel", running: "consensus.running", completed: "consensus.completed",
    partial: "consensus.partial", failed: "consensus.failed",
  };
  return (
    <section className="mx-3 mt-2 border-t border-[var(--border)] pt-2 text-xs" aria-label={t("consensus.title")}>
      <header className="flex items-center gap-2">
        <button type="button" className="flex-1 cursor-pointer text-left font-semibold" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {t("consensus.title")}{result ? " · " + result.total_card_count : ""}
        </button>
        <button type="button" className="cursor-pointer text-[var(--text-muted)]" onClick={() => setReload((value) => value + 1)}>{t("consensus.refresh")}</button>
      </header>
      {expanded && <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pb-2">
        {state.status === "loading" && <p role="status">{t("consensus.loading")}</p>}
        {state.status === "error" && <p role="alert" className="text-red-600">{t("consensus.loadFailed")}: {state.message}</p>}
        {result && <>
          <p className="m-0 text-[var(--text-muted)]">{t("consensus.sampleOnly")}</p>
          <p className="m-0" role="status">{t(statusLabels[result.status] || "consensus.unknown")}</p>
          {result.stale && <p className="m-0 text-amber-700 dark:text-amber-300">{t("consensus.stale")}</p>}
          {result.built_at && <p className="m-0 text-[var(--text-dim)]">{t("consensus.builtAt", { date: result.built_at })}</p>}
          {result.coverage.documents !== undefined && <p className="m-0 text-[var(--text-muted)]">{t("consensus.documentCoverage", {
            count: consensusText(result.coverage.completed_documents) || "0", total: consensusText(result.coverage.documents),
          })}</p>}
          {result.cards.length === 0 && <p className="m-0 text-[var(--text-muted)]">{t("consensus.empty")}</p>}
          {result.cards.map((card) => <PeConsensusCard key={card.card_id} card={card} cwd={project.root} />)}
          {result.total_card_count > result.card_count && <p className="m-0 text-[var(--text-muted)]">{t("consensus.limited", { count: result.card_count, total: result.total_card_count })}</p>}
        </>}
      </div>}
    </section>
  );
}

export function PeConsensusPanel({ project, refreshKey = 0 }: Props) {
  // 切项目立即卸载旧卡片与旧请求，不能把 A 项目的引用带着 B 项目的 cwd 打开。
  return project ? <ProjectConsensus key={project.datasetId + ":" + project.root} project={project} refreshKey={refreshKey} /> : null;
}
