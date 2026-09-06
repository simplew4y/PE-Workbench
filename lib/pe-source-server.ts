import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolvePeEvidenceSource as resolveVersionedEvidence } from "@earendil-works/pe-boot/evidence";
import type { PeExcelGridWindow, PeSourceCell, PeSourcePayload } from "./pe-source";

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

interface DatasetConnection {
  database: DatabaseSync;
  datasetId: string;
  workspaceRoot: string;
}

interface ExcelWindow {
  cells: PeSourceCell[];
  gridWindow?: PeExcelGridWindow;
}

const MAX_EXCEL_GRID_ROWS = 12;
const MAX_EXCEL_GRID_COLUMNS = 12;

export interface ResolvedPeSource {
  payload: PeSourcePayload;
  filePath?: string;
}

export class PeSourceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PeSourceError";
    this.status = status;
  }
}

function textValue(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function openDataset(cwd: string): DatasetConnection {
  let workspaceRoot: string;
  let databasePath: string;
  try {
    workspaceRoot = realpathSync(cwd);
    databasePath = realpathSync(join(workspaceRoot, "meta", "collection.sqlite3"));
  } catch {
    throw new PeSourceError(400, "当前工作目录不是有效的 PE 项目工作区。");
  }
  if (!isWithin(workspaceRoot, databasePath) || !statSync(databasePath).isFile()) {
    throw new PeSourceError(400, "PE 数据库不在当前项目工作区内。");
  }

  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 10_000 });
  try {
    database.exec("PRAGMA busy_timeout=10000");
    const rows = database
      .prepare(
        "SELECT DISTINCT dataset_id FROM documents WHERE dataset_id IS NOT NULL AND trim(dataset_id) <> '' ORDER BY dataset_id",
      )
      .all() as SqlRow[];
    const datasetIds = rows.map((row) => textValue(row, "dataset_id")).filter((value) => value !== undefined);
    if (datasetIds.length !== 1) {
      throw new PeSourceError(400, "PE 项目必须且只能包含一个 dataset_id。");
    }
    return { database, datasetId: datasetIds[0], workspaceRoot };
  } catch (error) {
    database.close();
    throw error;
  }
}

function sourceFilename(row: SqlRow): string {
  return textValue(row, "source_relpath") ?? textValue(row, "original_filename") ?? "未知资料";
}

function sourceCitation(row: SqlRow): string {
  const filename = sourceFilename(row);
  const pageStart = numberValue(row, "page_start");
  const pageEnd = numberValue(row, "page_end");
  const sheetName = textValue(row, "sheet_name");
  const cellRange = textValue(row, "cell_range") ?? textValue(row, "cell_ref");
  if (pageStart !== undefined) {
    return pageEnd !== undefined && pageEnd !== pageStart
      ? `${filename} p.${pageStart}-${pageEnd}`
      : `${filename} p.${pageStart}`;
  }
  if (sheetName && cellRange) return `${filename} ${sheetName}!${cellRange}`;
  if (sheetName) return `${filename} ${sheetName}`;
  return filename;
}

function evidenceRow(connection: DatasetConnection, evidenceId: string): SqlRow {
  const separator = evidenceId.indexOf(":");
  if (separator <= 0 || separator === evidenceId.length - 1) {
    throw new PeSourceError(400, "证据 ID 格式无效。");
  }
  const kind = evidenceId.slice(0, separator);
  const rawId = evidenceId.slice(separator + 1);
  const activeDocument =
    "d.deleted_at IS NULL AND COALESCE(d.is_current, 1) = 1 AND COALESCE(d.lifecycle_state, 'active') = 'active'";
  let row: SqlRow | undefined;

  if (kind === "page") {
    row = connection.database
      .prepare(
        `SELECT p.page_id, p.doc_id, p.page_text AS content,
                p.page_number AS page_start, p.page_number AS page_end,
                d.original_filename, d.raw_path, 'pdf' AS file_type
         FROM pdf_pages p
         JOIN documents d ON d.doc_id = p.doc_id
         WHERE p.page_id = ? AND d.dataset_id = ?`,
      )
      .get(rawId, connection.datasetId) as SqlRow | undefined;
  } else if (kind === "chunk") {
    row = connection.database
      .prepare(
        `SELECT c.chunk_id, c.doc_id, c.content, c.content_type, c.title_path,
                d.original_filename, d.source_relpath, d.file_type,
                l.page_start, l.page_end, l.sheet_name, l.cell_range
         FROM chunks c
         JOIN documents d ON d.doc_id = c.doc_id
         LEFT JOIN chunk_locations l
           ON l.chunk_id = c.chunk_id
          AND l.location_index = (
            SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
          )
         WHERE c.chunk_id = ? AND c.dataset_id = ? AND ${activeDocument}`,
      )
      .get(rawId, connection.datasetId) as SqlRow | undefined;
  } else if (kind === "fact") {
    row = connection.database
      .prepare(
        `SELECT f.fact_id, f.doc_id, f.metric_name, f.period, f.value_text, f.value_numeric,
                f.unit, f.sheet_name, f.cell_ref, f.cell_ref AS cell_range, f.formula,
                d.original_filename, d.source_relpath, d.file_type
         FROM metric_facts f
         JOIN documents d ON d.doc_id = f.doc_id
         WHERE f.fact_id = ? AND f.dataset_id = ? AND ${activeDocument}`,
      )
      .get(rawId, connection.datasetId) as SqlRow | undefined;
  } else if (kind === "cell") {
    row = connection.database
      .prepare(
        `SELECT c.*, c.cell_ref AS cell_range,
                d.original_filename, d.source_relpath, d.file_type
         FROM excel_cells c
         JOIN documents d ON d.doc_id = c.doc_id
         WHERE c.cell_id = ? AND c.dataset_id = ? AND ${activeDocument}`,
      )
      .get(rawId, connection.datasetId) as SqlRow | undefined;
  } else {
    throw new PeSourceError(400, "不支持的证据类型。");
  }

  if (!row) throw new PeSourceError(404, "当前项目中找不到该证据。");
  return row;
}

