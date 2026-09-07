#!/usr/bin/env python3
"""Run one PE ingestion job and persist UI-readable status atomically."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from llm_client import build_chat_client_from_env  # noqa: E402
from private_fund_directory_ingest import ingest_directory, result_to_dict  # noqa: E402


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_job(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--registry-path", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--dataset-name", required=True)
    parser.add_argument("--company-name", default="")
    parser.add_argument("--company-ticker", default="")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--job-file", required=True)
    args = parser.parse_args()

    workspace_root = Path(args.workspace_root).resolve()
    project_root = Path(args.project_root).resolve()
    registry_path = Path(args.registry_path).resolve()
    job_file = Path(args.job_file).resolve()
    base = {
        "jobId": args.job_id,
        "datasetId": args.dataset_id,
        "projectPath": str(project_root),
    }
    try:
        if project_root != workspace_root / args.dataset_id:
            raise ValueError("Registered project root does not match workspace and dataset ID")
        if registry_path != workspace_root.parent / "datasets.sqlite3":
            raise ValueError("Registered dataset registry is outside the PE workbench root")
        write_job(
            job_file,
            {
                **base,
                "status": "running",
                "message": "正在解析文档、提取内容并建立检索数据。",
                "startedAt": now_iso(),
            },
        )
        # One upstream identity for the whole job. Absent configuration leaves
        # the pipeline fully deterministic instead of failing the ingest.
        chat_client = build_chat_client_from_env()
        result = ingest_directory(
            directory_path=args.directory,
            workspace_root=args.workspace_root,
            registry_path=registry_path,
            dataset_id=args.dataset_id,
            dataset_name=args.dataset_name,
            company_name=args.company_name,
            company_ticker=args.company_ticker,
            recursive=True,
            reset=False,
            job_id=args.job_id,
            classification_llm=chat_client,
            claim_llm=chat_client,
        )
        write_job(
            job_file,
            {
                **base,
                "status": result.status,
                "message": result.message,
                "startedAt": result.started_at,
                "finishedAt": result.finished_at,
                "result": result_to_dict(result),
            },
        )
        return 1 if result.status == "failed" else 0
    except Exception as exc:  # noqa: BLE001
        write_job(
            job_file,
            {
                **base,
                "status": "failed",
                "message": str(exc),
                "finishedAt": now_iso(),
            },
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
