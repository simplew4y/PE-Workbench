"""Analyze existing PDF pages. No parsing, chunk tables or document-schema migrations."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
from datetime import datetime, timezone

from pipeline.atomic_claims import EXTRACTOR_VERSION, build_windows, scan_documents
from pipeline.consensus_cards import build_cards, ensure_cards_schema, store_cards, write_narratives
from pipeline.llm_client import build_chat_client_from_env
from pipeline.state import (
    ANALYSIS_SCHEMA_VERSION, collection_fingerprint, completed_windows,
    current_documents, ensure_state_schema,
)


def progress(event: dict) -> None:
    print(json.dumps({"kind": "progress", **event}, ensure_ascii=False), file=sys.stderr, flush=True)


def coverage(conn: sqlite3.Connection, dataset_id: str) -> dict:
    result = {"documents": 0, "completed_documents": 0, "completed_windows": 0,
              "total_windows": 0, "unscanned_pages": 0, "needs_ocr_pages": 0, "incomplete_documents": []}
    for doc in current_documents(conn, dataset_id):
        doc_id = doc["doc_id"]
        result["documents"] += 1
        windows, capped = build_windows(conn, doc_id)
        complete = completed_windows(conn, dataset_id, doc_id, EXTRACTOR_VERSION, windows)
        scanned_pages = {entry.evidence_id for w in windows if w.index in complete for entry in w.evidence}
        pages = conn.execute("SELECT page_id, text_quality FROM pdf_pages WHERE doc_id=?", (doc_id,)).fetchall()
        result["completed_windows"] += len(complete)
        result["total_windows"] += len(windows)
        result["unscanned_pages"] += sum(f"page:{p['page_id']}" not in scanned_pages for p in pages)
        ocr = sum(p["text_quality"] == "needs_ocr" for p in pages)
        result["needs_ocr_pages"] += ocr
        if pages and not capped and len(complete) == len(windows) and not ocr and len(scanned_pages) == len(pages):
            result["completed_documents"] += 1
        else:
            result["incomplete_documents"].append(doc_id)
    result["complete"] = result["documents"] == result["completed_documents"]
    return result


def analyze_collection(collection_path: str, dataset_id: str, *, doc_ids: list[str] | None = None,
                       company_name: str = "", ingested_at: str = "") -> dict:
    target = Path(collection_path).resolve(strict=True)
    if target.name != "collection.sqlite3" or target.parent.name != "meta":
        raise ValueError("Expected the selected project's meta/collection.sqlite3")
    conn = sqlite3.connect(f"{target.as_uri()}?mode=rw", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    started = datetime.now(timezone.utc).isoformat()
    try:
        conn.execute("PRAGMA busy_timeout=10000")
        identity = conn.execute("SELECT DISTINCT dataset_id FROM project_metadata").fetchall()
        if len(identity) != 1 or identity[0][0] != dataset_id:
            raise ValueError("dataset_id does not match the selected project")
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name IN ('chunks','chunk_locations')").fetchone():
            raise ValueError("Analysis requires the page-level collection, not a legacy chunk dataset")
        ensure_state_schema(conn)
        ensure_cards_schema(conn)
        fingerprint = collection_fingerprint(conn, dataset_id)
        conn.execute("""
            INSERT INTO pe_analysis_metadata(dataset_id,schema_version,status,started_at,input_fingerprint)
            VALUES (?,?,'running',?,?)
            ON CONFLICT(dataset_id) DO UPDATE SET status='running',started_at=excluded.started_at,
                input_fingerprint=excluded.input_fingerprint,error=NULL
        """, (dataset_id, ANALYSIS_SCHEMA_VERSION, started, fingerprint))
        conn.commit()
        documents = current_documents(conn, dataset_id)
        valid_ids = {row["doc_id"] for row in documents}
        requested = list(dict.fromkeys(doc_ids or []))
        # A mixed upload includes Excel IDs; never scan those documents.
        ordered = [doc for doc in requested if doc in valid_ids]
        ordered.extend(row["doc_id"] for row in documents if row["doc_id"] not in ordered)
        client = None if os.environ.get("PE_INGEST_ANALYSIS_DISABLED") == "1" else build_chat_client_from_env()
        if client is None:
            status = "skipped_disabled" if os.environ.get("PE_INGEST_ANALYSIS_DISABLED") == "1" else "skipped_no_model"
            result = {"status": status, "documents_scanned": 0, "errors": []}
            current_coverage = coverage(conn, dataset_id)
        else:
            result = scan_documents(conn, dataset_id=dataset_id, doc_ids=ordered, llm_client=client,
                                    company_name=company_name, ingested_at=ingested_at, progress=progress)
            current_coverage = coverage(conn, dataset_id)
            status = "partial" if not current_coverage["complete"] else result["status"]
            if result.get("errors") or result.get("documents_failed"):
                status = "failed" if not result["documents_scanned"] else "partial"
            # Publish one complete snapshot only. Failed/partial scans leave the last complete cards intact.
            if status == "completed":
                progress({"stage": "consensus"})
                cards = build_cards(conn, dataset_id)
                conn.commit()
                method, errors = write_narratives(cards, llm_client=client, company_name=company_name)
                if errors:
                    result["errors"].extend(errors)
                    status = "failed"
                else:
                    conn.execute("BEGIN IMMEDIATE")
                    if collection_fingerprint(conn, dataset_id) != fingerprint:
                        raise ValueError("Project PDF inputs changed during analysis")
                    store_cards(conn, dataset_id, cards, as_of=datetime.now(timezone.utc).date(),
                                narrative_method=method, commit=False)
                    conn.execute("""
                        UPDATE pe_analysis_metadata SET snapshot_fingerprint=?,built_at=? WHERE dataset_id=?
                    """, (fingerprint, datetime.now(timezone.utc).isoformat(), dataset_id))
                    result["consensus_cards"] = {"cards": len(cards), "narrative_method": method}
        finished = datetime.now(timezone.utc).isoformat()
        result.update({"status": status, "coverage": current_coverage, "finished_at": finished})
        conn.execute("""
            UPDATE pe_analysis_metadata SET status=?,finished_at=?,coverage_json=?,error=? WHERE dataset_id=?
        """, (status, finished, json.dumps(current_coverage), "; ".join(result.get("errors", []))[:1000] or None, dataset_id))
        conn.commit()
        return result
    except Exception as exc:
        conn.rollback()
        try:
            conn.execute("""
                UPDATE pe_analysis_metadata SET status='failed',finished_at=?,error=? WHERE dataset_id=?
            """, (datetime.now(timezone.utc).isoformat(), str(exc)[:1000], dataset_id))
            conn.commit()
        except sqlite3.Error:
            conn.rollback()
        raise
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection-path", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--company-name", default="")
    parser.add_argument("--ingested-at", default="")
    parser.add_argument("--doc-ids-json", default="[]")
    parser.add_argument("--parent-stdio", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=1800)
    args = parser.parse_args()
    if args.parent_stdio:
        # EOF also happens when the Node worker is killed without running its signal handler.
        def watch_parent() -> None:
            os.read(sys.stdin.fileno(), 1)
            os._exit(125)
        threading.Thread(target=watch_parent, daemon=True).start()
        timer = threading.Timer(args.timeout_seconds, lambda: os._exit(124))
        timer.daemon = True
        timer.start()
    ids = json.loads(args.doc_ids_json)
    if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
        raise ValueError("doc_ids must be a string array")
    result = analyze_collection(args.collection_path, args.dataset_id, doc_ids=ids,
                                company_name=args.company_name, ingested_at=args.ingested_at)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