function columnToNumber(column: string): number {
  let value = 0;
  for (const character of column.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function parseCellRef(cellRef: string): [number, number] | undefined {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/u.exec(cellRef.trim());
  return match ? [Number(match[2]), columnToNumber(match[1])] : undefined;
}

function parseCellRange(cellRange: string): [number, number, number, number] | undefined {
  const [startRef, endRef = startRef] = cellRange.split(":", 2);
  const start = parseCellRef(startRef);
  const end = parseCellRef(endRef);
  if (!start || !end) return undefined;
  return [
    Math.min(start[0], end[0]),
    Math.min(start[1], end[1]),
    Math.max(start[0], end[0]),
    Math.max(start[1], end[1]),
  ];
}

function boundedAxis(start: number, end: number, padding: number, maximumSize: number): [number, number] {
  const focusSize = end - start + 1;
  if (focusSize >= maximumSize) return [start, start + maximumSize - 1];
  const availablePadding = maximumSize - focusSize;
  const before = Math.min(start - 1, Math.min(padding, Math.floor(availablePadding / 2)));
  const after = Math.min(padding, availablePadding - before);
  let windowStart = start - before;
  let windowEnd = end + after;
  const missing = maximumSize - (windowEnd - windowStart + 1);
  windowStart = Math.max(1, windowStart - missing);
  windowEnd = Math.min(windowStart + maximumSize - 1, windowEnd + missing);
  return [windowStart, windowEnd];
}

function excelCells(connection: DatasetConnection, row: SqlRow): ExcelWindow {
  const docId = textValue(row, "doc_id");
  const sheetName = textValue(row, "sheet_name");
  const cellRange = textValue(row, "cell_range") ?? textValue(row, "cell_ref");
  if (!docId || !sheetName || !cellRange) return { cells: [] };
  const bounds = parseCellRange(cellRange);
  if (!bounds) return { cells: [] };
  const [rowStart, rowEnd] = boundedAxis(bounds[0], bounds[2], 4, MAX_EXCEL_GRID_ROWS);
  const [colStart, colEnd] = boundedAxis(bounds[1], bounds[3], 4, MAX_EXCEL_GRID_COLUMNS);
  const gridWindow = {
    row_start: rowStart,
    row_end: rowEnd,
    col_start: colStart,
    col_end: colEnd,
  };
  const rows = connection.database
    .prepare(
      `SELECT cell_ref, row_index, col_index, display_value, raw_value, formula,
              row_label, col_label, period, unit
       FROM excel_cells
       WHERE dataset_id = ? AND doc_id = ? AND sheet_name = ?
         AND row_index BETWEEN ? AND ? AND col_index BETWEEN ? AND ?
       ORDER BY row_index, col_index
       LIMIT ${MAX_EXCEL_GRID_ROWS * MAX_EXCEL_GRID_COLUMNS}`,
    )
    .all(connection.datasetId, docId, sheetName, rowStart, rowEnd, colStart, colEnd) as SqlRow[];
  const cells = rows.map((cell) => {
    const payload: PeSourceCell = {
      cell_ref: textValue(cell, "cell_ref") ?? "",
      row_index: numberValue(cell, "row_index") ?? 0,
      col_index: numberValue(cell, "col_index") ?? 0,
    };
    for (const key of ["display_value", "raw_value", "formula", "row_label", "col_label", "period", "unit"] as const) {
      const value = textValue(cell, key);
      if (value) payload[key] = value;
    }
    return payload;
  });
  return { cells, gridWindow };
}

function pdfPages(connection: DatasetConnection, row: SqlRow): Array<{ page_number: number; text: string }> {
  const docId = textValue(row, "doc_id");
  const pageStart = numberValue(row, "page_start");
  const pageEnd = numberValue(row, "page_end") ?? pageStart;
  if (!docId || pageStart === undefined || pageEnd === undefined) return [];
  const usesPagePipeline = connection.database
    .prepare("SELECT 1 FROM pragma_table_info('pdf_pages') WHERE name='page_text'")
    .get() !== undefined;
  const rows = usesPagePipeline
    ? connection.database
        .prepare(
          `SELECT p.page_number, p.page_text AS text
           FROM pdf_pages p
           JOIN documents d ON d.doc_id=p.doc_id
           WHERE d.dataset_id=? AND p.doc_id=? AND p.page_number BETWEEN ? AND ?
           ORDER BY p.page_number`,
        )
        .all(connection.datasetId, docId, Math.max(1, pageStart - 1), pageEnd + 1) as SqlRow[]
    : connection.database
        .prepare(
          `SELECT page_number, text FROM pdf_pages
           WHERE dataset_id = ? AND doc_id = ? AND page_number BETWEEN ? AND ?
           ORDER BY page_number`,
        )
        .all(connection.datasetId, docId, Math.max(1, pageStart - 1), pageEnd + 1) as SqlRow[];
  return rows.map((page) => ({
    page_number: numberValue(page, "page_number") ?? 0,
    text: (textValue(page, "text") ?? "").slice(0, 3_500),
  }));
}

function sourceFilePath(workspaceRoot: string, row: SqlRow): string {
  let rawRoot: string;
  try {
    rawRoot = realpathSync(join(workspaceRoot, "raw"));
  } catch {
    throw new PeSourceError(404, "当前项目缺少 raw 资料目录。");
  }
  if (!isWithin(workspaceRoot, rawRoot)) throw new PeSourceError(404, "资料目录越出当前项目工作区。");

  const candidates = [textValue(row, "raw_path"), textValue(row, "source_relpath"), textValue(row, "original_filename")];
  for (const candidate of candidates) {
    if (!candidate || isAbsolute(candidate)) continue;
    const normalized = candidate.replaceAll("\\", "/").replace(/^raw\//u, "");
    try {
      const resolved = realpathSync(join(rawRoot, normalized));
      if (isWithin(rawRoot, resolved) && statSync(resolved).isFile()) return resolved;
    } catch {
      // Try the next dataset-relative filename.
    }
  }
  throw new PeSourceError(404, "当前项目的 raw 目录中找不到引用原文件。");
}

export async function resolvePeEvidenceSource(cwd: string, evidenceId: string): Promise<ResolvedPeSource> {
  if (evidenceId.startsWith("source:")) return resolveVersionedSource(cwd, evidenceId);
  const connection = openDataset(cwd);
  try {
    if (/^(cell|fact):/u.test(evidenceId) && connection.database
      .prepare("SELECT 1 FROM pragma_table_info('documents') WHERE name='version_no'").get()) {
      return await resolveVersionedSource(cwd, evidenceId);
    }
    const row = evidenceRow(connection, evidenceId);
    const filename = sourceFilename(row);
    const citation = sourceCitation(row);
    const fileType = (textValue(row, "file_type") ?? "").toLowerCase().replace(/^\./u, "");
    if (fileType === "pdf") {
      const pageStart = numberValue(row, "page_start") ?? 1;
      const pageEnd = numberValue(row, "page_end") ?? pageStart;
      return {
        payload: {
          kind: "pdf",
          dataset_id: connection.datasetId,
          evidence_id: evidenceId,
          citation,
          filename,
          page_start: pageStart,
          page_end: pageEnd,
          content: textValue(row, "content"),
          pdf_pages: pdfPages(connection, row),
        },
        filePath: sourceFilePath(connection.workspaceRoot, row),
      };
    }
    if (["xlsx", "xlsm", "xls", "csv"].includes(fileType)) {
      const excelWindow = excelCells(connection, row);
      return {
        payload: {
          kind: "excel",
          dataset_id: connection.datasetId,
          evidence_id: evidenceId,
          citation,
          filename,
          sheet_name: textValue(row, "sheet_name"),
          cell_range: textValue(row, "cell_range") ?? textValue(row, "cell_ref"),
          grid_window: excelWindow.gridWindow,
          cells: excelWindow.cells,
        },
      };
    }
    return {
      payload: {
        kind: "text",
        dataset_id: connection.datasetId,
        evidence_id: evidenceId,
        citation,
        filename,
        content: textValue(row, "content") ?? "",
      },
    };
  } finally {
    connection.database.close();
  }
}

async function resolveVersionedSource(cwd: string, evidenceId: string): Promise<ResolvedPeSource> {
  try {
    return await resolveVersionedEvidence(cwd, evidenceId);
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      throw new PeSourceError(error.status, error.message);
    }
    throw error;
  }
}
