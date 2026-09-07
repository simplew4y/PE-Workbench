export const PE_SOURCE_HASH = "#pe-source";

export interface PeSourceReference {
  evidenceId: string;
}

export interface PeSourceCell {
  cell_ref: string;
  row_index: number;
  col_index: number;
  display_value?: string;
  raw_value?: string;
  numeric_value?: number;
  formula?: string;
  cached_value?: string;
  number_format?: string;
  formula_type?: string;
  formula_cache_status?: string;
  is_formula?: boolean;
  row_label?: string;
  col_label?: string;
  period?: string;
  unit?: string;
}

export interface PeExcelGridWindow {
  row_start: number;
  row_end: number;
  col_start: number;
  col_end: number;
}

interface PeSourceBase {
  dataset_id: string;
  doc_id: string;
  evidence_id: string;
  citation: string;
  filename: string;
  markdown_citation?: string;
  truncated?: boolean;
  warnings?: string[];
}

export interface PePdfSource extends PeSourceBase {
  kind: "pdf";
  page_start: number;
  page_end: number;
  content?: string;
  pdf_pages: Array<{ page_number: number; text: string }>;
}

export interface PeExcelSource extends PeSourceBase {
  kind: "excel";
  sheet_name?: string;
  cell_range?: string;
  grid_window?: PeExcelGridWindow;
  cells: PeSourceCell[];
}

export type PeSourcePayload = PePdfSource | PeExcelSource;

export function parsePeSourceHref(href: string | undefined): PeSourceReference | null {
  if (!href) return null;
  const hashIndex = href.indexOf(PE_SOURCE_HASH);
  let suffix: string;
  if (hashIndex >= 0) {
    suffix = href.slice(hashIndex + PE_SOURCE_HASH.length);
  } else {
    // Some model replies expanded the internal fragment into this fictitious
    // app URL. Recover its evidence identity locally; never fetch that host or
    // trust a cwd embedded in the link. Other external URLs remain ordinary links.
    try {
      const url = new URL(href, "https://pe-workbench.local");
      if (!/^https?:$/.test(url.protocol) || url.hostname !== "pe-workbench.local" || url.port || url.username || url.password || url.pathname !== "/pe-source") return null;
      suffix = url.search;
    } catch { return null; }
  }
  if (!suffix.startsWith("?")) return null;
  const evidenceId = new URLSearchParams(suffix.slice(1)).get("evidence_id")?.trim();
  if (!evidenceId || !/^(?:page:[A-Za-z0-9_-]+|source:[A-Za-z0-9_-]+)$/u.test(evidenceId)) return null;
  return { evidenceId };
}

export function peSourceApiUrl(cwd: string, evidenceId: string): string {
  const params = new URLSearchParams({ cwd, evidence_id: evidenceId });
  return `/api/pe/source?${params.toString()}`;
}

export function peSourceFileUrl(cwd: string, evidenceId: string): string {
  const params = new URLSearchParams({ cwd, evidence_id: evidenceId });
  return `/api/pe/source/file?${params.toString()}`;
}

export function excelColumnLabel(columnIndex: number): string {
  if (!Number.isInteger(columnIndex) || columnIndex < 1) return "";
  let value = columnIndex;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function parseExcelCellRange(cellRange: string | undefined): PeExcelGridWindow | undefined {
  if (!cellRange) return undefined;
  const parseCell = (cellRef: string): [number, number] | undefined => {
    const match = /^\$?([A-Za-z]+)\$?(\d+)$/u.exec(cellRef.trim());
    if (!match) return undefined;
    let column = 0;
    for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
    return [Number(match[2]), column];
  };
  const [startRef, endRef = startRef] = cellRange.split(":", 2);
  const start = parseCell(startRef);
  const end = parseCell(endRef);
  if (!start || !end) return undefined;
  return {
    row_start: Math.min(start[0], end[0]),
    row_end: Math.max(start[0], end[0]),
    col_start: Math.min(start[1], end[1]),
    col_end: Math.max(start[1], end[1]),
  };
}
