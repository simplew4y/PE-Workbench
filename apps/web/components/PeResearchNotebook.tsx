"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { useRouter } from "next/navigation";
import type { ResearchCardRevision, ResearchCardView, ResearchCardStatus } from "@earendil-works/pe-boot";
import type { FrameworkItem } from "@earendil-works/pe-boot/framework-report";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { PeSourceCitation } from "./PeSourceCitation";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./PeResearchNotebook.module.css";
import { researchCardRevisionChanges } from "@/lib/research-card-history";
import { researchProgress, researchProgressMarkdown } from "@/lib/research-progress";
import { cleanResearchSelection } from "@/lib/research-selection";

const statusNames: Record<ResearchCardStatus, string> = { unverified: "待核实", confirmed: "已人工确认", open: "待研究", resolved: "已解决" };
const statusClassNames: Record<ResearchCardStatus, string> = { unverified: styles.unverified, confirmed: styles.confirmed, open: styles.open, resolved: styles.resolved };
const frameworkKindNames: Record<FrameworkItem["kind"], string> = { thesis: "核心论点", hypothesis: "关键假设", metric: "跟踪指标", question: "待核实问题", event: "经营事件" };

function excerptRange(root: HTMLElement, excerpt: string): Range | null {
  const target = excerpt.replace(/\s/gu, "");
  if (!target) return null;
  for (const markdown of root.querySelectorAll<HTMLElement>(".markdown-body")) {
    const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT);
    const points: Array<{ node: Text; offset: number }> = [];
    let normalized = "";
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const node = current as Text;
      for (let offset = 0; offset < node.data.length; offset += 1) {
        if (/\s/u.test(node.data[offset])) continue;
        normalized += node.data[offset];
        points.push({ node, offset });
      }
    }
    const start = normalized.indexOf(target);
    if (start < 0) continue;
    const first = points[start];
    const last = points[start + target.length - 1];
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }
  return null;
}

