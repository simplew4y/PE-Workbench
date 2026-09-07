#!/usr/bin/env python3
"""Run optional claim/checklist analysis against an indexed PE collection.

This is deliberately separate from the legacy Python document parser. Pi Web's
production worker indexes PDFs and Excel files in Node, then invokes this small
sidecar against the committed SQLite evidence. A model failure therefore never
rolls back or corrupts deterministic ingestion.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from atomic_claims import scan_documents  # noqa: E402
from consensus_cards import build_consensus_cards  # noqa: E402
from llm_client import build_chat_client_from_env  # noqa: E402


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (name,),
    ).fetchone() is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")')}


def _active_evidence_documents(
    conn: sqlite3.Connection, dataset_id: str, requested: list[str]
) -> list[str]:
    columns = _columns(conn, "documents")
    if not {"doc_id", "dataset_id"}.issubset(columns):
        raise ValueError("collection documents schema is incomplete")

    predicates = ["d.dataset_id = ?"]
    if "file_type" in columns:
        predicates.append("COALESCE(d.file_type, 'pdf') = 'pdf'")
    if "is_current" in columns:
        predicates.append("COALESCE(d.is_current, 1) = 1")
    if "lifecycle_state" in columns:
        predicates.append("COALESCE(d.lifecycle_state, 'active') = 'active'")
    if "deleted_at" in columns:
        predicates.append("d.deleted_at IS NULL")

    if _table_exists(conn, "pdf_pages"):
        predicates.append("EXISTS (SELECT 1 FROM pdf_pages p WHERE p.doc_id = d.doc_id)")
    elif _table_exists(conn, "chunks"):
        predicates.append("EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = d.doc_id)")
    else:
        return []

    order = "d.created_at, d.doc_id" if "created_at" in columns else "d.doc_id"
    rows = conn.execute(
        f"SELECT d.doc_id FROM documents d WHERE {' AND '.join(predicates)} ORDER BY {order}",
        (dataset_id,),
    ).fetchall()
    available = [str(row["doc_id"]) for row in rows]
    available_set = set(available)
    prioritized = [doc_id for doc_id in dict.fromkeys(requested) if doc_id in available_set]
    prioritized_set = set(prioritized)
    return [*prioritized, *(doc_id for doc_id in available if doc_id not in prioritized_set)]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--company-name", default="")
    parser.add_argument("--ingested-at", default="")
    parser.add_argument("--doc-id", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    collection = Path(args.collection).resolve()
    if not collection.is_file():
        raise ValueError("collection database does not exist")
    conn = sqlite3.connect(str(collection), timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout=30000")
        if not _table_exists(conn, "documents"):
            raise ValueError("collection has no documents table")
        known = conn.execute(
            "SELECT 1 FROM documents WHERE dataset_id = ? LIMIT 1", (args.dataset_id,)
        ).fetchone()
        if known is None:
            raise ValueError("dataset does not match the collection")

        doc_ids = _active_evidence_documents(conn, args.dataset_id, args.doc_id)
        client = build_chat_client_from_env()
        summary = scan_documents(
            conn,
            dataset_id=args.dataset_id,
            doc_ids=doc_ids,
            llm_client=client,
            company_name=args.company_name,
            ingested_at=args.ingested_at,
            force=args.force,
        )
        try:
            summary["cards"] = build_consensus_cards(
                conn,
                args.dataset_id,
                llm_client=client,
                company_name=args.company_name,
            )
        except Exception as exc:  # noqa: BLE001 - cards are derived, ingestion remains valid
            summary["cards"] = {
                "status": "failed",
                "message": f"{type(exc).__name__}: {exc}"[:300],
            }
        summary["documents_considered"] = len(doc_ids)
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    args = _parse_args()
    try:
        print(json.dumps(analyze(args), ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 - the Node worker records this as a warning
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
