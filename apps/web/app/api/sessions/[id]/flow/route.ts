import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { buildExecutionFlow, renderFlowHtml, renderFlowSvg, type FlowEntry } from "@/lib/execution-flow";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const turn = query.get("turn");
  if (!turn) return Response.json({ error: "请选择一条问题" }, { status: 400 });
  const rpc = getRpcSession(id);
  const live = rpc?.isAlive() ? rpc : undefined;
  const path = live ? null : await resolveSessionPath(id);
  if (!live && !path) return Response.json({ error: "会话不存在" }, { status: 404 });
  try {
    const manager = live?.inner.sessionManager ?? SessionManager.open(path!);
    const leaf = query.get("leaf") || manager.getLeafId();
    if (!leaf) return Response.json({ error: "会话尚无记录" }, { status: 404 });
    const flow = buildExecutionFlow(manager.getEntries() as unknown as FlowEntry[], id, turn, leaf);
    const format = query.get("format") ?? "html";
    if (!["html", "svg", "json"].includes(format)) return Response.json({ error: "不支持的格式" }, { status: 400 });
    const body = format === "svg" ? renderFlowSvg(flow) : format === "json" ? JSON.stringify(flow, null, 2) : renderFlowHtml(flow);
    return new Response(body, { headers: {
      "Content-Type": format === "svg" ? "image/svg+xml; charset=utf-8" : format === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "Content-Disposition": `${query.has("download") ? "attachment" : "inline"}; filename="qa-flow.${format}"`,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "无法读取该问题的流程，请刷新会话后重试" }, { status: 400 });
  }
}
