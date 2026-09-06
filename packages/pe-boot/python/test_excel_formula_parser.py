from __future__ import annotations

import unittest

from excel_formula_parser import extract_formula_references


class ExcelFormulaParserTest(unittest.TestCase):
    def test_extracts_local_cross_sheet_and_defined_name_references(self) -> None:
        references = extract_formula_references(
            "=SUM(B2:B4)+'DCF Model'!$H$42+Tax_Rate",
            source_sheet="Forecast",
            defined_names={"Tax_Rate"},
        )

        self.assertEqual(
            [
                (
                    reference.reference_kind,
                    reference.target_sheet,
                    reference.target_range,
                    reference.defined_name,
                    reference.parse_status,
                )
                for reference in references
            ],
            [
                ("range", "Forecast", "B2:B4", None, "resolved"),
                ("cell", "DCF Model", "$H$42", None, "resolved"),
                ("defined_name", None, None, "Tax_Rate", "deferred"),
            ],
        )

    def test_classifies_external_structured_and_error_references(self) -> None:
        references = extract_formula_references(
            "='[Peer.xlsx]Sheet 1'!A1+Table1[Revenue]+#REF!",
            source_sheet="Valuation",
        )

        self.assertEqual(references[0].reference_kind, "external_cell")
        self.assertEqual(references[0].external_workbook, "Peer.xlsx")
        self.assertEqual(references[0].target_sheet, "Sheet 1")
        self.assertEqual(references[0].target_range, "A1")
        self.assertEqual(references[0].parse_status, "external")
        self.assertEqual(references[1].reference_kind, "structured_reference")
        self.assertEqual(references[1].parse_status, "deferred")
        self.assertEqual(references[2].reference_kind, "error_reference")
        self.assertEqual(references[2].parse_status, "error")

    def test_ignores_text_literals_that_look_like_cell_references(self) -> None:
        references = extract_formula_references(
            '=IF(A1="B2", C3, 0)',
            source_sheet="Forecast",
        )

        self.assertEqual([reference.target_range for reference in references], ["A1", "C3"])


if __name__ == "__main__":
    unittest.main()
