"""Versioned analysis state; the shared collection schema remains owned by pe-boot."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

from .schema import execute_schema

ANALYSIS_SCHEMA_VERSION = 1


def ensure_state_schema(conn: sqlite3.Connection) -> None:
    execute_schema(conn, """
        CREATE TABLE IF NOT EXISTS pe_analysis_metadata (
            dataset_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            input_fingerprint TEXT,
            snapshot_fingerprint TEXT,
            built_at TEXT,
            coverage_json TEXT,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS pe_analysis_windows (
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            input_fingerprint TEXT NOT NULL,
            window_index INTEGER NOT NULL,
            window_fingerprint TEXT NOT NULL,
            status TEXT NOT NULL,
            page_ids_json TEXT NOT NULL,
            chars INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(dataset_id, doc_id, extractor_version, input_fingerprint, window_index)
        );
    """)
    versions = conn.execute("SELECT DISTINCT schema_version FROM pe_analysis_metadata").fetchall()
    if any(row[0] != ANALYSIS_SCHEMA_VERSION for row in versions):
        raise ValueError("Unsupported derived analysis schema; core collection is unchanged")


def current_documents(conn: sqlite3.Connection, dataset_id: str) -> list[sqlite3.Row]:
    return conn.execute("""
        SELECT doc_id, sha256, version_no, status, title, brokerage, document_date
        FROM documents WHERE dataset_id=? AND file_type='pdf'
          AND is_current=1 AND lifecycle_state='active' AND deleted_at IS NULL
        ORDER BY doc_id
    """, (dataset_id,)).fetchall()


def document_fingerprint(conn: sqlite3.Connection, doc_id: str) -> str:
    digest = hashlib.sha256()
    document = conn.execute("""
        SELECT doc_id, sha256, version_no, status, title, brokerage, document_date
        FROM documents WHERE doc_id=?
    """, (doc_id,)).fetchone()
    if document is None:
        raise ValueError("Analysis document no longer exists")
    for value in document:
        digest.update(str(value if value is not None else "").encode("utf-8"))
        digest.update(b"\0")
    for row in conn.execute("""
        SELECT page_id, page_number, page_text, text_quality, role
        FROM pdf_pages WHERE doc_id=? ORDER BY page_number
    """, (doc_id,)):
        for value in row:
            digest.update(str(value if value is not None else "").encode("utf-8"))
            digest.update(b"\0")
    return digest.hexdigest()


def collection_fingerprint(conn: sqlite3.Connection, dataset_id: str) -> str:
    digest = hashlib.sha256()
    for row in current_documents(conn, dataset_id):
        for value in (row["doc_id"], document_fingerprint(conn, row["doc_id"])):
            digest.update(value.encode("utf-8"))
            digest.update(b"\0")
    return digest.hexdigest()


def window_fingerprint(window) -> str:
    digest = hashlib.sha256()
    for entry in window.evidence:
        digest.update(entry.prompt_block().encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def completed_windows(conn, dataset_id, doc_id, extractor_version, windows) -> set[int]:
    fingerprint = document_fingerprint(conn, doc_id)
    rows = conn.execute("""
        SELECT window_index, window_fingerprint FROM pe_analysis_windows
        WHERE dataset_id=? AND doc_id=? AND extractor_version=? AND input_fingerprint=? AND status='completed'
    """, (dataset_id, doc_id, extractor_version, fingerprint)).fetchall()
    known = {row["window_index"]: row["window_fingerprint"] for row in rows}
    return {window.index for window in windows if known.get(window.index) == window_fingerprint(window)}


def record_windows(conn, *, dataset_id, doc_id, extractor_version, fingerprint, windows, attempted, failed) -> None:
    if document_fingerprint(conn, doc_id) != fingerprint:
        raise ValueError("PDF page text changed during analysis; retry against the new input")
    for window in windows:
        if window.index not in attempted:
            continue
        conn.execute("""
            INSERT INTO pe_analysis_windows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dataset_id,doc_id,extractor_version,input_fingerprint,window_index)
            DO UPDATE SET window_fingerprint=excluded.window_fingerprint, status=excluded.status,
                          page_ids_json=excluded.page_ids_json, chars=excluded.chars, updated_at=excluded.updated_at
        """, (dataset_id, doc_id, extractor_version, fingerprint, window.index, window_fingerprint(window),
              "failed" if window.index in failed else "completed",
              json.dumps([item.evidence_id for item in window.evidence]), window.chars,
              datetime.now(timezone.utc).isoformat()))
