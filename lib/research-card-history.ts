import type { ResearchCard } from "@earendil-works/pe-boot";

export function researchCardRevisionChanges(older: ResearchCard, newer: ResearchCard): string[] {
  const changes: string[] = [];
  if (older.title !== newer.title) changes.push("标题");
  if (older.content !== newer.content) changes.push("内容");
  if (older.status !== newer.status) changes.push("状态");
  if (older.archived !== newer.archived) changes.push("归档状态");
  if (JSON.stringify(older.frameworkItemIds) !== JSON.stringify(newer.frameworkItemIds)) changes.push("框架关联");
  return changes;
}
