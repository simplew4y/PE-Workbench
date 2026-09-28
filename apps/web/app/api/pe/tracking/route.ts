import { after, NextResponse } from "next/server";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  addSimulatedTrade, getPeExcelRange, getStockTracking, locatePeValuationOutputs,
  PeSourceError, preparePeDocument, refreshStockTracker, ResearchError,
  resolvePeValuationDate, saveStockTrackerWithSources,
} from "@earendil-works/pe-boot";
import { getPeProject } from "@/lib/pe-project-store";
import { listPeProjectDocuments } from "@/lib/pe-project-documents";
import { assertPeUserPathAllowed } from "@/lib/pe-multi-user-paths";
import { peStorageErrorResponse } from "@/lib/pe-storage-errors";
import { ensureResearchMonitorWorker } from "@/lib/research-monitor-worker";
import { getStockTrackingRun, startStockTrackingRun } from "@/lib/stock-tracking-run";
import { getPePlatformRpcOptions } from "@/lib/pe-platform-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new ResearchError(400, `${name} is required`);
  return value.trim();
}

function searchOffset(value: string | null, name: string): number {
  if (value === null) return 0;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ResearchError(400, `${name} must be a non-negative integer`);
  }
  return Number(value);
}

function projectFor(value: unknown) {
  const project = getPeProject(text(value, "datasetId"));
  assertPeUserPathAllowed(project.root);
  return project;
}