async function saveCard(datasetId: string, data: Record<string, unknown>) {
  const response = await fetch("/api/pe/research-cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "保存失败，请重试");
  return result.card as ResearchCardView;
}

export function ResearchCardCapture({ project, sessionId, entryId, text, sourceHighlight, onSaved, children }: {
  project: PeProjectSummary; sessionId: string; entryId: string; text: string; sourceHighlight?: string; onSaved: () => void; children: ReactNode;
}) {
  const answer = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"note" | "question" | null>(null);
  const [selection, setSelection] = useState<{ text: string; range: Range; evidenceIds: string[] } | null>(null);
  const [excerpt, setExcerpt] = useState("");
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let dragging = false;
    let frame = 0;
    const capture = () => {
      if (dragging || kind || inFlight.current || popup.current?.contains(document.activeElement)) return;
      const selected = window.getSelection();
      const root = answer.current;
      const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
      const start = element(selected?.anchorNode ?? null)?.closest(".markdown-body");
      const end = element(selected?.focusNode ?? null)?.closest(".markdown-body");
      if (!selected || selected.isCollapsed || !selected.rangeCount || !root ||
        !root.contains(selected.anchorNode) || !root.contains(selected.focusNode) || !start || start !== end) {
        setSelection(null); return;
      }
      const range = selected.getRangeAt(0);
      const citations = [...root.querySelectorAll<HTMLElement>("[data-pe-source-citation]")]
        .filter((citation) => range.intersectsNode(citation));
      const value = cleanResearchSelection(selected.toString(), citations.map((citation) => citation.textContent ?? ""));
      if (!value) { setSelection(null); return; }
      const evidenceIds = citations.map((citation) => citation.dataset.peEvidenceId).filter((id): id is string => !!id);
      setSelection({ text: value, range: range.cloneRange(), evidenceIds: [...new Set(evidenceIds)] });
      setSaved(false); setError("");
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    const down = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) dragging = true;
    };
    const up = () => { dragging = false; schedule(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.shiftKey && popup.current && !kind &&
        !popup.current.contains(document.activeElement) && window.getSelection()?.toString().trim()) {
        event.preventDefault(); popup.current.querySelector("button")?.focus();
      }
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("keydown", keyboard);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("keydown", keyboard);
    };
  }, [kind, text]);
  useEffect(() => { if (kind) titleInput.current?.focus(); }, [kind]);
  useEffect(() => {
    if (!sourceHighlight || !answer.current) return;
    const frame = requestAnimationFrame(() => {
      const root = answer.current;
      if (!root) return;
      const range = excerptRange(root, sourceHighlight);
      root.scrollIntoView({ block: "center" });
      root.focus({ preventScroll: true });
      if (range) {
        const registry = (CSS as typeof CSS & { highlights?: { set: (name: string, highlight: unknown) => void } }).highlights;
        const Highlight = (window as Window & { Highlight?: new (range: Range) => unknown }).Highlight;
        if (registry && Highlight) registry.set("research-source", new Highlight(range));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      (CSS as typeof CSS & { highlights?: { delete: (name: string) => void } }).highlights?.delete("research-source");
    };
  }, [sourceHighlight]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 3500);
    return () => window.clearTimeout(timer);
  }, [saved]);
  function close() {
    if (inFlight.current) return;
    setSelection(null); setKind(null); setError("");
    const current = window.getSelection();
    if (answer.current?.contains(current?.anchorNode ?? null)) current?.removeAllRanges();
  }
  function open(next: "note" | "question") {
    if (!selection || selection.text.length > 20000) return;
    setKind(next); setExcerpt(selection.text); setError(""); setQuestion("");
    setTitle(next === "note" ? selection.text.split("\n")[0].slice(0, 80) : "");
  }
  async function save() {
    if (inFlight.current || !kind) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const data = { action: "create", kind, title, content: kind === "note" ? excerpt : question || title,
        source: { sessionId, entryId, excerpt, format: "rendered", evidenceIds: selection?.evidenceIds ?? [] }, relatedCardIds: [] };
      const key = JSON.stringify(data);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      await saveCard(project.datasetId, { ...data, requestId: request.current.id });
      setKind(null); setSelection(null); setSaved(true);
      window.getSelection()?.removeAllRanges(); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const anchor = selection ? {
    getBoundingClientRect: () => {
      const rects = selection.range.getClientRects();
      return rects[rects.length - 1] ?? selection.range.getBoundingClientRect();
    },
    contextElement: answer.current ?? undefined,
  } : null;
  return <div id={`research-answer-${entryId}`}>
    <div ref={answer} className={sourceHighlight ? styles.sourceAnswer : undefined} tabIndex={sourceHighlight ? -1 : undefined}>{children}</div>
    {saved && <div className={styles.savedToast} role="status">已保存选中文字到项目研究积累</div>}
    <Popover.Root open={!!selection} onOpenChange={(value) => { if (!value) close(); }}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} positionMethod="fixed" side="bottom" align="start" sideOffset={8} collisionPadding={12} className={styles.capturePositioner}>
          <Popover.Popup ref={popup} initialFocus={false} finalFocus={false} className={styles.capture + (kind ? " " + styles.captureEditor : "")}>
            <Popover.Title className={styles.captureTitle}>{kind ? (kind === "note" ? "保存研究成果" : "记录待研究问题") + " · " + project.name : "选中文字"}</Popover.Title>
            {!kind ? <>
              <div className={styles.actions}>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => open("note")} disabled={(selection?.text.length ?? 0) > 20000}>保存研究成果</button>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => open("question")} disabled={(selection?.text.length ?? 0) > 20000}>记录待研究问题</button>
                <button type="button" aria-label="关闭摘录浮层" onClick={close}>关闭</button>
              </div>
              {(selection?.text.length ?? 0) > 20000 && <p role="alert">选中文字超过 20000 字符，请缩小选区。</p>}
            </> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{kind === "note" ? "标题" : "待研究问题"}<input ref={titleInput} required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {kind === "question" && <label>补充说明<textarea maxLength={20000} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="还缺哪些证据？下一次希望验证什么？" /></label>}
        <label>选中摘录 · {excerpt.length} 字符<blockquote className={styles.excerpt}>{excerpt}</blockquote></label>
        <p className={styles.meta}>仅保存这段选中文字，保留来源会话，并关联选区内的 {selection?.evidenceIds.length ?? 0} 项资料入口。</p>
        <div className={styles.actions}><button className={styles.primary} disabled={busy || !title.trim() || !excerpt.trim()}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={close}>取消</button></div>
      </form>}
            {error && <p role="alert" className={styles.error}>{error}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}

