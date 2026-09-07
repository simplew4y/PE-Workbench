import { DatabaseSync } from "node:sqlite";

export const PE_PIPELINE_SCHEMA_VERSION = 3;

interface ProjectIdentity {
	datasetId: string;
	name: string;
	now?: string;
}

interface NamedRow {
	name: string;
}
interface ValueRow {
	value: string;
}
interface CountRow {
	count: number;
}

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
    file_type TEXT NOT NULL DEFAULT 'pdf' CHECK(file_type IN ('pdf', 'xlsx', 'xlsm')),
    source_relpath TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0 CHECK(file_size >= 0),
    readable_text_path TEXT NOT NULL DEFAULT '',
    UNIQUE(dataset_id, sha256),
    UNIQUE(dataset_id, filename_key)
  );
  CREATE INDEX IF NOT EXISTS idx_documents_dataset ON documents(dataset_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_dataset_type ON documents(dataset_id, file_type, status, updated_at DESC);

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
  CREATE INDEX IF NOT EXISTS idx_pdf_pages_document ON pdf_pages(doc_id, page_number);
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
  CREATE INDEX IF NOT EXISTS idx_pdf_page_blocks_page ON pdf_page_blocks(page_id, reading_order);

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
    updated_at TEXT NOT NULL,
    worker_pid INTEGER,
    heartbeat_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(dataset_id, status, updated_at DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_pages_fts USING fts5(
    page_id UNINDEXED,
    doc_id UNINDEXED,
    page_text,
    tokenize='trigram'
  );

  CREATE TABLE IF NOT EXISTS excel_workbooks (
    workbook_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL UNIQUE,
    workbook_type TEXT NOT NULL,
    sheet_count INTEGER NOT NULL,
    visible_sheet_count INTEGER NOT NULL,
    formula_count INTEGER NOT NULL,
    non_empty_cell_count INTEGER NOT NULL,
    formula_density REAL NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS excel_sheets (
    sheet_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    sheet_index INTEGER NOT NULL,
    sheet_name TEXT NOT NULL,
    sheet_role TEXT NOT NULL,
    sheet_state TEXT,
    used_range TEXT,
    row_count INTEGER NOT NULL,
    col_count INTEGER NOT NULL,
    non_empty_cell_count INTEGER NOT NULL,
    formula_count INTEGER NOT NULL,
    formula_density REAL NOT NULL,
    summary TEXT,
    header_json TEXT,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    UNIQUE(doc_id, sheet_name)
  );
  CREATE TABLE IF NOT EXISTS excel_regions (
    region_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    sheet_name TEXT NOT NULL,
    region_index INTEGER NOT NULL,
    region_type TEXT NOT NULL,
    cell_range TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    col_count INTEGER NOT NULL,
    non_empty_cell_count INTEGER NOT NULL,
    formula_count INTEGER NOT NULL,
    formula_density REAL NOT NULL,
    summary TEXT,
    header_json TEXT,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    UNIQUE(doc_id, sheet_name, region_index)
  );
  CREATE TABLE IF NOT EXISTS excel_cells (
    cell_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    sheet_name TEXT NOT NULL,
    cell_ref TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    col_index INTEGER NOT NULL,
    value_type TEXT NOT NULL,
    display_value TEXT,
    raw_value TEXT,
    numeric_value REAL,
    formula TEXT,
    cached_value TEXT,
    number_format TEXT,
    row_label TEXT,
    col_label TEXT,
    period TEXT,
    unit TEXT,
    is_formula INTEGER NOT NULL DEFAULT 0,
    formula_type TEXT,
    formula_cache_status TEXT NOT NULL DEFAULT 'not_applicable',
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    UNIQUE(doc_id, sheet_name, cell_ref)
  );
  CREATE TABLE IF NOT EXISTS excel_defined_names (
    defined_name_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    name TEXT NOT NULL,
    scope_sheet TEXT,
    name_type TEXT,
    attr_text TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS excel_formula_references (
    reference_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    source_cell_id TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    source_cell_ref TEXT NOT NULL,
    reference_index INTEGER NOT NULL,
    raw_reference TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    target_sheet TEXT,
    target_range TEXT,
    defined_name TEXT,
    external_workbook TEXT,
    parse_status TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
    FOREIGN KEY(source_cell_id) REFERENCES excel_cells(cell_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS valuation_date_candidates (
    candidate_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    normalized_date TEXT,
    raw_text TEXT NOT NULL,
    role TEXT NOT NULL,
    source_type TEXT NOT NULL,
    evidence_id TEXT,
    sheet_name TEXT,
    cell_ref TEXT,
    row_index INTEGER,
    col_index INTEGER,
    nearby_label TEXT,
    parse_method TEXT NOT NULL,
    date_precision TEXT NOT NULL,
    is_forecast INTEGER NOT NULL DEFAULT 0,
    priority_score REAL NOT NULL,
    confidence REAL NOT NULL,
    rejection_reason TEXT,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS metric_facts (
    fact_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_alias TEXT,
    period TEXT,
    value_text TEXT,
    value_numeric REAL,
    unit TEXT,
    sheet_name TEXT NOT NULL,
    cell_ref TEXT NOT NULL,
    source_range TEXT,
    formula TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    fact_status TEXT NOT NULL DEFAULT 'candidate',
    quality_status TEXT NOT NULL DEFAULT 'review_required',
    quality_issues_json TEXT,
    metadata_json TEXT,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS document_cache (
    doc_id TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    cache_path TEXT NOT NULL,
    readable_path TEXT NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS processing_jobs (
    job_key TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    owner_id TEXT,
    lease_expires_at INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_excel_sheets_doc ON excel_sheets(doc_id, sheet_index);
  CREATE INDEX IF NOT EXISTS idx_excel_regions_doc ON excel_regions(doc_id, sheet_name, cell_range);
  CREATE INDEX IF NOT EXISTS idx_excel_cells_doc_sheet_position ON excel_cells(doc_id, sheet_name, row_index, col_index);
  CREATE INDEX IF NOT EXISTS idx_excel_defined_names_doc_name ON excel_defined_names(doc_id, name, scope_sheet);
  CREATE INDEX IF NOT EXISTS idx_excel_formula_references_source ON excel_formula_references(doc_id, source_sheet, source_cell_ref, reference_index);
  CREATE INDEX IF NOT EXISTS idx_excel_formula_references_target ON excel_formula_references(doc_id, target_sheet, target_range);
  CREATE INDEX IF NOT EXISTS idx_valuation_date_candidates_doc_role ON valuation_date_candidates(doc_id, role, normalized_date);
  CREATE INDEX IF NOT EXISTS idx_metric_facts_metric ON metric_facts(doc_id, metric_name, period);
`;

const LEGACY_DATA_TABLES = [
	"chunks",
	"chunk_locations",
	"excel_metric_facts",
	"excel_workbooks",
	"excel_sheets",
	"excel_regions",
	"excel_cells",
	"excel_defined_names",
	"excel_formula_references",
	"valuation_date_candidates",
	"metric_facts",
] as const;

export function openPeCollectionDatabase(collectionPath: string): DatabaseSync {
	const database = new DatabaseSync(collectionPath, { timeout: 10_000 });
	database.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
	return database;
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return (
		database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table) !== undefined
	);
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
	return new Set(
		(database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as NamedRow[]).map((row) => row.name),
	);
}

function schemaVersion(database: DatabaseSync): number | undefined {
	if (!tableExists(database, "schema_metadata")) return undefined;
	const row = database.prepare("SELECT value FROM schema_metadata WHERE key='pipeline_schema_version'").get() as
		| ValueRow
		| undefined;
	return row ? Number(row.value) : undefined;
}

function tableHasRows(database: DatabaseSync, table: string): boolean {
	const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as unknown as CountRow;
	return Number(row.count) > 0;
}

function addColumn(database: DatabaseSync, table: string, columns: Set<string>, definition: string): void {
	const name = definition.split(/\s+/u, 1)[0];
	if (!columns.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrateCurrentPdfSchema(database: DatabaseSync): void {
	const version = schemaVersion(database);
	if (version !== undefined && version !== 2 && version !== PE_PIPELINE_SCHEMA_VERSION) {
		throw new Error(`Unsupported PE Pipeline schema version ${version}; create a new project`);
	}
	for (const table of LEGACY_DATA_TABLES) {
		if (version !== PE_PIPELINE_SCHEMA_VERSION && tableExists(database, table)) {
			if (tableHasRows(database, table)) {
				throw new Error("Legacy Python Pipeline data detected; create a new project instead of writing in place");
			}
			database.exec(`DROP TABLE "${table}"`);
		}
	}
	if (!tableExists(database, "documents")) return;
	const columns = tableColumns(database, "documents");
	if (["logical_doc_id", "version_no", "supersedes_doc_id"].some((name) => columns.has(name))) {
		throw new Error("Versioned Finn/Main Pipeline data is not supported on the rebuild branch; create a new project");
	}
	for (const required of ["doc_id", "dataset_id", "filename_key", "raw_path", "sha256"]) {
		if (!columns.has(required)) throw new Error("Legacy documents table detected; create a new project");
	}
	addColumn(database, "documents", columns, "file_type TEXT NOT NULL DEFAULT 'pdf'");
	addColumn(database, "documents", columns, "source_relpath TEXT NOT NULL DEFAULT ''");
	addColumn(database, "documents", columns, "file_size INTEGER NOT NULL DEFAULT 0");
	addColumn(database, "documents", columns, "readable_text_path TEXT NOT NULL DEFAULT ''");
	database.exec(`UPDATE documents
		SET file_type=CASE WHEN file_type='' THEN 'pdf' ELSE file_type END,
			source_relpath=CASE WHEN source_relpath='' THEN original_filename ELSE source_relpath END`);
	if (tableExists(database, "ingest_jobs")) {
		const jobColumns = tableColumns(database, "ingest_jobs");
		addColumn(database, "ingest_jobs", jobColumns, "worker_pid INTEGER");
		addColumn(database, "ingest_jobs", jobColumns, "heartbeat_at TEXT");
	}
}

export function initializePeCollectionDatabase(collectionPath: string, identity?: ProjectIdentity): void {
	const database = openPeCollectionDatabase(collectionPath);
	try {
		database.exec("BEGIN IMMEDIATE");
		try {
			migrateCurrentPdfSchema(database);
			database.exec(PE_COLLECTION_SCHEMA);
			const now = identity?.now ?? new Date().toISOString();
			database
				.prepare(`INSERT INTO schema_metadata (key,value,updated_at) VALUES ('pipeline_schema_version',?,?)
				ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
				.run(String(PE_PIPELINE_SCHEMA_VERSION), now);
			if (identity) {
				const existing = database.prepare("SELECT dataset_id FROM project_metadata WHERE id=1").get() as
					| { dataset_id: string }
					| undefined;
				if (existing && existing.dataset_id !== identity.datasetId)
					throw new Error("Collection database belongs to a different dataset");
				database
					.prepare(`INSERT INTO project_metadata (id,dataset_id,name,created_at,updated_at) VALUES (1,?,?,?,?)
					ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`)
					.run(identity.datasetId, identity.name, now, now);
			}
			if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
				throw new Error("PE collection migration failed foreign key validation");
			}
			database.exec(`PRAGMA user_version=${PE_PIPELINE_SCHEMA_VERSION}; COMMIT`);
		} catch (error) {
			database.exec("ROLLBACK");
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
		const metadata = database.prepare("SELECT dataset_id FROM project_metadata WHERE id=1").get() as
			| { dataset_id: string }
			| undefined;
		if (!metadata || metadata.dataset_id !== datasetId)
			throw new Error("Collection database does not match the selected dataset");
	} finally {
		database.close();
	}
}
