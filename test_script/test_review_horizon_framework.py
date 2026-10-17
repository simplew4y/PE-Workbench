"""本机 Horizon 实验测试，依赖 outputs/horizon-2026-10-13 研究资料。

这些资料不随代码提交；此文件不作为干净检出的独立 CI 验证。
运行前需准备 framework-state.json 和 horizon_修订估值模型_20261013.xlsx。
"""

import copy
import json
import unittest
from datetime import date
from pathlib import Path

from review_horizon_framework import ROOT, build_mapping, normalize_wind, read_model_cells


class HorizonReviewTests(unittest.TestCase):
    def test_mapping_covers_19_inputs_and_6_existing_sensitivities(self):
        source = ROOT / "outputs/horizon-2026-10-13"
        framework = json.loads((source / "framework-state.json").read_text())
        sheets = read_model_cells(source / "horizon_修订估值模型_20261013.xlsx")
        mapping = build_mapping(framework, sheets)
        self.assertEqual(len(mapping), 19)
        self.assertEqual(sum(bool(i["sensitivities"]) for i in mapping), 6)
        rd = next(i for i in mapping if i["assumption_id"] == "A6")
        self.assertEqual(rd["model_inputs"][0]["editable_cell"], "假设!B32")
        self.assertEqual(rd["model_inputs"][0]["value"], 3000)
        self.assertEqual(rd["model_inputs"][0]["direct_dependents"][0]["sheet"], "经营预测")
        self.assertEqual(rd["sensitivities"][0]["id"], "SEN2")

        wrong = copy.deepcopy(framework)
        wrong["assumptions"][0]["value"][0] += 1
        with self.assertRaisesRegex(ValueError, "不一致"):
            build_mapping(wrong, sheets)
        wrong["assumptions"][0]["value"] = [1]
        with self.assertRaisesRegex(ValueError, "期间"):
            build_mapping(wrong, sheets)

    def test_wind_preserves_units_nulls_and_excludes_future_dates(self):
        raw = json.dumps({"data": {"data": [{"columns": [
            {"name": "日期", "type": "date"}, {"name": "研发费用", "type": "number", "unit": "亿元"},
            {"name": "营业收入", "type": "number", "unit": "元"},
        ], "rows": [["2026-06-30", 27.55, None], ["2026-10-31", 99, 123]]}]}, "error": None})
        result = normalize_wind("没找到数据\n" + raw, date(2026, 10, 15))
        self.assertEqual(result["receipts"][0]["status"], "no_structured_data")
        first = result["evidence"][0]
        self.assertEqual(first["value_in_millions_of_original_currency"], 2755)
        self.assertIsNone(first["currency"])
        self.assertIn("single_vs_cumulative_unknown", first["flags"])
        self.assertIsNone(result["evidence"][1]["value"])
        self.assertTrue(all(i["excluded_from_assessment"] for i in result["evidence"] if i["observation_date"] == "2026-10-31"))

    def test_incomplete_current_quarter_is_not_a_confirmed_actual(self):
        raw = json.dumps({"data": {"data": [{"columns": [
            {"name": "日期", "type": "string"}, {"name": "每季BETA", "type": "number"},
        ], "rows": [["Q4 FY2026", 0.365]]}]}})
        self.assertTrue(normalize_wind(raw, date(2026, 10, 15))["evidence"][0]["excluded_from_assessment"])

    def test_daily_series_index_is_explicit_about_sampling(self):
        table = {"columns": [{"name": "日期", "type": "date"}, {"name": "汇率", "type": "number"}],
                 "rows": [[f"2026-07-{i:02}", i / 100] for i in range(1, 29)]}
        result = normalize_wind(json.dumps({"data": {"data": [table]}}), date(2026, 10, 15))
        coverage = result["receipts"][0]["table_index_coverage"][0]
        self.assertEqual(coverage["raw_rows"], 28)
        self.assertEqual(coverage["indexed_rows"], 2)
        self.assertTrue(coverage["full_raw_text_included"])


if __name__ == "__main__":
    unittest.main()
