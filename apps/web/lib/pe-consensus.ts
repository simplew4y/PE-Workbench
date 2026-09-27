// 只复用 SDK 类型；浏览器不得导入 SQLite、文件系统或另一套共识计算实现。
import type { listPeConsensusCards } from "@earendil-works/pe-boot";

export type PeConsensusResult = ReturnType<typeof listPeConsensusCards>;
export type PeConsensusCardData = PeConsensusResult["cards"][number];

export function consensusRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function consensusText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export async function fetchPeConsensusCards(datasetId: string, signal?: AbortSignal): Promise<PeConsensusResult | null> {
  const query = new URLSearchParams({ datasetId, limit: "50", include_sources: "true" });
  const response = await fetch("/api/pe/consensus?" + query, { signal, cache: "no-store" });
  const payload = consensusRecord(await response.json());
  // 只有明确关闭才隐藏入口；项目丢失、读取失败等错误不能被当作关闭而吞掉。
  if (response.status === 404 && payload.error === "Consensus feature is disabled") return null;
  if (!response.ok) throw new Error(consensusText(payload.error) || "Unable to load project consensus");
  if (payload.dataset_id !== datasetId || !Array.isArray(payload.cards) || typeof payload.status !== "string") {
    throw new Error("Invalid project consensus response");
  }
  return payload as PeConsensusResult;
}