function failure(error: unknown): Response {
  if (error instanceof ResearchError || error instanceof PeSourceError) return NextResponse.json({ error: error.message }, { status: error.status });
  const storage = peStorageErrorResponse(error);
  if (storage) return storage;
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  if (error instanceof Error && error.message.startsWith("Project not found:")) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  console.error("Stock tracking request failed", error);
  return NextResponse.json({ error: "无法读取股票追踪，请检查项目和数据状态。" }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const { root, datasetId } = projectFor(params.get("datasetId"));
    const docId = params.get("docId");
    if (docId !== null) {
      const id = text(docId, "docId");
      if (params.has("cell") || params.has("sheet")) {
        const sheetName = text(params.get("sheet"), "sheet");
        const cellRange = text(params.get("cell"), "cell");
        await preparePeDocument(root, { docId: id, datasetId }, request.signal);
        return NextResponse.json({ range: getPeExcelRange(root, {
          docId: id, datasetId, sheetName, cellRange, maxCells: 1,
        }, request.signal) });
      }
      const query = params.has("query") ? text(params.get("query"), "query") : undefined;
      const dateQuery = params.has("dateQuery") ? text(params.get("dateQuery"), "dateQuery") : undefined;
      if (!query && !dateQuery) throw new ResearchError(400, "query or dateQuery is required for workbook source search");
      const offset = searchOffset(params.get("offset"), "offset");
      const dateOffset = searchOffset(params.get("dateOffset"), "dateOffset");
      await preparePeDocument(root, { docId: id, datasetId }, request.signal);
      const valuation = query ? locatePeValuationOutputs(root, {
        docId: id, datasetId, query, offset,
      }, request.signal) : null;
      const dates = dateQuery ? resolvePeValuationDate(root, {
        docId: id, datasetId, query: dateQuery, offset: dateOffset,
      }, request.signal) : null;
      return NextResponse.json({ valuation, dates });
    }
    const state = getStockTracking(root, datasetId, params.get("trackerId") ?? undefined);
    if (params.get("download") === "csv") {
      if (!state.selected) throw new ResearchError(404, "Stock tracker not found");
      const tracker = state.selected;
      const prices = new Map(tracker.observations.map((row) => [row.date, row]));
      const models = new Map([...tracker.valuations].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt)).map((value) => [value.effectiveDate, value]));
      const estimates = new Map((tracker.config.valuationEstimates ?? []).map((value) => [value.date, value]));
      const dates = [...new Set([...prices.keys(), ...models.keys(), ...estimates.keys()])].sort().reverse();
      const rows: Array<Array<string | number | null | undefined>> = [[
        "名称", "股票代码", "交易日", "收盘价", "币种", "悲观目标价", "基准目标价", "乐观目标价",
        "模拟持仓股数", "持仓均价", "浮盈亏", "浮动收益率%", "已实现盈亏", "现金分红", "累计盈亏",
        "至基准空间%", "行情来源", "估值版本", "估值目标日期", "AI当日估值", "AI估值依据", "AI估值来源",
      ], ...dates.map((date) => {
        const row = prices.get(date);
        const model = models.get(date) ?? tracker.valuations.find((version) => version.id === row?.valuationId);
        const estimate = estimates.get(date);
        const position = row?.position;
        return [
          tracker.config.name, tracker.config.code, date, row?.close, tracker.config.currency,
          model?.bear ?? row?.bear, model?.base ?? row?.base, model?.bull ?? row?.bull,
          position?.quantity, position?.quantity ? position.averageCost : null, position?.unrealizedPnl,
          position && position.cost > 0 && position.unrealizedPnl !== null ? position.unrealizedPnl / position.cost * 100 : null,
          position?.realizedPnl, position?.dividends, position?.totalPnl, row?.upsidePercent,
          row?.evidenceId, model?.id, model?.targetDate, estimate?.price, estimate?.basis.summary, estimate?.basis.evidenceIds.join("; "),
        ];
      })];
      const csv = rows.map((row) => row.map((value) => {
        const string = value == null ? "" : String(value);
        const safe = typeof value === "string" && /^[\s]*[=+@-]/u.test(string) ? `'${string}` : string;
        return `"${safe.replaceAll('"', '""')}"`;
      }).join(",")).join("\r\n");
      return new Response(`\uFEFF${csv}\r\n`, { headers: {
        "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="stock-tracking.csv"', "Cache-Control": "no-store",
      } });
    }
    const workerOnline = await lockfile.check(join(root, "meta/collection.sqlite3"), { lockfilePath: join(root, "meta/research-worker.lock"), stale: 30_000 });
    return NextResponse.json({ ...state, run: getStockTrackingRun(root), workerOnline, documents: listPeProjectDocuments(datasetId).documents.filter((doc) =>
      ["xlsx", "xlsm"].includes(doc.fileType) && doc.isCurrent !== false && doc.docId,
    ) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError(400, "Invalid request");
    const input = body as Record<string, unknown>;
    const project = projectFor(input.datasetId);
    const { root, datasetId } = project;
    switch (input.action) {
      case "run": {
        const trackerId = input.trackerId === undefined ? undefined : text(input.trackerId, "trackerId");
        let model: { provider: string; modelId: string } | undefined;
        if (input.model !== undefined) {
          if (!input.model || typeof input.model !== "object" || Array.isArray(input.model)) throw new ResearchError(400, "Invalid model");
          const selected = input.model as Record<string, unknown>;
          model = { provider: text(selected.provider, "provider"), modelId: text(selected.modelId, "modelId") };
        }
        const options = await getPePlatformRpcOptions();
        const job = startStockTrackingRun(project, trackerId, { ...options, ...(model ? { initialModel: model } : {}) });
        after(() => job.completion);
        return NextResponse.json({ run: job.run }, { status: 202 });
      }
      case "save": {
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new ResearchError(400, "Invalid revision");
        const selected = await saveStockTrackerWithSources(root, datasetId, input.tracker, Number(input.revision), request.signal);
        let workerError: string | undefined;
        try { await ensureResearchMonitorWorker(root, datasetId); }
        catch { workerError = "设置已保存，后台进程未能启动，请重试启用自动更新。"; }
        return NextResponse.json({ selected, ...(workerError ? { workerError } : {}) });
      }
      case "trade":
        return NextResponse.json({ selected: addSimulatedTrade(root, datasetId, text(input.trackerId, "trackerId"), input.trade) });
      case "refresh":
        return NextResponse.json({ selected: await refreshStockTracker(root, datasetId, text(input.trackerId, "trackerId"), request.signal) });
      default: throw new ResearchError(400, "Unknown tracking action");
    }
  } catch (error) { return failure(error); }
}
