export interface RunSummary {
  id: string;
  status: string;
  createdAt: string;
}

export interface IterationHistoryPage<Run extends RunSummary> {
  runs: Run[];
  nextCursor: string | null;
}

export interface IterationHistory<Run extends RunSummary> extends IterationHistoryPage<Run> {
  datasetId: string;
  paged: boolean;
}

export function mergeIterationHistory<Run extends RunSummary>(
  current: IterationHistory<Run> | null,
  datasetId: string,
  page: IterationHistoryPage<Run>,
  kind: "snapshot" | "older",
): IterationHistory<Run> | null {
  if (kind === "older" && current?.datasetId !== datasetId) return current;
  const previous = current?.datasetId === datasetId ? current : null;
  const runs = new Map((previous?.runs ?? []).map(run => [run.id, run]));
  for (const run of page.runs) {
    if (kind === "snapshot" || !runs.has(run.id)) runs.set(run.id, run);
  }
  return {
    datasetId,
    runs: [...runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    nextCursor: kind === "snapshot" && previous?.paged ? previous.nextCursor : page.nextCursor,
    paged: kind === "older" || !!previous?.paged,
  };
}

export function defaultIterationRun(runs: readonly RunSummary[]): string {
  const ordered = [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return ordered.find((run) => ["review_required", "running", "queued"].includes(run.status))?.id
    ?? ordered[0]?.id ?? "";
}

export function iterationNextStep(status: string | undefined): { title: string; detail: string } {
  switch (status) {
    case "queued": case "running": return { title: "查看本轮进度", detail: "系统正在取证和分析；完成后在本轮更新中核查变化。" };
    case "review_required": return { title: "审查本轮修改", detail: "逐项核查原因与来源，确认实际采用的内容后发布。" };
    case "blocked": case "failed": return { title: "处理异常并恢复", detail: "先查看异常原因；处理后可从有效检查点恢复，不必重复上传。" };
    case "published": return { title: "查看发布结果", detail: "新框架已保存。查看实际采用内容，或基于当前版本准备下一轮。" };
    case "no_change": return { title: "核查无变化依据", detail: "本轮未发布新版本；请核查覆盖范围和剩余缺口，不等于没有风险。" };
    case "rejected": case "cancelled": return { title: "查看本轮记录", detail: "原有效框架保持不变，本轮证据与记录仍可追溯。" };
    default: return { title: "准备第一轮更新", detail: "选择新增资料或信息源，基于已确认的框架开始取证。" };
  }
}

export function createIterationLoader<Value>() {
  let current: { key: string; controller: AbortController; promise: Promise<void> } | undefined;
  function invalidate() {
    current?.controller.abort();
    current = undefined;
  }
  return {
    invalidate,
    load(key: string, read: (signal: AbortSignal) => Promise<Value>, apply: (value: Value) => void, fail: (error: unknown) => void): Promise<void> {
      if (current?.key === key) return current.promise;
      invalidate();
      const controller = new AbortController();
      const pending = { key, controller, promise: Promise.resolve() };
      current = pending;
      pending.promise = Promise.resolve().then(() => read(controller.signal)).then((value) => {
        if (current === pending && !controller.signal.aborted) apply(value);
      }).catch((error: unknown) => {
        if (current === pending && !controller.signal.aborted) fail(error);
      }).finally(() => {
        if (current === pending) current = undefined;
      });
      return pending.promise;
    },
  };
}

export function createIterationSubmission<Payload>() {
  let pending: { requestId: string; payload: Payload } | null = null;
  return {
    prepare(create: (requestId: string) => Payload) {
      if (!pending) {
        const requestId = crypto.randomUUID();
        pending = { requestId, payload: create(requestId) };
      }
      return pending;
    },
    clear() { pending = null; },
  };
}
