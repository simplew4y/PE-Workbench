"use client";

export function ExecutionFlowLink({ sessionId, turnId, leafId }: { sessionId: string; turnId: string; leafId?: string }) {
  const params = new URLSearchParams({ turn: turnId, ...(leafId ? { leaf: leafId } : {}) });
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/flow?${params}`;
  return (
    <div className="mb-3 flex flex-wrap gap-3 text-xs text-text-muted" aria-label="问答执行记录">
      <a className="hover:underline" href={url} target="_blank" rel="noopener noreferrer">查看执行流程</a>
      <a className="hover:underline" href={`${url}&download=1`}>导出流程 HTML</a>
      <a className="hover:underline" href={`${url}&format=svg&download=1`}>导出流程 SVG</a>
      <a className="hover:underline" href={`${url}&format=json&download=1`}>导出日志 JSON</a>
    </div>
  );
}