export function PeResearchNotebook({ project, refreshKey, frameworkItems = [], onOpenFramework, onOpenSource, onSessionCreated, model, toolNames, agentUnavailable = false }: {
  project: PeProjectSummary; refreshKey: number; frameworkItems?: Pick<FrameworkItem, "id" | "kind" | "subject">[]; onOpenFramework: () => void; onOpenSource?: (target: { sessionId: string; cardId: string; entryId: string; excerpt: string }) => void; onSessionCreated?: (id: string) => void;
  model?: { provider: string; modelId: string }; toolNames?: string[]; agentUnavailable?: boolean;
}) {
  const router = useRouter();
  const [cards, setCards] = useState<ResearchCardView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealedCard, setRevealedCard] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<ResearchCardView | null>(null);
  const [historyCardId, setHistoryCardId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ResearchCardRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [frameworkItemIds, setFrameworkItemIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("请基于选中的研究记录继续分析，先列出已知判断、待验证假设和未解决问题，再核对本项目原始资料。");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const editor = useRef<HTMLFormElement>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!adding && !editing) return;
    const frame = requestAnimationFrame(() => {
      editor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      editor.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [adding, editing]);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/pe/research-cards?${new URLSearchParams({ datasetId: project.datasetId })}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "读取研究积累失败");
        if (!controller.signal.aborted) { setCards(result.cards); setLoaded(true); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败"); }
    }
    void load();
    const refresh = () => setReload((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [project.datasetId, refreshKey, reload]);

  async function action(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function update(card: ResearchCardView, changes: Partial<Pick<ResearchCardView, "title" | "content" | "status" | "archived" | "frameworkItemIds">>) {
    const next = await saveCard(project.datasetId, { action: "update", id: card.id, revision: card.revision,
      title: card.title, content: card.content, status: card.status, archived: card.archived, frameworkItemIds: card.frameworkItemIds, ...changes });
    setCards((current) => current.map((item) => item.id === next.id ? next : item));
    setSelected((current) => { const value = { ...current }; delete value[card.id]; return value; });
    setNotice("已保存");
  }
  async function loadHistory(cardId: string) {
    setHistoryCardId(cardId); setHistoryLoading(true);
    try {
      const response = await fetch(`/api/pe/research-cards?${new URLSearchParams({ datasetId: project.datasetId, id: cardId })}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "读取卡片历史失败");
      setRevisions(result.revisions);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取卡片历史失败"); }
    finally { setHistoryLoading(false); }
  }
  async function restoreRevision(card: ResearchCardView, targetRevision: number) {
    const next = await saveCard(project.datasetId, { action: "restore", id: card.id, revision: card.revision, targetRevision });
    setCards((current) => current.map((item) => item.id === next.id ? next : item));
    setSelected((current) => { const value = { ...current }; delete value[card.id]; return value; });
    setNotice(`已将卡片内容恢复为 v${targetRevision}，并保存为 v${next.revision}`);
    await loadHistory(card.id);
  }
  const progress = researchProgress(cards, project.datasetId);
  const active = progress.active;
  useEffect(() => {
    if (!revealedCard) return;
    const element = document.getElementById("research-card-" + revealedCard);
    element?.scrollIntoView({ block: "nearest" });
    element?.focus({ preventScroll: true });
    setRevealedCard(null);
  }, [revealedCard]);
  function reveal(card: ResearchCardView) {
    setFilter("active"); setQuery(""); setRevealedCard(card.id);
  }
  function openSource(card: ResearchCardView) {
    if (!card.origin) return;
    onOpenSource?.({ sessionId: card.origin.sessionId, cardId: card.id, entryId: card.origin.entryId, excerpt: card.origin.excerpt });
  }
  function exportProgress() {
    const markdown = researchProgressMarkdown(cards, project.datasetId, project.name, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = project.name.replace(/[\\/:*?"<>|]/g, "_") + "-研究进展.md";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const selection = Object.entries(selected).map(([id, revision]) => ({ id, revision }));
  const staleSelection = selection.some((item) => !cards.some((card) => card.id === item.id && card.revision === item.revision && !card.archived));
  const visible = cards.filter((card) => (filter === "archived" ? card.archived : !card.archived && (filter === "active" || card.kind === filter || card.status === filter)) &&
    `${card.title}\n${card.content}`.toLowerCase().includes(query.toLowerCase()));
  async function continueResearch() {
    const response = await fetch("/api/agent/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      cwd: project.root, type: "prompt", message: question, ...model, toolNames,
      researchContext: { datasetId: project.datasetId, selection },
    }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "新会话创建失败");
    if (onSessionCreated) onSessionCreated(result.sessionId);
    else router.push(`?session=${encodeURIComponent(result.sessionId)}`);
  }
  return <div className={styles.panel}>
    <p className={styles.intro}>保留有价值的判断和未解决的问题，让下一次研究从这里继续。</p>
    <div className={styles.stats}>
      <div><strong>{active.filter((card) => card.kind === "note").length}</strong><span>研究成果</span></div>
      <div><strong>{active.filter((card) => card.status === "open").length}</strong><span>待研究问题</span></div>
      <div><strong>{active.filter((card) => card.status === "unverified").length}</strong><span>待核实成果</span></div>
    </div>
    {loaded && active.length > 0 && <section className={styles.progress} aria-label="研究进展概览">
      <h3>研究到哪里了</h3>
      <p className={styles.meta}>根据已保存记录整理，不额外调用模型。已归档记录不计入。</p>
      {progress.latest && <p>最近更新：<button type="button" onClick={() => reveal(progress.latest!)}>{progress.latest.title}</button>
        <span className={styles.meta}> · {new Date(progress.latest.updatedAt).toLocaleString()}</span></p>}
      {([
        ["已保留的判断", progress.confirmed, "还没有人工确认的成果。"],
        ["接下来待回答", progress.open, "暂无已记录的待研究问题，不代表研究已完整。"],
        ["仍需核实", progress.unverified, "暂无待核实成果。"],
      ] as const).map(([label, entries, empty]) => <div key={label}>
        <h4>{label} · {entries.length}</h4>
        {entries.length ? <ul>{entries.slice(0, 3).map((card) => <li key={card.id}>
          <button type="button" onClick={() => reveal(card)}>{card.title}</button>
        </li>)}</ul> : <p className={styles.meta}>{empty}</p>}
        {entries.length > 3 && <p className={styles.meta}>显示最近更新的 3 项，其余可在下方筛选查看。</p>}
      </div>)}
      {progress.evidenceGaps.length > 0 && <p className={styles.meta}>其中 {progress.evidenceGaps.length} 项成果缺少资料入口或存在不可定位引用，继续研究时需要补充核查。</p>}
    </section>}
    <div className={styles.actions}>
      <button type="button" onClick={onOpenFramework}>查看投资框架</button>
      <button type="button" disabled={!loaded || busy || !active.length || !!error} onClick={exportProgress}>导出研究进展</button>
      <button type="button" disabled={busy} onClick={() => { setAdding(true); setEditing(null); setTitle(""); setContent(""); setFrameworkItemIds([]); }}>新增研究问题</button>
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>刷新</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert" className={styles.error}>{error}<button type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {(adding || editing) && <form ref={editor} className={styles.form} onSubmit={(event) => {
      event.preventDefault(); void action(async () => {
        if (editing) await update(editing, { title, content, frameworkItemIds, status: editing.kind === "note" ? "unverified" : "open" });
        else {
          const data = { action: "create", kind: "question", title, content: content || title, relatedCardIds: selection.map((item) => item.id), frameworkItemIds };
          const key = JSON.stringify(data);
          if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
          const card = await saveCard(project.datasetId, { ...data, requestId: request.current.id });
          setCards((current) => [card, ...current.filter((item) => item.id !== card.id)]); setNotice("研究问题已保存");
        }
        setAdding(false); setEditing(null);
      });
    }}>
      <strong>{editing ? "编辑研究卡片" : "新增研究问题"}</strong>
      <label>标题<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{editing ? "研究内容" : "需要继续核实什么"}<textarea required={!!editing} maxLength={20000} rows={5} value={content} onChange={(event) => setContent(event.target.value)} /></label>
      <fieldset className={styles.frameworkLinks}><legend>关联投资框架条目</legend>
        {frameworkItems.length ? frameworkItems.map((item) => <label key={item.id}><input type="checkbox" checked={frameworkItemIds.includes(item.id)} disabled={!frameworkItemIds.includes(item.id) && frameworkItemIds.length >= 20} onChange={(event) => setFrameworkItemIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span>{frameworkKindNames[item.kind]} · {item.subject}</span></label>) : <p className={styles.meta}>当前还没有已发布的投资框架条目。</p>}
        {editing?.frameworkItems.filter((item) => !item.available).map((item) => <label key={item.id}><input type="checkbox" checked={frameworkItemIds.includes(item.id)} disabled={!frameworkItemIds.includes(item.id) && frameworkItemIds.length >= 20} onChange={(event) => setFrameworkItemIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span>{item.id} · 最新框架中已移除，可取消关联</span></label>)}
      </fieldset>
      <p className={styles.meta}>{editing ? "修改内容后需要重新核实，原回答摘录和来源仍会保留。" : `将关联当前勾选的 ${selection.length} 张卡片及其资料入口。`}</p>
      <div className={styles.actions}><button className={styles.primary} disabled={busy || !title.trim() || (adding && staleSelection)}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={() => { setAdding(false); setEditing(null); }}>取消</button></div>
    </form>}
    <input className={styles.search} aria-label="搜索研究积累" placeholder="搜索标题或研究内容" value={query} onChange={(event) => setQuery(event.target.value)} />
    <select className={styles.filter} aria-label="筛选研究卡片" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="active">全部研究积累</option><option value="note">研究成果</option><option value="question">研究问题</option><option value="open">待研究</option><option value="unverified">待核实</option><option value="confirmed">已人工确认</option><option value="resolved">已解决</option><option value="archived">已归档</option>
    </select>
    {!loaded && !error && <p role="status">正在读取研究积累…</p>}
    {loaded && visible.length === 0 && <p className={styles.empty}>{cards.length ? "没有符合条件的卡片。" : "选中回答中的文字，在浮层中保存研究成果，或先记录一个想继续研究的问题。"}</p>}
    {visible.map((card) => <article className={styles.card} key={card.id} id={"research-card-" + card.id} tabIndex={-1}>
      <div className={styles.cardHeader}>
        <input type="checkbox" aria-label={`选择：${card.title}`} checked={selected[card.id] !== undefined} disabled={busy || card.archived || (selection.length >= 20 && selected[card.id] === undefined)} onChange={(event) => setSelected((current) => {
          const value = { ...current }; if (event.target.checked) value[card.id] = card.revision; else delete value[card.id]; return value;
        })} />
        <div><h3>{card.title}</h3><span className={`${styles.badge} ${statusClassNames[card.status]}${card.archived ? ` ${styles.archived}` : ""}`}>{card.kind === "note" ? "研究成果" : "研究问题"} · {statusNames[card.status]}{card.archived ? " · 已归档" : ""}</span></div>
      </div>
      <div className={styles.body}><MarkdownBody cwd={project.root}>{card.content}</MarkdownBody></div>
      <p className={styles.meta}>保存于 {new Date(card.createdAt).toLocaleString()} · 更新于 {new Date(card.updatedAt).toLocaleString()}</p>
      {card.origin && <details className={styles.details}><summary>原回答摘录与出处</summary><div className={styles.selection}><MarkdownBody cwd={project.root}>{card.origin.excerpt}</MarkdownBody></div><button className={styles.sourceLink} type="button" onClick={() => openSource(card)}>回到原回答并高亮摘录</button>{card.origin.messageTimestamp && <p className={styles.meta}>原回答时间：{new Date(card.origin.messageTimestamp).toLocaleString()}</p>}</details>}
      {card.relatedCardIds.length > 0 && <p className={styles.meta}>关联研究：{card.relatedCardIds.map((id) => cards.find((item) => item.id === id)?.title ?? "历史卡片").join("、")}</p>}
      {card.frameworkItems.length > 0 && <p className={styles.meta}>关联框架：{card.frameworkItems.map((item) => item.available ? `${item.kind ? frameworkKindNames[item.kind] : "框架条目"} · ${item.subject}` : `${item.id}（最新框架中已移除）`).join("、")}</p>}
      <details className={styles.details}><summary>资料入口 · {card.evidence.length} 项</summary>
        <p className={styles.meta}>来自原回答或关联卡片，请核对是否支持本条结论。</p>
        <div className={styles.evidence}>{card.evidence.map((entry) => entry.available ? <PeSourceCitation key={entry.id} cwd={project.root} evidenceId={entry.id}>{entry.citation || "原始资料"}</PeSourceCitation> : <span key={entry.id}>一项原始引用暂不可定位，需重新核实</span>)}</div>
        {!card.evidence.length && <p className={styles.meta}>尚未关联原始证据。</p>}
      </details>
      <div className={styles.actions}>
        {!card.archived && <><button type="button" disabled={busy} onClick={() => void action(() => update(card, { status: card.kind === "note" ? card.status === "confirmed" ? "unverified" : "confirmed" : card.status === "resolved" ? "open" : "resolved" }))}>{card.kind === "note" ? card.status === "confirmed" ? "改为待核实" : "标记已人工确认" : card.status === "resolved" ? "重新打开问题" : "标记已解决"}</button>
          <button type="button" disabled={busy} onClick={() => { setAdding(false); setEditing(card); setTitle(card.title); setContent(card.content); setFrameworkItemIds(card.frameworkItemIds); }}>编辑</button></>}
        <button type="button" disabled={busy} onClick={() => void action(() => update(card, { archived: !card.archived }))}>{card.archived ? "恢复卡片" : "归档"}</button>
        <button type="button" disabled={busy} onClick={() => historyCardId === card.id ? setHistoryCardId(null) : void loadHistory(card.id)}>{historyCardId === card.id ? "收起版本历史" : "版本历史"}</button>
      </div>
      {historyCardId === card.id && <section className={styles.history} aria-label={`${card.title}的版本历史`}>
        <div className={styles.historyHeader}><strong>版本历史</strong><span className={styles.meta}>恢复旧版本会复制当时的标题、内容和框架关联，创建新版本并重新进入待核实／待研究；不会删除后续记录或改变归档状态。</span></div>
        {historyLoading && <p role="status">正在读取版本历史…</p>}
        {!historyLoading && revisions.map((entry, index) => {
          const newer = revisions[index - 1]?.card;
          const changes = newer ? researchCardRevisionChanges(entry.card, newer) : [];
          return <details key={entry.revision} open={entry.current} className={styles.revision}>
            <summary><strong>v{entry.revision}{entry.current ? " · 当前" : ""}</strong><span>{new Date(entry.card.updatedAt).toLocaleString()}</span></summary>
            <p className={styles.meta}>{newer ? changes.length ? `此版本之后修改了：${changes.join("、")}` : "此版本之后没有可见字段变化。" : "当前版本"}</p>
            <p><span className={`${styles.badge} ${statusClassNames[entry.card.status]}`}>{statusNames[entry.card.status]}{entry.card.archived ? " · 已归档" : ""}</span></p>
            {entry.card.title !== card.title && <p><strong>标题：</strong>{entry.card.title}</p>}
            <div className={styles.revisionContent}><MarkdownBody cwd={project.root}>{entry.card.content}</MarkdownBody></div>
            {!entry.current && <button type="button" disabled={busy} onClick={() => void action(() => restoreRevision(card, entry.revision))}>恢复此版本</button>}
          </details>;
        })}
      </section>}
    </article>)}
    {selection.length > 0 && <div className={styles.continue}>
      <strong>已选择 {selection.length} 项研究背景</strong>
      <p className={styles.meta}>{selection.map((item) => cards.find((card) => card.id === item.id)?.title || "已失效卡片").join("、")}</p>
      {staleSelection && <p role="alert">部分卡片已变化，请取消选择后重新勾选。</p>}
      <label>本次继续研究的问题<textarea aria-label="本次继续研究的问题" maxLength={8000} rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || staleSelection || agentUnavailable || !question.trim()} onClick={() => void action(continueResearch)}>{busy ? "处理中…" : "新会话继续研究"}</button><button type="button" disabled={busy} onClick={() => setSelected({})}>清空选择</button></div>
      {agentUnavailable && <p className={styles.meta}>请先选择可用模型并启用研究工具。</p>}
    </div>}
  </div>;
}
