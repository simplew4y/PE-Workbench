"use client";

import { useId, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";

export function ProcessDetailsGroup({ label, active = false, children }: {
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  return (
    <div className="mb-3 min-w-0" data-process-details>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`${label} · ${t(expanded ? "chat.collapseProcess" : "chat.expandProcess")}`}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-8 max-w-full items-center gap-2 rounded px-1 text-left text-[12px] text-text-muted hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`shrink-0 ${expanded ? "rotate-90" : ""}`}>
          <path d="m6 3 5 5-5 5" />
        </svg>
        {active && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />}
        <span role={active ? "status" : undefined} className="min-w-0 truncate">{label}</span>
      </button>
      <div id={contentId} hidden={!expanded}>
        {expanded && (
          <div className="mt-2 max-h-[min(420px,55vh)] min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain border-l border-border pl-3 pr-2">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
