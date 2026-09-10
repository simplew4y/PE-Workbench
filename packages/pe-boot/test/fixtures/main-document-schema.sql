
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, logical_doc_id TEXT NOT NULL,
  version_no INTEGER NOT NULL, supersedes_doc_id TEXT, is_current INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active', title TEXT NOT NULL,
  original_filename TEXT NOT NULL, source_relpath TEXT NOT NULL, stored_path TEXT NOT NULL,
  file_type TEXT NOT NULL, checksum TEXT NOT NULL, file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', doc_type TEXT, document_date TEXT,
  company_name TEXT, company_ticker TEXT, source_name TEXT, metadata_json TEXT,
  parser_name TEXT, parser_version TEXT, parser_metadata_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS documents_current ON documents(dataset_id, is_current, source_relpath);
CREATE TABLE IF NOT EXISTS document_cache (
  doc_id TEXT PRIMARY KEY, revision TEXT NOT NULL, prepared_at TEXT NOT NULL,
  FOREIGN KEY(doc_id) REFERENCES documents(doc_id)
);
