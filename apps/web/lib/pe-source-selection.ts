import type { PeSourceScope } from "@earendil-works/pe-boot";
import type { PeProjectDocumentSummary } from "./pe-project-types";

export function sourceSelectionKey(document: { docId?: string; versionNo?: number; rawRelativePath?: string | null; filename?: string }): string {
  return JSON.stringify([document.docId ?? "pending:" + (document.rawRelativePath ?? document.filename), document.versionNo ?? 1]);
}

export function isSelectableSource(document: PeProjectDocumentSummary): boolean {
  return document.isCurrent !== false;
}

export function selectedSourceScope(datasetId: string, documents: PeProjectDocumentSummary[], keys?: string[]): PeSourceScope {
  return {
    datasetId,
    documents: documents.filter((document) => isSelectableSource(document)
      && (keys === undefined || keys.includes(sourceSelectionKey(document)))).map((document) => ({
      docId: document.docId ?? "pending:" + (document.rawRelativePath ?? document.filename), versionNo: document.versionNo ?? 1, filename: document.filename,
    })),
  };
}

/** Stored with the user message so the original turn's scope remains inspectable. */
export function sourceScopeMessage(message: string, scope?: PeSourceScope): string {
  if (!scope) return message;
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return message + "\n\n<details>\n<summary>使用 " + scope.documents.length + " 份资料</summary>\n\n"
    + (scope.documents.length ? scope.documents.map((document) =>
      escape(document.filename) + " · v" + document.versionNo).join("<br>\n") : "未选择资料：本次不使用项目来源检索。")
    + "\n\n</details>";
}
