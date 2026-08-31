from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import fitz
from openpyxl import Workbook

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from private_fund_directory_ingest import ingest_directory  # noqa: E402


class PipelineSmokeTest(unittest.TestCase):
    def test_pdf_and_excel_create_a_pe_boot_compatible_collection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pe-ingest-smoke-") as temporary:
            root = Path(temporary)
            uploads = root / "_uploads" / "sungrow"
            uploads.mkdir(parents=True)

            pdf = fitz.open()
            page = pdf.new_page()
            page.insert_text((72, 72), "Sungrow revenue and energy storage margin improved in 2026.")
            pdf.save(uploads / "research.pdf")
            pdf.close()

            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Forecast"
            sheet.append(["Metric", "2025A", "2026E"])
            sheet.append(["Revenue", 1000, 1200])
            workbook.save(uploads / "valuation.xlsx")

            result = ingest_directory(
                directory_path=uploads,
                workspace_root=root,
                dataset_id="sungrow",
                dataset_name="Sungrow",
                company_name="Sungrow",
                company_ticker="300274",
                job_id="0123456789abcdef",
            )

            self.assertIn(result.status, {"completed", "completed_with_warnings"})
            database_path = root / "sungrow" / "meta" / "collection.sqlite3"
            self.assertTrue(database_path.is_file())
            with sqlite3.connect(database_path) as connection:
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
                    2,
                )
                self.assertGreater(
                    connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
                    0,
                )
                self.assertGreater(
                    connection.execute("SELECT COUNT(*) FROM excel_cells").fetchone()[0],
                    0,
                )


if __name__ == "__main__":
    unittest.main()
