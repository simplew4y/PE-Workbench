import type { FileViewerState } from "@/lib/file-viewer-state";
import type { SourceTarget, SourceView, Tab } from "./TabBar";

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
  sourceSnapshot?: { view: SourceView; path: string },
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return tabs;
  const tab = tabs[index];
  if ((tab.viewerRevision ?? 0) !== viewerRevision) {
    // FileViewer publishes its final scroll state on unmount, after a view switch.
    // Save it only to the departed view and only if its underlying file is unchanged.
    if (!sourceSnapshot || !tab.source || tab.sourceView === sourceSnapshot.view
      || (sourceSnapshot.view === "original" ? tab.source.originalPath : tab.source.parsedPath) !== sourceSnapshot.path) return tabs;
    const next = [...tabs];
    next[index] = { ...tab, sourceStates: { ...tab.sourceStates, [sourceSnapshot.view]: viewerState } };
    return next;
  }

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

export function sourceTabId(source: SourceTarget): string {
  const identity = source.docId
    ? ["doc", source.docId]
    : ["path", (source.originalPath ?? source.parsedPath ?? source.fileName).replaceAll("\\", "/")];
  return "source:" + JSON.stringify([source.datasetId, identity, source.versionNo ?? null]);
}

function activateSource(tab: Tab, source: SourceTarget, view: SourceView): Tab {
  const path = (view === "original" ? source.originalPath : source.parsedPath) ?? "";
  const states = { ...tab.sourceStates };
  if (tab.sourceView) states[tab.sourceView] = tab.viewerState;
  if (tab.source?.originalPath !== source.originalPath) delete states.original;
  if (tab.source?.parsedPath !== source.parsedPath) delete states.parsed;
  const changed = tab.sourceView !== view || tab.filePath !== path;
  return {
    ...tab,
    source,
    sourceView: view,
    sourceStates: states,
    filePath: path,
    viewerState: changed ? states[view] : tab.viewerState,
    viewerRevision: (tab.viewerRevision ?? 0) + (changed ? 1 : 0),
  };
}

export function openSourceTab(tabs: Tab[], source: SourceTarget, view: SourceView = "original"): Tab[] {
  const id = sourceTabId(source);
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) return tabs.map((tab) => tab.id === id ? activateSource(tab, source, view) : tab);
  return [...tabs, activateSource({ id, label: source.fileName, filePath: "" }, source, view)];
}

export function switchSourceView(tabs: Tab[], tabId: string, view: SourceView): Tab[] {
  return tabs.map((tab) => tab.id === tabId && tab.source ? activateSource(tab, tab.source, view) : tab);
}

// Catalog polling makes newly available parsed text accessible in an already open tab.
export function refreshSourceTabs(tabs: Tab[], sources: SourceTarget[]): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const source = sources.find((item) => sourceTabId(item) === tab.id);
    if (!source || !tab.source
      || (source.originalPath === tab.source.originalPath && source.parsedPath === tab.source.parsedPath)) return tab;
    changed = true;
    return activateSource(tab, source, tab.sourceView ?? "original");
  });
  return changed ? next : tabs;
}
