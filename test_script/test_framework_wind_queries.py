"""本机 Horizon 实验测试，依赖 outputs/horizon-2026-10-13 研究资料。

这些资料不随代码提交；此文件不作为干净检出的独立 CI 验证。
运行前需准备 framework-state.json。
"""

import copy
import json
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from framework_wind_queries import build_framework_requests, quarter_periods
import print_hermes_wind_queries as command


FRAMEWORK = Path(__file__).resolve().parents[1] / "outputs/horizon-2026-10-13/framework-state.json"


class FrameworkWindTests(unittest.TestCase):
    def test_lists_every_quarter_across_years(self):
        periods = quarter_periods(date(2025, 1, 15), date(2026, 10, 15))
        self.assertEqual(len(periods), 8)
        for year in (2025, 2026):
            for number in "一二三四":
                self.assertEqual(sum(f"{year}年第{number}季度" in p for p in periods), 1)
        self.assertEqual(periods[0], "2025年第一季度（2025-01-01至2025-03-31）")
        self.assertEqual(periods[-1], "2026年第四季度（2026-10-01至2026-10-15，季度未结束）")

    def test_quarter_boundary_and_future_valuation(self):
        self.assertEqual(quarter_periods(date(2026, 6, 30), date(2026, 7, 1)), [
            "2026年第二季度（2026-04-01至2026-06-30）",
            "2026年第三季度（2026-07-01至2026-07-01，季度未结束）",
        ])
        with self.assertRaises(ValueError):
            quarter_periods(date(2027, 1, 1), date(2026, 10, 15))

    def test_horizon_uses_explicit_valuation_date_and_its_own_fields(self):
        framework = json.loads(FRAMEWORK.read_text(encoding="utf-8"))
        requests = build_framework_requests(framework, date(2026, 10, 15))
        all_queries = "\n".join(r["query"] for r in requests)
        self.assertIn("芯片出货量", all_queries)
        self.assertIn("研发费用", all_queries)
        self.assertIn("应收账款", all_queries)
        for request in requests:
            query = request["query"]
            self.assertIn("地平线机器人 Horizon Robotics", query)
            self.assertIn("证券代码：9660.HK", query)
            self.assertIn("估值基准日：2026-06-30", query)
            self.assertIn("2026年第二季度", query)
            self.assertIn("2026年第三季度", query)
            self.assertIn("2026年第四季度", query)
            self.assertIn("九个月累计", query)
            self.assertNotIn("2025-08-06", query)
            self.assertNotIn("Hermès", query)
            self.assertNotIn("失效条件", query)
            self.assertLessEqual(len(query.encode("utf-16-le")) // 2, 2000)

        missing_date = copy.deepcopy(framework)
        missing_date["context"].pop("valuation_date")
        with self.assertRaisesRegex(ValueError, "valuation_date"):
            build_framework_requests(missing_date, date(2026, 10, 15))

    def test_cli_sends_horizon_requests_without_printing_prompts(self):
        with patch.object(sys, "argv", ["script", "--framework", str(FRAMEWORK)]), patch.object(
            command.subprocess, "run", return_value=SimpleNamespace(returncode=0)
        ) as run:
            self.assertEqual(command.main(), 0)
            args, options = run.call_args
            requests = json.loads(options["input"])
            self.assertTrue(all("9660.HK" in r["query"] for r in requests))
            self.assertEqual(args[0][0], "node")
            self.assertNotIn("stdout", options)
            self.assertNotIn("stderr", options)


if __name__ == "__main__":
    unittest.main()
