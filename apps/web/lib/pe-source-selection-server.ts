import type { PeSourceScope } from "@earendil-works/pe-boot";
import { getPeProject } from "./pe-project-store";
import { listPeProjectDocuments } from "./pe-project-documents";
import { samePath } from "./paths";
import { isSelectableSource, sourceSelectionKey } from "./pe-source-selection";

export function validateSourceSelection(
  cwd: string, value: unknown, options: { agentDir?: string; projectsRoot?: string } = {},
): PeSourceScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid source selection");
  const candidate = value as Partial<PeSourceScope>;
  if (typeof candidate.datasetId !== "string" || !Array.isArray(candidate.documents) || candidate.documents.length > 500)
    throw new Error("Invalid source selection");
  const project = getPeProject(candidate.datasetId, options);
  if (!samePath(project.root, cwd)) throw new Error("资料选择与当前项目不一致，请重新选择");
  const available = listPeProjectDocuments(candidate.datasetId, options).documents.filter(isSelectableSource);
  const seen = new Set<string>();
  return {
    datasetId: candidate.datasetId,
    documents: candidate.documents.map((requested) => {
      if (!requested || typeof requested.docId !== "string" || !Number.isSafeInteger(requested.versionNo))
        throw new Error("Invalid source version");
      const key = sourceSelectionKey(requested);
      const document = available.find((item) => sourceSelectionKey(item) === key);
      if (!document || seen.has(key)) throw new Error("所选资料已更新或不可用，请刷新来源后重新发送");
      seen.add(key);
      return { docId: requested.docId, versionNo: document.versionNo ?? 1, filename: document.filename };
    }),
  };
}
