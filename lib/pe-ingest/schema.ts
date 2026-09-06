import { DatabaseSync } from "node:sqlite";
import { PE_PIPELINE_SCHEMA_VERSION } from "./contracts.ts";

interface ProjectIdentity {
  datasetId: string;
  name: string;
  now?: string;
}

interface TableNameRow {
  name: string;
}

interface CountRow {
  count: number;
}

interface ColumnRow {
  name: string;
}

const REQUIRED_DOCUMENT_COLUMNS = new Set([
  "doc_id",
  "dataset_id",
  "filename_key",
  "sha256",
]);

const LEGACY_DATA_TABLES = [
  "chunks",
  "chunk_locations",
  "excel_cells",
  "excel_metric_facts",
  "excel_sheets",
];

export const PE_COLLECTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_metadata (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    filename_key TEXT NOT NULL,
    raw_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    page_count INTEGER NOT NULL CHECK(page_count >= 0),
    parser_name TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    title TEXT NOT NULL,
    brokerage TEXT NOT NULL,
    document_date TEXT NOT NULL,
    rating TEXT NOT NULL,
    target_price TEXT NOT NULL,
    exhibits_json TEXT NOT NULL,
    pdf_metadata_json TEXT NOT NULL,
    artifact_directory TEXT NOT NULL,
    document_markdown_path TEXT NOT NULL,
    layout_json_path TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(dataset_id, sha256),
    UNIQUE(dataset_id, filename_key)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_dataset
    ON documents(dataset_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS pdf_pages (
    page_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    page_number INTEGER NOT NULL CHECK(page_number >= 1),
    page_text TEXT NOT NULL,
    page_header TEXT NOT NULL,
    role TEXT NOT NULL,
    role_signals_json TEXT NOT NULL,
    text_quality TEXT NOT NULL,
    quality_signals_json TEXT NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    rotation INTEGER NOT NULL,
    image_paths_json TEXT NOT NULL,
    embedded_image_count INTEGER NOT NULL,
    large_embedded_image_count INTEGER NOT NULL,
    drawing_operator_count INTEGER NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    UNIQUE(doc_id, page_number)
  );

  CREATE INDEX IF NOT EXISTS idx_pdf_pages_document
    ON pdf_pages(doc_id, page_number);

  CREATE TABLE IF NOT EXISTS pdf_page_blocks (
    block_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    block_index INTEGER NOT NULL,
    block_type TEXT NOT NULL,
    block_text TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    reading_order INTEGER NOT NULL,
    column_no INTEGER NOT NULL,
    font_names_json TEXT NOT NULL,
    directions_json TEXT NOT NULL,
    FOREIGN KEY(page_id) REFERENCES pdf_pages(page_id) ON DELETE CASCADE,
    UNIQUE(page_id, block_index)
  );

  CREATE INDEX IF NOT EXISTS idx_pdf_page_blocks_page
    ON pdf_page_blocks(page_id, reading_order);

  CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    input_files_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status
    ON ingest_jobs(dataset_id, status, updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_pages_fts USING fts5(
    page_id UNINDEXED,
    doc_id UNINDEXED,
    page_text,
    tokenize='trigram'
  );
`;

export function openPeCollectionDatabase(collectionPath: string): DatabaseSync {
  const database = new DatabaseSync(collectionPath, { timeout: 10_000 });
  database.exec("PRAGMA busy_timeout=10000");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA journal_mode=WAL");
  return database;
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  ).all() as unknown as TableNameRow[];
  return new Set(rows.map((row) => row.name));
}

function tableHasRows(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as unknown as CountRow;
  return Number(row.count) > 0;
}

function assertSchemaCanBeInitialized(database: DatabaseSync): void {
  const tables = tableNames(database);
  if (tables.has("schema_metadata")) {
    const row = database.prepare(
      "SELECT value FROM schema_metadata WHERE key = 'pipeline_schema_version'",
    ).get() as { value: string } | undefined;
    if (row && row.value !== String(PE_PIPELINE_SCHEMA_VERSION)) {
      throw new Error(
        `Unsupported PE Pipeline schema version ${row.value}; create a new project`,
      );
    }
  }

  for (const table of LEGACY_DATA_TABLES) {
    if (tables.has(table) && tableHasRows(database, table)) {
      throw new Error("Legacy Python Pipeline data detected; create a new project instead of writing in place");
    }
  }

  if (tables.has("documents")) {
    const columns = database.prepare("PRAGMA table_info(documents)").all() as unknown as ColumnRow[];
    const names = new Set(columns.map((column) => column.name));
    if ([...REQUIRED_DOCUMENT_COLUMNS].some((column) => !names.has(column))) {
      throw new Error("Legacy documents table detected; create a new project instead of writing in place");
    }
  }
}

export function initializePeCollectionDatabase(
  collectionPath: string,
  identity?: ProjectIdentity,
): void {
  const database = openPeCollectionDatabase(collectionPath);
  try {
    assertSchemaCanBeInitialized(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(PE_COLLECTION_SCHEMA);
      const now = identity?.now ?? new Date().toISOString();
      database.prepare(`
        INSERT INTO schema_metadata (key, value, updated_at)
        VALUES ('pipeline_schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(PE_PIPELINE_SCHEMA_VERSION), now);
      if (identity) {
        const existing = database.prepare(
          "SELECT dataset_id FROM project_metadata WHERE id = 1",
        ).get() as { dataset_id: string } | undefined;
        if (existing && existing.dataset_id !== identity.datasetId) {
          throw new Error("Collection database belongs to a different dataset");
        }
        database.prepare(`
          INSERT INTO project_metadata (id, dataset_id, name, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `).run(identity.datasetId, identity.name, now, now);
      }
      database.exec(`PRAGMA user_version=${PE_PIPELINE_SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

export function assertPeCollectionDataset(collectionPath: string, datasetId: string): void {
  initializePeCollectionDatabase(collectionPath);
  const database = openPeCollectionDatabase(collectionPath);
  try {
    const metadata = database.prepare(
      "SELECT dataset_id FROM project_metadata WHERE id = 1",
    ).get() as { dataset_id: string } | undefined;
    if (!metadata || metadata.dataset_id !== datasetId) {
      throw new Error("Collection database does not match the selected dataset");
    }
  } finally {
    database.close();
  }
}
