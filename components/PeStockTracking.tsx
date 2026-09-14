"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, Plus, RefreshCw, Sparkles } from "lucide-react";
import type { SimulatedTradeInput, StockTrackerDetail, StockTrackingState, TrackingObservation, TrackingValuation, TrackingValuationEstimate } from "@earendil-works/pe-boot";
import type { PeProjectSummary } from "@/lib/pe-project-types";
import { stockTrackingChart, modelHistory, latestMarketPoint, trackingMarketDate as marketDate } from "@/lib/stock-tracking-chart";
import { EChart } from "./visualization/EChart";
export { latestMarketPoint } from "@/lib/stock-tracking-chart";
import { PeSourceCitation } from "./PeSourceCitation";
import styles from "./PeStockTracking.module.css";

type TrackingRun = { id: string; status: "running" | "completed" | "error"; stage: string; error?: string; trackerId?: string };
type TrackingResponse = StockTrackingState & { workerOnline?: boolean; run?: TrackingRun | null };
const format = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${format(value)}%`;
const tone = (value: number | null | undefined) => value == null || value === 0 ? "" : value > 0 ? styles.positive : styles.negative;
const tradeLabels = { buy: "模拟买入", sell: "模拟卖出", dividend: "现金分红", split: "拆股 / 合股" };
function timestamp(value: string | null | undefined) { if (!value) return "待更新"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value; }

export function TrackingRunButton({ existing, busy, unavailable, stage, onRun }: { existing: boolean; busy: boolean; unavailable: boolean; stage?: string; onRun: () => void }) {
  return <button type="button" className={styles.primary} disabled={busy || unavailable} onClick={onRun} aria-label={busy ? stage || "正在更新追踪" : existing ? "更新追踪" : "建立追踪"}>{existing ? <RefreshCw size={14} className={busy ? styles.spinning : undefined} /> : <Sparkles size={15} />}{busy ? "处理中…" : existing ? "更新" : "建立追踪"}</button>;
}

export function targetUpside(tracker: StockTrackerDetail | null | undefined, price: number | null | undefined) {
  return tracker?.valuationStatus === "valid" && tracker.valuation && price ? (tracker.valuation.base / price - 1) * 100 : null;
}

export function TradeForm({ busy, currency, code, startDate, onSave, onCancel }: { busy: boolean; currency: string; code: string; startDate?: string; onSave: (trade: SimulatedTradeInput) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<SimulatedTradeInput["kind"]>("buy");
  const request = useRef({ body: "", id: "" });
  return <form className={styles.form} onSubmit={(event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const number = (key: string) => Number(data.get(key));
    const trade = { date: String(data.get("date")), kind, note: String(data.get("note") ?? ""), ...(kind === "buy" || kind === "sell" ? { quantity: number("quantity"), price: number("price"), fee: number("fee") } : kind === "dividend" ? { amount: number("amount") } : { ratio: number("ratio") }) };
    const body = JSON.stringify(trade);
    if (request.current.body !== body) request.current = { body, id: crypto.randomUUID() };
    void onSave({ ...trade, requestId: request.current.id });
  }}><fieldset disabled={busy}><legend>记录模拟交易</legend><div className={styles.actions} role="group" aria-label="交易类型">{Object.entries(tradeLabels).map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} className={kind === value ? styles.primary : undefined} onClick={() => setKind(value as SimulatedTradeInput["kind"])}>{label}</button>)}</div><div className={styles.grid}>
    <label>交易日期<input name="date" type="date" required min={startDate} max={marketDate(code)} defaultValue={marketDate(code)} /></label>
    {(kind === "buy" || kind === "sell") && <><label>模拟成交价 · {currency}<input name="price" type="number" required min="0.000001" step="any" /></label><label>数量 · 股<input name="quantity" type="number" required min="0.000001" step="any" /></label></>}
    {kind === "dividend" && <label>收到现金总额 · {currency}<input name="amount" type="number" required min="0.000001" step="any" /></label>}
    {kind === "split" && <label>新股数 ÷ 原股数<input name="ratio" type="number" required min="0.000001" step="any" placeholder="例如：1 拆 2 填 2" /></label>}
  </div><p className={styles.hint}>可补录历史模拟交易，日期按股票市场当地日期记录。</p><details className={styles.tradeOptions}><summary>可选信息 · 手续费、备注</summary>{(kind === "buy" || kind === "sell") && <label>交易手续费 · {currency}（可选）<input name="fee" type="number" min="0" step="any" placeholder="0" /><span className={styles.hint}>这笔交易的佣金等额外成本，留空按 0 计算。</span></label>}<label>判断 / 备注（可选）<textarea name="note" rows={2} maxLength={1000} placeholder="记录本次模拟操作的依据" /></label></details><div className={styles.actions}><button type="submit" className={styles.primary}>{busy ? "保存中…" : `保存${tradeLabels[kind]}`}</button><button type="button" onClick={onCancel}>取消</button></div></fieldset></form>;
}

export function PositionSummary({ tracker, busy, onTrade, onSaveThresholds }: { tracker: StockTrackerDetail; busy: boolean; onTrade: () => void; onSaveThresholds: (settings: StockTrackerDetail["pnlAlertThresholds"]) => Promise<void> }) {
  const { position, pnlAlert, pnlAlertThresholds: thresholds } = tracker;
  return <section className={styles.position} aria-label="模拟持仓盈亏">
    <div className={styles.sectionHeading}><h3>模拟持仓 · {format(position.quantity, 6)} 股</h3><button type="button" disabled={busy} onClick={onTrade}><Plus size={14} />记录模拟交易</button></div>
    {pnlAlert && <div className={`${styles.notice} ${styles.pnlAlert} ${pnlAlert === "loss" ? styles.lossAlert : styles.profitAlert}`} role="alert"><AlertTriangle size={17} /><div><strong>{pnlAlert === "profit" ? "盈利" : "亏损"}已达到提醒阈值 {format(pnlAlert === "profit" ? thresholds.profitPercent : thresholds.lossPercent)}%</strong><p>当前浮动盈亏 {format(position.unrealizedPnl)} {tracker.config.currency}（{percent(position.unrealizedReturnPercent)}）。</p></div></div>}
    <dl className={`${styles.stats} ${styles.positionStats}`}><div><dt>持仓均价 · {tracker.config.currency}</dt><dd>{position.quantity ? format(position.averageCost) : "—"}<small>成本 {format(position.cost)} · 含买入手续费</small></dd></div><div><dt>浮动盈亏 · {tracker.config.currency}</dt><dd className={tone(position.unrealizedPnl)}>{format(position.unrealizedPnl)}<small>{percent(position.unrealizedReturnPercent)}</small></dd></div><div><dt>累计盈亏 · {tracker.config.currency}</dt><dd className={tone(position.totalPnl)}>{format(position.totalPnl)}<small>含已实现盈亏与分红</small></dd></div></dl>
    <details className={styles.alertSettings}><summary>盈亏提醒 · 盈利 {format(thresholds.profitPercent)}% / 亏损 {format(thresholds.lossPercent)}%</summary>
      <form key={`${thresholds.profitPercent}:${thresholds.lossPercent}`} className={styles.form} onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void onSaveThresholds({ profitPercent: Number(data.get("profitPercent")), lossPercent: Number(data.get("lossPercent")) });
      }}><fieldset disabled={busy}><legend>设置盈亏提醒</legend><div className={styles.grid}><label>盈利达到（%）<input name="profitPercent" type="number" min="0.01" max="10000" step="any" required defaultValue={thresholds.profitPercent} /></label><label>亏损达到（%）<input name="lossPercent" type="number" min="0.01" max="100" step="any" required defaultValue={thresholds.lossPercent} /></label></div><p className={styles.hint}>按当前持仓的浮动盈亏比例提醒；行情更新后重新判断。</p><button type="submit" className={styles.primary}>{busy ? "保存中…" : "保存提醒阈值"}</button></fieldset></form>
    </details>
  </section>;
}

export function TrackingChart({ tracker, running = false, chart = stockTrackingChart(tracker) }: { tracker: StockTrackerDetail; running?: boolean; chart?: ReturnType<typeof stockTrackingChart> }) {
  if (!chart.hasData) return <p className={styles.hint} role="status">{running ? "读取估值与行情中…" : "暂无数据"}</p>;
  return <figure className={styles.chart}>
    <div className={styles.chartLayout}>
      <EChart option={chart.option} height={242} ariaLabel={`${tracker.config.code} 原模型目标价、实际股价、模拟买卖点及未来预测区间`} />
      {chart.forecast && <aside className={styles.scenarios} aria-label="未来预测情景"><div className={styles.scenarioHeading}><span>{chart.forecast.targetDate}</span><span>较市价</span></div>{([['bull', '乐观'], ['base', '基准'], ['bear', '悲观']] as const).map(([key, label]) => <div key={key} className={styles[key]}><span>{label}</span><strong>{format(chart.forecast![key])}</strong><small>{chart.quote ? percent((chart.forecast![key] / chart.quote.close - 1) * 100) : "—"}</small></div>)}</aside>}
    </div>
    <figcaption className={styles.legend}>{chart.models.length > 0 && <span><i className={styles.targetKey} />原模型</span>}{chart.estimates.length > 0 && <span><i className={styles.estimateKey} />AI 当日估值</span>}{chart.quote && <span><i className={styles.historyKey} />实际股价 · Wind</span>}{chart.trades.some((trade) => trade.kind === "buy") && <span><i className={styles.buyKey} />模拟买入</span>}{chart.trades.some((trade) => trade.kind === "sell") && <span><i className={styles.sellKey} />模拟卖出</span>}{chart.forecast && <span><i className={styles.forecastKey} />未来预测</span>}</figcaption>
  </figure>;
}

export function TrackingTable({ observations, valuations, estimates = [], cwd }: { observations: TrackingObservation[]; valuations: TrackingValuation[]; estimates?: TrackingValuationEstimate[]; cwd: string }) {
  const prices = new Map(observations.map((value) => [value.date, value]));
  const targets = new Map(modelHistory(valuations).map((value) => [value.effectiveDate, value]));
  const ai = new Map(estimates.map((value) => [value.date, value]));
  const dates = [...new Set([...prices.keys(), ...targets.keys(), ...ai.keys()])].sort().reverse();
  return <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="价格与盈亏历史，可横向滚动"><table className={styles.table}><thead><tr>{["日期", "原模型", "AI 当日估值", "市场价格", "持仓股数", "浮动盈亏", "来源"].map((heading) => <th scope="col" key={heading}>{heading}</th>)}</tr></thead><tbody>{dates.map((date) => {
    const row = prices.get(date);
    const estimate = ai.get(date);
    const version = targets.get(date) ?? valuations.find((item) => item.id === row?.valuationId);
    return <tr key={date}><td><time>{date}</time></td><td>{format(version?.base ?? (row?.valuationId ? row.base : null))}</td><td className={styles.estimateValue}>{format(estimate?.price)}{estimate && !estimate.generatedAt && <small> 待更新</small>}</td><td>{format(row?.close)}</td><td>{format(row?.position?.quantity)}</td><td className={tone(row?.position?.unrealizedPnl)}>{row?.position?.quantity ? <>{format(row.position.unrealizedPnl)}<small className={styles.pnlPercent}>{percent(row.position.unrealizedReturnPercent)}</small></> : "—"}</td><td><div className={styles.sources}>{row?.evidenceId && <PeSourceCitation cwd={cwd} evidenceId={row.evidenceId}>行情</PeSourceCitation>}{version?.evidenceId && <PeSourceCitation cwd={cwd} evidenceId={version.evidenceId}>模型</PeSourceCitation>}{estimate && <details><summary>AI</summary><p>{estimate.basis.summary}</p>{estimate.basis.evidenceIds.map((id, index) => <PeSourceCitation key={id} cwd={cwd} evidenceId={id}>资料 {index + 1}</PeSourceCitation>)}</details>}</div></td></tr>;
  })}</tbody></table></div>;
}

export function PeStockTracking({ project, model, agentUnavailable = false, settledKey = "" }: {
  project: PeProjectSummary; model?: { provider: string; modelId: string }; agentUnavailable?: boolean; settledKey?: string;
}) {
  const [loaded, setLoaded] = useState<TrackingResponse | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [editor, setEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const requestGeneration = useRef(0);
  const followRun = useRef<string | null>(null);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const running = loaded?.run?.status === "running";
  useEffect(() => {
    const controller = new AbortController();
    const generation = requestGeneration.current;
    async function load() {
      try {
        const response = await fetch(`/api/pe/tracking?${new URLSearchParams({ datasetId: project.datasetId, ...(selectedId ? { trackerId: selectedId } : {}) })}`, { signal: controller.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法读取股票追踪");
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setLoaded(result); setError("");
          if (followRun.current && result.run?.id === followRun.current && result.run.trackerId) {
            setSelectedId(result.run.trackerId);
            if (result.run.status !== "running") followRun.current = null;
          }
        }
      } catch (cause) { if (!controller.signal.aborted && generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : "读取失败"); }
      finally { if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false); }
    }
    void load(); window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, running ? 2000 : 60000);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [project.datasetId, selectedId, reload, refresh, settledKey, running]);
  const tracker = !selectedId || loaded?.selected?.id === selectedId ? loaded?.selected : null;
  async function mutate(body: Record<string, unknown>) {
    if (inFlight.current || running) return;
    inFlight.current = true; requestGeneration.current++; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/pe/tracking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId: project.datasetId, ...body }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作未完成，请重试");
      if (result.run) { followRun.current = result.run.id; setLoaded((previous) => previous ? { ...previous, run: result.run } : previous); }
      if (result.selected) { setSelectedId(result.selected.id); setLoaded((previous) => previous ? { ...previous, selected: result.selected, trackers: [...previous.trackers.filter((entry) => entry.id !== result.selected.id), result.selected] } : previous); }
      if (body.action === "run" && !body.trackerId) setSelectedId("");
      setEditor(false); setNotice(result.workerError || ""); refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成，请重试"); }
    finally { requestGeneration.current++; inFlight.current = false; setBusy(false); }
  }
  const run = (trackerId?: string) => void mutate({ action: "run", ...(trackerId ? { trackerId } : {}), ...(model ? { model } : {}) });
  const latest = tracker ? latestMarketPoint(tracker) : null;
  const lastPrice = latest?.close;
  const target = tracker?.valuation?.base;
  const chart = tracker ? stockTrackingChart(tracker) : null;
  const statusError = error || loaded?.run?.error || tracker?.error;
  return <div className={styles.tracking} aria-busy={busy || loading || running}>
    {loading && <p className={styles.hint} role="status">读取中…</p>}
    {loaded && <>
      {!tracker && !loaded.trackers.length ? <section className={styles.empty}>
        <div className={styles.emptyIcon}><Sparkles size={24} /></div><h2>股票追踪</h2><p>模型目标价、市场走势与预测区间</p>
        <TrackingRunButton existing={false} busy={busy || running} unavailable={agentUnavailable} stage={loaded.run?.stage} onRun={() => run()} />
      </section> : <>
        <div className={styles.heading}><div><div className={styles.eyebrow}>{tracker ? `${tracker.config.code} · ${tracker.config.currency}` : "股票追踪"}</div><h2>{tracker?.config.name ?? "股票追踪"}</h2></div><div className={styles.actions}>
          {loaded.trackers.length > 1 && <select aria-label="选择跟踪股票" value={selectedId || tracker?.id || ""} disabled={busy || running} onChange={(event) => { setSelectedId(event.target.value); setEditor(false); setLoading(true); }}>{loaded.trackers.map((item) => <option key={item.id} value={item.id}>{item.config.name}</option>)}</select>}
          <TrackingRunButton existing={!!tracker} busy={busy || running} unavailable={agentUnavailable} stage={loaded.run?.stage} onRun={() => run(tracker?.id)} />
        </div></div>
      </>}
      {running && <p className={styles.progress} role="status"><span className={styles.dot} />{loaded.run?.stage || "识别估值模型"}</p>}
      {statusError && <div className={`${styles.notice} ${styles.error}`} role="alert">{statusError}</div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {tracker && <>
        <dl className={styles.stats}><div><dt>原模型目标价</dt><dd>{target == null ? "未提供" : format(target)}<small>{tracker.valuation?.effectiveDate ?? ""}</small></dd></div><div><dt>预测股价</dt><dd className={styles.estimateValue}>{format(chart?.forecast?.base)}<small>{chart?.forecast?.targetDate ?? (running ? "计算中" : "待生成")}</small></dd></div><div><dt>最新市价</dt><dd>{format(lastPrice)}<small>{latest?.asOf ? timestamp(latest.asOf) : latest?.date ?? "待补齐行情"}</small></dd></div></dl>
        <TrackingChart tracker={tracker} running={busy || running} chart={chart!} />
        <PositionSummary tracker={tracker} busy={busy || running} onTrade={() => setEditor(!editor)} onSaveThresholds={(pnlAlertThresholds) => mutate({ action: "save", tracker: { ...tracker.config, pnlAlertThresholds }, revision: tracker.revision })} />
        {editor && <TradeForm key={tracker.id} busy={busy} currency={tracker.config.currency} code={tracker.config.code} startDate={tracker.config.startDate} onSave={(trade) => mutate({ action: "trade", trackerId: tracker.id, trade })} onCancel={() => setEditor(false)} />}
        <div className={styles.sectionHeading}><h3>历史记录</h3><a className={styles.download} href={`/api/pe/tracking?${new URLSearchParams({ datasetId: project.datasetId, trackerId: tracker.id, download: "csv" })}`} download aria-label="下载追踪表 CSV"><Download size={14} />CSV</a></div>
        <TrackingTable observations={tracker.observations} estimates={tracker.config.valuationEstimates} valuations={tracker.config.rule.kind === "target" ? tracker.valuations.filter((value) => value.rule.kind === "target") : tracker.valuations} cwd={project.root} />
        <div className={styles.updated}>{tracker.config.enabled ? loaded.workerOnline === false ? "自动更新离线" : "每日自动更新" : "自动更新已暂停"}<span>{timestamp(tracker.lastCheckedAt)}</span></div>
        <details className={styles.disclosure}><summary>预测依据与模型来源</summary>
          {tracker.config.forecast && <article className={styles.version}><strong>{tracker.forecastNeedsUpdate ? "历史预测 · 待更新" : "预测区间"} · {tracker.config.forecast.targetDate}</strong><p>{tracker.config.forecast.basis.summary}</p><div className={styles.sources}>{tracker.config.forecast.basis.evidenceIds.map((id, index) => <PeSourceCitation key={id} cwd={project.root} evidenceId={id}>资料 {index + 1}</PeSourceCitation>)}</div></article>}
          {tracker.config.basis && <article className={styles.version}><strong>{tracker.config.rule.kind === "market" ? "追踪依据" : "模型目标价"}</strong><p>{tracker.config.basis.summary}</p><div className={styles.sources}>{tracker.config.basis.evidenceIds.map((id, index) => <PeSourceCitation key={id} cwd={project.root} evidenceId={id}>模型 {index + 1}</PeSourceCitation>)}</div></article>}
          {tracker.valuations.map((version) => <div className={styles.sourceRow} key={version.id}><span>{version.effectiveDate}</span><strong>{format(version.base)}</strong>{version.evidenceId && <PeSourceCitation cwd={project.root} evidenceId={version.evidenceId}>来源</PeSourceCitation>}</div>)}
        </details>
        <details className={styles.disclosure}><summary>模拟交易记录 · {tracker.trades.length} 笔</summary>
          {!!tracker.trades.length && <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="模拟交易记录"><table className={styles.table}><thead><tr>{["日期", "操作", "价格", "数量 / 金额", "手续费"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{tracker.trades.map((trade) => <tr key={trade.id}><td>{trade.date}</td><td>{tradeLabels[trade.kind]}</td><td>{format(trade.price)}</td><td>{format(trade.quantity ?? trade.amount ?? trade.ratio, 6)}</td><td>{format(trade.fee)}</td></tr>)}</tbody></table></div>}
        </details>
        <details className={styles.disclosure}><summary>更多</summary><div className={styles.actions}><button type="button" disabled={busy || running || agentUnavailable} onClick={() => run()}>识别其他股票</button><button type="button" disabled={busy || running} onClick={() => void mutate({ action: "refresh", trackerId: tracker.id })}>仅刷新行情</button><button type="button" disabled={busy || running} onClick={() => void mutate({ action: "save", tracker: { ...tracker.config, enabled: !tracker.config.enabled }, revision: tracker.revision })}>{tracker.config.enabled ? "暂停自动更新" : "恢复自动更新"}</button></div></details>
      </>}
    </>}
    {!loaded && error && <div className={`${styles.notice} ${styles.error}`} role="alert">{error}<button type="button" onClick={refresh}>重试</button></div>}
  </div>;
}
