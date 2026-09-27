-- Frozen from Web rebuild_pipeline/search@79b8b244.

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
