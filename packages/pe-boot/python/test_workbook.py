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
            self.assertEqual(payload, ["doc_" + "a" * 24, "excel", "Forecast", "B1"])
            self.assertTrue(any("1 个公式结果暂时无法读取" in warning and "Forecast!B4" in warning for warning in result["warnings"]))

    def test_saved_formula_results_and_missing_caches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = self.create_xlsx(directory)
            for missing in (False, True):
                path = directory / f"cached-{missing}.xlsx"
                cells = (
                    '<c r="A1" t="str"><f>IF(1,"","")</f><v></v></c>'
                    '<c r="B1" t="str"><f>"#heading"</f><v>#heading</v></c>'
                    '<c r="C1" t="n"><f>1-1</f><v>0</v></c>'
                    '<c r="D1" t="b"><f>1=2</f><v>0</v></c>'
                    '<c r="E1" t="str"><f>"=text"</f><v>=text</v></c>'
                    '<c r="F1" t="n"><f>UnknownName</f><v>42</v></c>'
                )
                if missing:
                    cells += '<c r="G1"><f>1+1</f><v></v></c><c r="H1" t="e"><f>1/0</f><v>#DIV/0!</v></c>'
                with zipfile.ZipFile(original) as source, zipfile.ZipFile(path, "w") as target:
                    for entry in source.infolist():
                        data = source.read(entry.filename)
                        if entry.filename == "xl/worksheets/sheet1.xml":
                            data = ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                                    f'<sheetData><row r="1">{cells}</row></sheetData></worksheet>').encode()
                        target.writestr(entry, data)
                result = parse_workbook(dataset_id="dataset", doc_id="doc", path=path)
                rows = {row["cell_ref"]: row for row in result["tables"]["excel_cells"]}
                for ref in ("A1", "B1", "C1", "D1", "E1", "F1"):
                    self.assertEqual(rows[ref]["formula_cache_status"], "present", ref)
                self.assertEqual(rows["A1"]["cached_value"], "")
                self.assertEqual(rows["A1"]["display_value"], "")
                self.assertIsNone(rows["A1"]["numeric_value"])
                self.assertEqual(rows["C1"]["numeric_value"], 0)
                self.assertTrue(any(row["parse_status"] != "resolved" for row in result["tables"]["excel_formula_references"]))
                if missing:
                    self.assertEqual(rows["G1"]["formula_cache_status"], "missing")
                    self.assertEqual(rows["H1"]["formula_cache_status"], "error")
                    self.assertEqual(len(result["warnings"]), 1)
                    self.assertIn("2 个公式结果暂时无法读取", result["warnings"][0])
                    self.assertIn("Forecast!G1、Forecast!H1", result["warnings"][0])
                else:
                    self.assertEqual(result["warnings"], [])

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
