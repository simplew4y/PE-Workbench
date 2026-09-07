from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from openpyxl import Workbook

from validate_workbook import validate_workbook
from workbook import parse_workbook


class WorkbookParserTest(unittest.TestCase):
    def create_xlsx(self, directory: Path) -> Path:
        path = directory / "model.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Forecast"
        sheet["A1"] = "Valuation Date"
        sheet["B1"] = "2026-09-07"
        sheet["A2"] = "Revenue"
        sheet["B2"] = 500
        sheet["B3"] = 700
        sheet["A4"] = "Target Price"
        sheet["B4"] = "=SUM(B2:B3)"
        hidden = workbook.create_sheet("Hidden")
        hidden.sheet_state = "hidden"
        workbook.save(path)
        workbook.close()
        return path

    def test_parses_formula_and_source_evidence_without_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = self.create_xlsx(Path(temporary))
            result = parse_workbook(dataset_id="dataset", doc_id="doc_" + "a" * 24, path=path)
            self.assertEqual(result["parser_name"], "openpyxl")
            self.assertEqual(result["sheet_count"], 2)
            self.assertEqual(result["formula_count"], 1)
            self.assertNotIn("chunks", result["tables"])
            formulas = [row for row in result["tables"]["excel_cells"] if row["is_formula"]]
            self.assertEqual(formulas[0]["formula"], "=SUM(B2:B3)")
            candidates = [row for row in result["tables"]["valuation_date_candidates"] if row["evidence_id"]]
            self.assertTrue(candidates)
            encoded = candidates[0]["evidence_id"].removeprefix("source:")
            payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            self.assertEqual(payload["doc_id"], "doc_" + "a" * 24)
            self.assertEqual(payload["sheet"], "Forecast")

    def test_validates_xlsx_and_xlsm_content_types(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            xlsx = self.create_xlsx(directory)
            xlsx_bytes = xlsx.read_bytes()
            validate_workbook(xlsx_bytes, "xlsx")
            with self.assertRaisesRegex(ValueError, "content type"):
                validate_workbook(xlsx_bytes, "xlsm")

            xlsm = directory / "model.xlsm"
            source_type = b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            macro_type = b"application/vnd.ms-excel.sheet.macroEnabled.main+xml"
            with zipfile.ZipFile(xlsx, "r") as source, zipfile.ZipFile(xlsm, "w", zipfile.ZIP_DEFLATED) as target:
                for entry in source.infolist():
                    data = source.read(entry.filename)
                    if entry.filename == "[Content_Types].xml":
                        data = data.replace(source_type, macro_type)
                    target.writestr(entry, data)
            validate_workbook(xlsm.read_bytes(), "xlsm")


if __name__ == "__main__":
    unittest.main()
