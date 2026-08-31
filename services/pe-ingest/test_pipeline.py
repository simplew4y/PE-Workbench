from __future__ import annotations

import sqlite3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import fitz
from openpyxl import Workbook

class PipelineSmokeTest(unittest.TestCase):
    def test_runner_rejects_a_project_root_that_does_not_match_the_dataset(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pe-ingest-path-guard-") as temporary:
            root = Path(temporary)
            workbench = root / "pe-workbench"
            projects = workbench / "projects"
            projects.mkdir(parents=True)
            job_file = root / "job.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parent / "run_job.py"),
                    "--directory", str(root / "uploads"),
                    "--workspace-root", str(projects),
                    "--project-root", str(projects / "dataset_other"),
                    "--registry-path", str(workbench / "datasets.sqlite3"),
                    "--dataset-id", "dataset_expected",
                    "--dataset-name", "Expected",
                    "--job-id", "fedcba9876543210",
                    "--job-file", str(job_file),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 1)
            job = json.loads(job_file.read_text(encoding="utf-8"))
            self.assertEqual(job["status"], "failed")
            self.assertIn("does not match", job["message"])

    def test_pdf_and_excel_create_a_pe_boot_compatible_collection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pe-ingest-smoke-") as temporary:
            root = Path(temporary)
            workbench = root / "pe-workbench"
            projects = workbench / "projects"
            uploads = workbench / "_uploads" / "dataset_sungrow"
            uploads.mkdir(parents=True)
            project_root = projects / "dataset_sungrow"
            (project_root / "raw").mkdir(parents=True)
            (project_root / "meta").mkdir()
            (project_root / "generated").mkdir()

            registry_path = workbench / "datasets.sqlite3"
            with sqlite3.connect(registry_path) as registry:
                registry.executescript(
                    """
                    CREATE TABLE datasets (
                        dataset_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                        status TEXT NOT NULL, source_dir TEXT,
                        dataset_root TEXT NOT NULL UNIQUE, company_name TEXT,
                        company_ticker TEXT, file_count INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                        metadata_json TEXT
                    );
                    CREATE TABLE dataset_state (
                        id INTEGER PRIMARY KEY CHECK(id = 1),
                        active_dataset_id TEXT, updated_at TEXT NOT NULL
                    );
                    """
                )
                registry.execute(
                    "INSERT INTO datasets VALUES (?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?)",
                    (
                        "dataset_sungrow", "Sungrow", str(project_root / "raw"),
                        str(project_root), "Sungrow", "300274",
                        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "{}",
                    ),
                )
                registry.execute(
                    "INSERT INTO dataset_state VALUES (1, 'dataset_sungrow', '2026-01-01T00:00:00Z')"
                )

            database_path = project_root / "meta" / "collection.sqlite3"
            with sqlite3.connect(database_path) as collection:
                collection.executescript(
                    """
                    CREATE TABLE project_metadata (
                        id INTEGER PRIMARY KEY CHECK(id = 1), dataset_id TEXT NOT NULL UNIQUE,
                        name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                    );
                    INSERT INTO project_metadata VALUES (
                        1, 'dataset_sungrow', 'Sungrow',
                        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                    );
                    """
                )

            pdf = fitz.open()
            page = pdf.new_page()
            page.insert_text((72, 72), "Sungrow revenue and energy storage margin improved in 2026.")
            pdf.save(uploads / "research.pdf")
            pdf.close()

            conflicting_pdf = fitz.open()
            conflicting_page = conflicting_pdf.new_page()
            conflicting_page.insert_text(
                (72, 72),
                "Acme Corporation annual report revenue increased in 2026.",
            )
            conflicting_pdf.save(uploads / "conflicting-company-annual-report.pdf")
            conflicting_pdf.close()

            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Forecast"
            sheet.append(["Metric", "2025A", "2026E"])
            sheet.append(["Revenue", 1000, 1200])
            workbook.save(uploads / "valuation.xlsx")

            job_file = project_root / "meta" / "ingest-ui-jobs" / "0123456789abcdef.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parent / "run_job.py"),
                    "--directory", str(uploads),
                    "--workspace-root", str(projects),
                    "--project-root", str(project_root),
                    "--registry-path", str(registry_path),
                    "--dataset-id", "dataset_sungrow",
                    "--dataset-name", "Sungrow",
                    "--company-name", "Sungrow",
                    "--company-ticker", "300274",
                    "--job-id", "0123456789abcdef",
                    "--job-file", str(job_file),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            job = json.loads(job_file.read_text(encoding="utf-8"))
            self.assertIn(job["status"], {"completed", "completed_with_warnings"})
            self.assertEqual(job["datasetId"], "dataset_sungrow")
            self.assertEqual(job["projectPath"], str(project_root))
            self.assertTrue(database_path.is_file())
            self.assertTrue((projects / "dataset_sungrow" / "raw" / "research.pdf").is_file())
            self.assertTrue((projects / "dataset_sungrow" / "generated").is_dir())
            self.assertTrue((workbench / "datasets.sqlite3").is_file())
            self.assertFalse((projects / "datasets.sqlite3").exists())
            with sqlite3.connect(database_path) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT dataset_id, name FROM project_metadata WHERE id = 1"
                    ).fetchone(),
                    ("dataset_sungrow", "Sungrow"),
                )
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
                    3,
                )
                self.assertGreater(
                    connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
                    0,
                )
                self.assertGreater(
                    connection.execute("SELECT COUNT(*) FROM excel_cells").fetchone()[0],
                    0,
                )
                classifications = connection.execute(
                    "SELECT original_filename, company_name, classification_status, status "
                    "FROM documents "
                    "ORDER BY original_filename"
                ).fetchall()
                self.assertEqual(len(classifications), 3)
                conflicting = next(
                    row for row in classifications
                    if row[0] == "conflicting-company-annual-report.pdf"
                )
                self.assertEqual(conflicting[1], "Acme Corporation")
                self.assertEqual(conflicting[2], "company_conflict")
                self.assertEqual(conflicting[3], "indexed")
                self.assertGreater(
                    connection.execute(
                        "SELECT COUNT(*) FROM chunks c JOIN documents d ON d.doc_id = c.doc_id "
                        "WHERE d.original_filename = 'conflicting-company-annual-report.pdf'"
                    ).fetchone()[0],
                    0,
                )
                self.assertTrue(all(row[3] == "indexed" for row in classifications))
            with sqlite3.connect(registry_path) as registry:
                self.assertEqual(
                    registry.execute(
                        "SELECT dataset_root, company_name, company_ticker, file_count "
                        "FROM datasets WHERE dataset_id = 'dataset_sungrow'"
                    ).fetchone(),
                    (str(project_root), "Sungrow", "300274", 3),
                )


if __name__ == "__main__":
    unittest.main()
