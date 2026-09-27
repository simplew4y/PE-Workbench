from __future__ import annotations

import unicodedata
import unittest
from datetime import date, datetime, timezone

from excel_date_candidates import (
    extract_cell_date_candidate,
    extract_filename_date,
    workbook_property_date_candidate,
)


class ExcelDateCandidatesTest(unittest.TestCase):
    def test_excludes_explicitly_negated_dates_but_keeps_the_evidence(self) -> None:
        for value in (
            "This is not a valuation date: 2026-08-31",
            "2026-08-31 is not the valuation date",
            "Not used as a valuation date: 2026-08-31",
            "Valuation date is not 2026-08-31",
            "这不是估值日：2026-08-31",
            "2026-08-31 并非估值基准日",
            "不作为估值日期：2026-08-31",
            "非估值日：2026-08-31",
        ):
            with self.subTest(value=value):
                candidate = extract_cell_date_candidate(value)
                assert candidate is not None
                self.assertEqual(candidate.role, "valuation_date")
                self.assertEqual(candidate.normalized_date, "2026-08-31")
                self.assertEqual(candidate.assertion_status, "negated")
                self.assertEqual(candidate.rejection_reason, "date_assertion_negated")
                self.assertEqual(candidate.priority_score, 0.0)
                self.assertEqual(candidate.confidence, 0.0)
                self.assertEqual(candidate.raw_text, unicodedata.normalize("NFKC", value))

    def test_keeps_unconfirmed_and_provisional_dates_for_review_only(self) -> None:
        for value in (
            "Valuation date not confirmed: 2026-08-31",
            "Valuation date is not yet confirmed: 2026-08-31",
            "Unconfirmed valuation date: 2026-08-31",
            "Tentative valuation date: 2026-08-31",
            "Provisional valuation date: 2026-08-31",
            "Valuation date: 2026-08-31 (pending confirmation)",
            "Valuation date: 2026-08-31 (not final)",
            "Valuation Date TBC: 2026-08-31",
            "Valuation_Date_TBD: 2026-08-31",
            "估值日未确认：2026-08-31",
            "估值基准日尚未确认：2026-08-31",
            "估值日期待确认：2026-08-31",
            "暂定估值日：2026-08-31",
            "估值日（暂定）：2026-08-31",
            "估值日不确定：2026-08-31",
            "估值日未最终确定：2026-08-31",
        ):
            with self.subTest(value=value):
                candidate = extract_cell_date_candidate(value)
                assert candidate is not None
                self.assertEqual(candidate.role, "valuation_date")
                self.assertEqual(candidate.normalized_date, "2026-08-31")
                self.assertEqual(candidate.assertion_status, "unconfirmed")
                self.assertEqual(candidate.rejection_reason, "date_assertion_unconfirmed")
                self.assertLessEqual(candidate.confidence, 0.5)
                self.assertEqual(candidate.priority_score, 0.0)

    def test_qualifications_on_neighbor_labels_apply_to_native_dates(self) -> None:
        for label, status in (
            ("Not a Valuation Date", "negated"),
            ("不是估值日", "negated"),
            ("Valuation Date not confirmed", "unconfirmed"),
            ("估值日（暂定）", "unconfirmed"),
            ("Unconfirmed_Valuation_Date", "unconfirmed"),
        ):
            for labels in ({"row_label": label}, {"col_label": label}, {"row_label": "Valuation Date", "col_label": label}):
                with self.subTest(label=label, labels=labels):
                    candidate = extract_cell_date_candidate(date(2026, 8, 31), **labels)
                    assert candidate is not None
                    self.assertEqual(candidate.assertion_status, status)
                    self.assertEqual(candidate.rejection_reason, f"date_assertion_{status}")
                    self.assertIn(unicodedata.normalize("NFKC", label), candidate.label_context or "")

    def test_a_bare_date_can_qualify_its_own_neighboring_role(self) -> None:
        for label in ("Valuation Date", "As of"):
            for value in ("2026-08-31 (tentative)", "not confirmed: 2026-08-31", "2026-08-31（待确认）"):
                with self.subTest(label=label, value=value):
                    candidate = extract_cell_date_candidate(value, row_label=label)
                    assert candidate is not None
                    self.assertEqual(candidate.assertion_status, "unconfirmed")
                    self.assertEqual(candidate.rejection_reason, "date_assertion_unconfirmed")

    def test_does_not_apply_unrelated_negation_or_uncertainty_to_a_date(self) -> None:
        for value in (
            "Valuation date: 2026-08-31, WACC not confirmed",
            "Valuation date: 2026-08-31; forecasts not confirmed",
            "Valuation date: 2026-08-31, not a forecast",
            "No change to valuation date: 2026-08-31",
            "Do not change valuation date: 2026-08-31",
            "Valuation date is not expected to change: 2026-08-31",
            "Not only the valuation date: 2026-08-31",
            "估值日：2026-08-31，折现率未确认",
            "估值日未发生变更：2026-08-31",
        ):
            with self.subTest(value=value):
                candidate = extract_cell_date_candidate(value)
                assert candidate is not None
                self.assertEqual(candidate.assertion_status, "affirmed")
                self.assertIsNone(candidate.rejection_reason)
                self.assertGreaterEqual(candidate.confidence, 0.95)

    def test_qualifications_also_apply_to_other_date_roles(self) -> None:
        for value, role, status in (
            ("Not a market price date: 2026-08-31", "market_price_date", "negated"),
            ("Report date not confirmed: 2026-08-31", "report_publication_date", "unconfirmed"),
            ("Target price date (tentative): 2026-08-31", "target_horizon_end", "unconfirmed"),
            ("基准日（待确认）：2026-08-31", "valuation_date", "unconfirmed"),
        ):
            with self.subTest(value=value):
                candidate = extract_cell_date_candidate(value)
                assert candidate is not None
                self.assertEqual(candidate.role, role)
                self.assertEqual(candidate.assertion_status, status)
                self.assertEqual(candidate.rejection_reason, f"date_assertion_{status}")

    def test_ignores_numeric_disclaimers_and_formula_literals(self) -> None:
        for value in (
            "Opinions are as of the report and subject to change over the next 12 months.",
            "Valuation Date: version 12",
            '=IF(A1="2026-08-31",1,0)',
            '=DATE(2026,8,31)',
        ):
            with self.subTest(value=value):
                self.assertIsNone(extract_cell_date_candidate(value, row_label="Valuation Date"))

    def test_uses_the_most_specific_date_role(self) -> None:
        for label, role in (
            ("Target price date", "target_horizon_end"),
            ("Target_Price_Date", "target_horizon_end"),
            ("Share Price as of", "market_price_date"),
            ("Financial data as of", "financial_data_as_of"),
        ):
            with self.subTest(label=label):
                candidate = extract_cell_date_candidate("2026-08-31", row_label=label)
                assert candidate is not None
                self.assertEqual(candidate.role, role)

    def test_scopes_the_label_to_the_date_clause(self) -> None:
        candidate = extract_cell_date_candidate(
            "Valuation date is unavailable; financial data as of 2025-12-31"
        )
        assert candidate is not None
        self.assertEqual(candidate.role, "financial_data_as_of")
        self.assertEqual(candidate.matched_text, "2025-12-31")
        self.assertNotIn("Valuation date", candidate.label_context or "")

    def test_retains_an_explicit_date_inside_a_long_narrative(self) -> None:
        candidate = extract_cell_date_candidate(
            "This report contains estimates and limitations. " * 20
            + "Valuation Date: 2026-08-31; forecasts may change."
        )
        assert candidate is not None
        self.assertEqual(candidate.role, "valuation_date")
        self.assertEqual(candidate.normalized_date, "2026-08-31")
        self.assertLessEqual(len(candidate.label_context or ""), 121)

    def test_does_not_combine_labels_across_cells(self) -> None:
        candidate = extract_cell_date_candidate(
            "2026-08-31", row_label="Valuation", col_label="Date"
        )
        assert candidate is not None
        self.assertEqual(candidate.role, "unknown")

    def test_does_not_inherit_a_neighbor_with_its_own_date(self) -> None:
        candidate = extract_cell_date_candidate(
            "2026-08-31", row_label="Valuation Date 2025-08-31"
        )
        assert candidate is not None
        self.assertEqual(candidate.role, "unknown")

    def test_keeps_conflicting_neighbor_roles_unresolved(self) -> None:
        candidate = extract_cell_date_candidate(
            "2026-08-31", row_label="Valuation Date", col_label="Target price date"
        )
        assert candidate is not None
        self.assertEqual(candidate.role, "unknown")
        self.assertEqual(candidate.role_method, "conflicting_neighbor_labels")

    def test_keeps_two_independent_inline_roles_unresolved(self) -> None:
        candidate = extract_cell_date_candidate("Valuation date / report date: 2026-08-31")
        assert candidate is not None
        self.assertEqual(candidate.role, "unknown")
        self.assertEqual(candidate.role_method, "conflicting_date_labels")

    def test_does_not_inherit_a_role_from_the_previous_sentence(self) -> None:
        candidate = extract_cell_date_candidate("Valuation date is unavailable. Report date: 2026-08-31")
        assert candidate is not None
        self.assertEqual(candidate.role, "report_publication_date")

    def test_does_not_pick_the_first_of_multiple_dates(self) -> None:
        candidate = extract_cell_date_candidate(
            "Report date 2026-08-31; Valuation Date 2026-08-30"
        )
        assert candidate is not None
        self.assertIsNone(candidate.normalized_date)
        self.assertEqual(candidate.rejection_reason, "multiple_dates_require_review")

    def test_preserves_invalid_calendar_dates_for_review(self) -> None:
        candidate = extract_cell_date_candidate("Valuation Date 2025-02-30")
        assert candidate is not None
        self.assertIsNone(candidate.normalized_date)
        self.assertEqual(candidate.ambiguity, "invalid_calendar_date")

    def test_equal_numeric_day_and_month_are_unambiguous(self) -> None:
        candidate = extract_cell_date_candidate("Valuation Date 08/08/2026")
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2026-08-08")
        self.assertIsNone(candidate.ambiguity)

    def test_parses_filename_dates_without_fabricating_january_first(self) -> None:
        for filename, expected, precision in (
            ("NVIDIA_NVDA.OQ_2025_Jul_15.xlsm", "2025-07-15", "day"),
            ("Horizon_9660.HK_2025_Aug_06.xlsx", "2025-08-06", "day"),
            ("HERMES_HRMS.PA_2025_Jun_30.xlsm", "2025-06-30", "day"),
            ("model_20250831.xlsx", "2025-08-31", "day"),
            ("model_2025年8月31日.xlsx", "2025-08-31", "day"),
            ("model_2025.xlsx", "2025", "year"),
        ):
            with self.subTest(filename=filename):
                candidate = extract_filename_date(filename)
                assert candidate is not None
                self.assertEqual(candidate.normalized_date, expected)
                self.assertEqual(candidate.date_precision, precision)
                self.assertEqual(candidate.rejection_reason, "filename_cannot_verify_valuation_date")

    def test_does_not_fallback_from_invalid_or_conflicting_filename_dates(self) -> None:
        for filename in (
            "model_2025-02-30.xlsx",
            "model_01-02-2025.xlsx",
            "model_2025-08-31_2025-09-01.xlsx",
            "model_2025_2026.xlsx",
            "model_1783838815979.xlsx",
        ):
            with self.subTest(filename=filename):
                self.assertIsNone(extract_filename_date(filename))

    def test_classifies_explicit_valuation_date_from_neighbor_label(self) -> None:
        candidate = extract_cell_date_candidate(
            datetime(2026, 8, 31, 15, 30),
            row_label="估值基准日",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2026-08-31")
        self.assertEqual(candidate.role, "valuation_date")
        self.assertEqual(candidate.parse_method, "excel_datetime")
        self.assertGreaterEqual(candidate.confidence, 0.95)
        self.assertIsNone(candidate.rejection_reason)

    def test_parses_english_date_and_market_price_role(self) -> None:
        candidate = extract_cell_date_candidate(
            "Share Price as of 31-Aug-2026",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2026-08-31")
        self.assertEqual(candidate.role, "market_price_date")
        self.assertEqual(candidate.parse_method, "day_month_name_text")

    def test_normalizes_defined_name_style_labels(self) -> None:
        candidate = extract_cell_date_candidate(
            "2026-08-31",
            row_label="Valuation_Date",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.role, "valuation_date")
        self.assertTrue(candidate.role_method.startswith("explicit_label:"))

    def test_preserves_ambiguous_numeric_date_without_normalizing_it(self) -> None:
        candidate = extract_cell_date_candidate(
            "Valuation Date 01/02/2026",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertIsNone(candidate.normalized_date)
        self.assertEqual(candidate.ambiguity, "day_month_order")
        self.assertEqual(candidate.rejection_reason, "ambiguous_date_text_requires_review")

    def test_preserves_explicit_but_unsupported_date_text_as_a_gap(self) -> None:
        candidate = extract_cell_date_candidate("Valuation Date 31/8/26")

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertIsNone(candidate.normalized_date)
        self.assertEqual(candidate.role, "valuation_date")
        self.assertEqual(candidate.parse_method, "unparsed_text")
        self.assertEqual(candidate.rejection_reason, "date_text_could_not_be_normalized")

    def test_rejects_forecast_period_as_valuation_date(self) -> None:
        candidate = extract_cell_date_candidate("2030E", col_label="Forecast")

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.role, "forecast_period")
        self.assertTrue(candidate.is_forecast)
        self.assertIsNone(candidate.normalized_date)
        self.assertEqual(candidate.rejection_reason, "forecast_period_is_not_valuation_date")

    def test_rejects_full_date_under_a_forecast_context(self) -> None:
        candidate = extract_cell_date_candidate(
            "2029-12-31",
            col_label="Forecast",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2029-12-31")
        self.assertEqual(candidate.role, "forecast_period")
        self.assertTrue(candidate.is_forecast)

    def test_generic_cutoff_is_financial_data_date_not_valuation_date(self) -> None:
        candidate = extract_cell_date_candidate("截至 2025-12-31")

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2025-12-31")
        self.assertEqual(candidate.role, "financial_data_as_of")

    def test_workbook_property_is_low_priority_metadata(self) -> None:
        candidate = workbook_property_date_candidate(
            date(2026, 9, 2),
            role="file_modified_at",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2026-09-02")
        self.assertEqual(candidate.priority_score, 0.02)
        self.assertEqual(
            candidate.rejection_reason,
            "workbook_property_cannot_verify_valuation_date",
        )

    def test_timezone_does_not_change_a_workbook_property_calendar_date(self) -> None:
        candidate = workbook_property_date_candidate(
            datetime(2026, 8, 31, 23, 30, tzinfo=timezone.utc),
            role="file_modified_at",
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.normalized_date, "2026-08-31")


if __name__ == "__main__":
    unittest.main()
