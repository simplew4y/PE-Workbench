"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { useRouter } from "next/navigation";
import type { ResearchCardView, ResearchCardStatus } from "@earendil-works/pe-boot";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { PeSourceCitation } from "./PeSourceCitation";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./PeResearchNotebook.module.css";

const statusNames: Record<ResearchCardStatus, string> = { unverified: "待核实", confirmed: "已人工确认", open: "待研究", resolved: "已解决" };

async function saveCard(datasetId: string, data: Record<string, unknown>) {
  const response = await fetch("/api/pe/research-cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "保存失败，请重试");
  return result.card as ResearchCardView;
}

export function ResearchCardCapture({ project, sessionId, entryId, text, onSaved, children }: {
  project: PeProjectSummary; sessionId: string; entryId: string; text: string; onSaved: () => void; children: ReactNode;
}) {
  const answer = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"note" | "question" | null>(null);
  const [selection, setSelection] = useState<{ text: string; range: Range } | null>(null);
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
      const value = selected.toString().trim();
      if (!value) { setSelection(null); return; }
      setSelection({ text: value, range: selected.getRangeAt(0).cloneRange() });
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
        source: { sessionId, entryId, excerpt, format: "rendered" }, relatedCardIds: [] };
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
  return <div>
    <div ref={answer}>{children}</div>
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
        <p className={styles.meta}>仅保存这段选中文字，保留来源会话和原回答资料入口。</p>
        <div className={styles.actions}><button className={styles.primary} disabled={busy || !title.trim() || !excerpt.trim()}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={close}>取消</button></div>
      </form>}
            {error && <p role="alert" className={styles.error}>{error}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}

