"use client";

import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { checkExcelCitation, excelCitationWarning } from "@earendil-works/pe-boot/source";
import {
  excelColumnLabel,
  parseExcelCellRange,
  peSourceApiUrl,
  peSourceFileUrl,
  type PeExcelSource,
  type PeSourcePayload,
} from "@/lib/pe-source";

interface PeSourceCitationProps {
  cwd: string;
  evidenceId: string;
  children: ReactNode;
  className?: string;
  portalContainer?: Element | null;
}

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; source: PeSourcePayload };

function ExcelSourcePreview({ source }: { source: PeExcelSource }) {
  const evidenceRange = useMemo(() => parseExcelCellRange(source.cell_range), [source.cell_range]);
  const initialCellRef = source.cell_range?.split(":", 1)[0]?.replaceAll("$", "").toUpperCase()
    ?? source.cells[0]?.cell_ref;
  const [selectedCellRef, setSelectedCellRef] = useState(initialCellRef);
  useEffect(() => setSelectedCellRef(initialCellRef), [initialCellRef]);

  const cellMap = useMemo(
    () => new Map(source.cells.map((cell) => [`${cell.row_index}:${cell.col_index}`, cell])),
    [source.cells],
  );
  const selectedCell = source.cells.find((cell) => cell.cell_ref.toUpperCase() === selectedCellRef?.toUpperCase());
  const window = source.grid_window ?? (() => {
    if (source.cells.length === 0) return undefined;
    const rowIndexes = source.cells.map((cell) => cell.row_index);
    const colIndexes = source.cells.map((cell) => cell.col_index);
    return {
      row_start: Math.min(...rowIndexes),
      row_end: Math.max(...rowIndexes),
      col_start: Math.min(...colIndexes),
      col_end: Math.max(...colIndexes),
    };
  })();
  const formulaText = selectedCell?.formula ?? selectedCell?.raw_value ?? selectedCell?.display_value ?? "";
  const selectedValue = selectedCell?.cached_value
    ?? (selectedCell?.formula_cache_status === "missing" ? "无缓存" : selectedCell?.display_value ?? selectedCell?.raw_value ?? "");

  if (!window) {
    return <p className="m-0 p-5 text-sm text-[var(--text-muted)]">该引用范围没有可展示的单元格数据。</p>;
  }
  const rows = Array.from({ length: window.row_end - window.row_start + 1 }, (_, index) => window.row_start + index);
  const columns = Array.from({ length: window.col_end - window.col_start + 1 }, (_, index) => window.col_start + index);
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-10 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--bg-panel)] text-xs">
        <div className="flex w-20 shrink-0 items-center justify-center border-r border-[var(--border)] font-mono text-[var(--text-muted)]">
          {selectedCellRef ?? ""}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3">
          <span className="shrink-0 font-serif italic text-[var(--text-muted)]">fx</span>
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[var(--text)]">{formulaText}</code>
          <span
            className={[
              "w-36 shrink-0 truncate rounded bg-[var(--bg-hover)] px-2 py-1 text-[var(--text-muted)]",
              selectedCell?.formula ? "visible" : "invisible",
            ].join(" ")}
            title={selectedCell?.formula ? `文件缓存值：${selectedValue}（未重新计算）` : undefined}
          >
            缓存值：{selectedValue}
          </span>
          <span className="w-28 shrink-0 truncate text-[var(--text-muted)]" title={selectedCell?.number_format}>
            {selectedCell?.number_format ?? ""}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-left text-xs">
        <thead className="sticky top-0 z-20 bg-[var(--bg-panel)]">
          <tr>
            <th className="sticky left-0 z-30 h-7 min-w-12 border-b border-r border-[var(--border)] bg-[var(--bg-panel)]" />
            {columns.map((column) => (
              <th
                className="h-7 min-w-28 border-b border-r border-[var(--border)] bg-[var(--bg-panel)] px-2 text-center font-medium text-[var(--text-muted)]"
                key={column}
              >
                {excelColumnLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th className="sticky left-0 z-10 h-9 min-w-12 border-b border-r border-[var(--border)] bg-[var(--bg-panel)] px-2 text-center font-medium text-[var(--text-muted)]">
                {row}
              </th>
              {columns.map((column) => {
                const cell = cellMap.get(`${row}:${column}`);
                const inEvidenceRange = evidenceRange !== undefined
                  && row >= evidenceRange.row_start
                  && row <= evidenceRange.row_end
                  && column >= evidenceRange.col_start
                  && column <= evidenceRange.col_end;
                const selected = cell?.cell_ref.toUpperCase() === selectedCellRef?.toUpperCase();
                return (
                  <td
                    className={[
                      "relative h-9 min-w-28 max-w-48 cursor-default border-b border-r border-[var(--border)] px-2 text-[var(--text)]",
                      inEvidenceRange ? "bg-emerald-500/12" : "bg-[var(--bg)]",
                      selected ? "outline-2 -outline-offset-2 outline-emerald-600" : "",
                    ].filter(Boolean).join(" ")}
                    key={column}
                    onClick={() => setSelectedCellRef(cell?.cell_ref ?? `${excelColumnLabel(column)}${row}`)}
                    title={[cell?.formula ?? cell?.raw_value ?? cell?.display_value, cell?.number_format].filter(Boolean).join("\n")}
                  >
                    <span className="block max-w-44 truncate">
                      {cell?.display_value ?? cell?.raw_value ?? ""}{cell?.unit ?? ""}
                    </span>
                    {cell?.formula && (
                      <span className="absolute right-0.5 top-0 text-[8px] font-semibold text-emerald-700 dark:text-emerald-300">fx</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="flex h-9 shrink-0 items-end border-t border-[var(--border)] bg-[var(--bg-panel)] px-4">
        <div className="border-x border-t border-emerald-600 bg-[var(--bg)] px-5 py-1.5 text-xs font-medium">
          {source.sheet_name ?? "Sheet"}
        </div>
      </div>
      {(source.truncated || (source.warnings?.length ?? 0) > 0) && (
        <p className="m-0 border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
          {[source.truncated ? "当前展示引用范围的部分单元格。" : "", ...(source.warnings ?? [])].filter(Boolean).join(" ")}
        </p>
      )}
    </div>
  );
}

function citationLabel(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{ children?: ReactNode; className?: string; encoding?: string }>(child)) return "";
    // KaTeX includes both MathML and visual text. Recover its original source once.
    if (child.props.className?.split(" ").includes("katex")) {
      const findTex = (nodes: ReactNode): string | undefined => {
        for (const node of Children.toArray(nodes)) {
          if (!isValidElement<{ children?: ReactNode; encoding?: string }>(node)) continue;
          if (node.props.encoding === "application/x-tex") return citationLabel(node.props.children);
          const nested = findTex(node.props.children);
          if (nested !== undefined) return nested;
        }
        return undefined;
      };
      const tex = findTex(child.props.children);
      if (tex !== undefined) return `$${tex}$`;
    }
    return citationLabel(child.props.children);
  }).join("");
}

export function PeSourceCitation({ cwd, evidenceId, children, className, portalContainer }: PeSourceCitationProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [retryKey, setRetryKey] = useState(0);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = citationLabel(children);
  const source = state.status === "ready" && state.source.evidence_id === evidenceId && state.source.kind === "excel"
    ? state.source : undefined;
  const warning = excelCitationWarning(checkExcelCitation(label, evidenceId, source));

  const closeDrawer = useCallback(() => {
    setDrawerVisible(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  }, []);

  const openDrawer = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => setDrawerVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(peSourceApiUrl(cwd, evidenceId), { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as PeSourcePayload | { error?: string };
        if (!response.ok) {
          throw new Error("error" in payload && payload.error ? payload.error : "无法读取引用来源。");
        }
        return payload as PeSourcePayload;
      })
      .then((source) => setState({ status: "ready", source }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "无法读取引用来源。" });
        }
      });
    return () => controller.abort();
  }, [cwd, evidenceId, open, retryKey]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (portalContainer) event.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeDrawer, open, portalContainer]);

  const dialog = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className="fixed inset-0 z-[100]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeDrawer();
          }}
          role="presentation"
        >
          <div
            className={[
              "absolute inset-0 bg-black/30 transition-opacity duration-200",
              drawerVisible ? "opacity-100" : "opacity-0",
            ].join(" ")}
            onMouseDown={closeDrawer}
          />
          <section
            aria-label="原始证据"
            aria-modal="true"
            className={[
              "absolute inset-y-0 right-0 flex w-[min(720px,94vw)] flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl transition-transform duration-200 ease-out md:w-[58vw] xl:w-[42vw]",
              drawerVisible ? "translate-x-0" : "translate-x-full",
            ].join(" ")}
            role="dialog"
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-sm font-semibold">原始证据</h2>
                <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                  {state.status === "ready"
                    ? `${state.source.citation}${state.source.version_no ? ` · v${state.source.version_no}` : ""}`
                    : "正在读取引用来源…"}
                </p>
              </div>
              <button
                aria-label="关闭原始证据"
                className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--bg-hover)]"
                onClick={closeDrawer}
                type="button"
              >
                关闭
              </button>
            </header>
            {warning && (
              <p role="alert" className="m-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                {warning} 下方展示 ID 实际指向的来源。
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
              {(state.status === "idle" || state.status === "loading") && (
                <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">正在加载原始资料…</div>
              )}
              {state.status === "error" && (
                <div className="m-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600">
                  <p className="m-0">{state.message}</p>
                  <button
                    className="mt-3 rounded-md border border-current px-3 py-1"
                    onClick={() => setRetryKey((value) => value + 1)}
                    type="button"
                  >
                    重试
                  </button>
                </div>
              )}
              {state.status === "ready" && state.source.kind === "pdf" && (
                <iframe
                  className="h-full min-h-[620px] w-full border-0 bg-white"
                  src={`${peSourceFileUrl(cwd, evidenceId)}#page=${state.source.page_start}&zoom=page-width`}
                  title={`${state.source.filename} 第 ${state.source.page_start} 页`}
                />
              )}
              {state.status === "ready" && state.source.kind === "excel" && (
                <ExcelSourcePreview source={state.source} />
              )}
              {state.status === "ready" && state.source.kind === "text" && (
                <pre className="m-0 whitespace-pre-wrap p-5 text-sm leading-7">{state.source.content}</pre>
              )}
            </div>
          </section>
        </div>,
        portalContainer ?? document.body,
      )
    : null;

  return (
    <>
      {warning && <span className="text-xs text-amber-800 dark:text-amber-200" title={warning}>引用不一致</span>}
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={[
          "relative -top-[0.4em] mx-0.5 inline-flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm align-baseline leading-none text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          className,
        ].filter(Boolean).join(" ")}
        data-pe-source-citation="true"
        data-pe-evidence-id={evidenceId}
        data-pe-citation-mismatch={warning ? "true" : undefined}
        onClick={openDrawer}
        title={typeof children === "string" ? `查看原始证据：${children}` : "查看原始证据"}
        type="button"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6M8 13h8M8 17h5" />
        </svg>
        <span className="sr-only">查看原始证据：{children}</span>
      </button>
      {dialog}
    </>
  );
}