export function PeResearchNotebook({ project, refreshKey, onOpenFramework, onSessionCreated, model, toolNames, agentUnavailable = false }: {
  project: PeProjectSummary; refreshKey: number; onOpenFramework: () => void; onSessionCreated?: (id: string) => void;
  model?: { provider: string; modelId: string }; toolNames?: string[]; agentUnavailable?: boolean;
}) {
  const router = useRouter();
  const [cards, setCards] = useState<ResearchCardView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<ResearchCardView | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [question, setQuestion] = useState("请基于选中的研究记录继续分析，先列出已知判断、待验证假设和未解决问题，再核对本项目原始资料。");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
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
  async function update(card: ResearchCardView, changes: Partial<Pick<ResearchCardView, "title" | "content" | "status" | "archived">>) {
    const next = await saveCard(project.datasetId, { action: "update", id: card.id, revision: card.revision,
      title: card.title, content: card.content, status: card.status, archived: card.archived, ...changes });
    setCards((current) => current.map((item) => item.id === next.id ? next : item));
    setSelected((current) => { const value = { ...current }; delete value[card.id]; return value; });
    setNotice("已保存");
  }
  const active = cards.filter((card) => !card.archived);
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
    <div className={styles.actions}>
      <button type="button" onClick={onOpenFramework}>查看投资框架</button>
      <button type="button" disabled={busy} onClick={() => { setAdding(true); setEditing(null); setTitle(""); setContent(""); }}>新增研究问题</button>
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>刷新</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert" className={styles.error}>{error}<button type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {(adding || editing) && <form className={styles.form} onSubmit={(event) => {
      event.preventDefault(); void action(async () => {
        if (editing) await update(editing, { title, content, status: editing.kind === "note" ? "unverified" : "open" });
        else {
          const data = { action: "create", kind: "question", title, content: content || title, relatedCardIds: selection.map((item) => item.id) };
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
      <p className={styles.meta}>{editing ? "修改内容后需要重新核实，原回答摘录和来源仍会保留。" : `将关联当前勾选的 ${selection.length} 张卡片及其资料入口。`}</p>
      <div className={styles.actions}><button className={styles.primary} disabled={busy || !title.trim() || (adding && staleSelection)}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={() => { setAdding(false); setEditing(null); }}>取消</button></div>
    </form>}
    <input className={styles.search} aria-label="搜索研究积累" placeholder="搜索标题或研究内容" value={query} onChange={(event) => setQuery(event.target.value)} />
    <select className={styles.filter} aria-label="筛选研究卡片" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="active">全部研究积累</option><option value="note">研究成果</option><option value="question">研究问题</option><option value="open">待研究</option><option value="unverified">待核实</option><option value="confirmed">已人工确认</option><option value="resolved">已解决</option><option value="archived">已归档</option>
    </select>
    {!loaded && !error && <p role="status">正在读取研究积累…</p>}
    {loaded && visible.length === 0 && <p className={styles.empty}>{cards.length ? "没有符合条件的卡片。" : "选中回答中的文字，在浮层中保存研究成果，或先记录一个想继续研究的问题。"}</p>}
    {visible.map((card) => <article className={styles.card} key={card.id}>
      <div className={styles.cardHeader}>
        <input type="checkbox" aria-label={`选择：${card.title}`} checked={selected[card.id] !== undefined} disabled={busy || card.archived || (selection.length >= 20 && selected[card.id] === undefined)} onChange={(event) => setSelected((current) => {
          const value = { ...current }; if (event.target.checked) value[card.id] = card.revision; else delete value[card.id]; return value;
        })} />
        <div><h3>{card.title}</h3><span className={`${styles.badge} ${card.status === "confirmed" ? styles.confirmed : ""}`}>{card.kind === "note" ? "研究成果" : "研究问题"} · {statusNames[card.status]}{card.archived ? " · 已归档" : ""}</span></div>
      </div>
      <div className={styles.body}><MarkdownBody cwd={project.root}>{card.content}</MarkdownBody></div>
      <p className={styles.meta}>保存于 {new Date(card.createdAt).toLocaleString()} · 更新于 {new Date(card.updatedAt).toLocaleString()}</p>
      {card.origin && <details className={styles.details}><summary>原回答摘录与出处</summary><div className={styles.selection}><MarkdownBody cwd={project.root}>{card.origin.excerpt}</MarkdownBody></div><a className={styles.link} href={`?session=${encodeURIComponent(card.origin.sessionId)}`}>回到来源会话</a>{card.origin.messageTimestamp && <p className={styles.meta}>原回答时间：{new Date(card.origin.messageTimestamp).toLocaleString()}</p>}</details>}
      {card.relatedCardIds.length > 0 && <p className={styles.meta}>关联研究：{card.relatedCardIds.map((id) => cards.find((item) => item.id === id)?.title ?? "历史卡片").join("、")}</p>}
      <details className={styles.details}><summary>资料入口 · {card.evidence.length} 项</summary>
        <p className={styles.meta}>来自原回答或关联卡片，请核对是否支持本条结论。</p>
        <div className={styles.evidence}>{card.evidence.map((entry) => entry.available ? <PeSourceCitation key={entry.id} cwd={project.root} evidenceId={entry.id}>{entry.citation || "原始资料"}</PeSourceCitation> : <span key={entry.id}>一项原始引用暂不可定位，需重新核实</span>)}</div>
        {!card.evidence.length && <p className={styles.meta}>尚未关联原始证据。</p>}
      </details>
      <div className={styles.actions}>
        {!card.archived && <><button type="button" disabled={busy} onClick={() => void action(() => update(card, { status: card.kind === "note" ? card.status === "confirmed" ? "unverified" : "confirmed" : card.status === "resolved" ? "open" : "resolved" }))}>{card.kind === "note" ? card.status === "confirmed" ? "改为待核实" : "标记已人工确认" : card.status === "resolved" ? "重新打开问题" : "标记已解决"}</button>
          <button type="button" disabled={busy} onClick={() => { setAdding(false); setEditing(card); setTitle(card.title); setContent(card.content); }}>编辑</button></>}
        <button type="button" disabled={busy} onClick={() => void action(() => update(card, { archived: !card.archived }))}>{card.archived ? "恢复卡片" : "归档"}</button>
      </div>
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
