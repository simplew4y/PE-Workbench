"""Tests for consensus/divergence cards built from atomic claims.

The numbers on a card are computed in code; these tests check them against a
hand-built sample of three brokers and the company, including a revision and
a low-quality claim that must stay out of the statistics.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from datetime import date
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from analysis_checklist import seed_universal_checklist  # noqa: E402
from atomic_claims import relink_revision_chains  # noqa: E402
from consensus_cards import (  # noqa: E402
    CARD_CONSENSUS,
    CARD_DIVERGENCE,
    CARD_SINGLE_VIEW,
    build_cards,
    build_consensus_cards,
    format_canonical,
    load_cards,
    template_narrative,
)
from issuer_identification import ensure_company_issuer, resolve_issuer  # noqa: E402
from private_fund_directory_ingest import ensure_collection_schema  # noqa: E402

DATASET = "dataset_test"
AS_OF = date(2026, 9, 6)

_OPEN: list[sqlite3.Connection] = []


def make_collection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_collection_schema(conn)
    seed_universal_checklist(conn, DATASET)
    ensure_company_issuer(conn, DATASET, "阳光电源")
    _OPEN.append(conn)
    return conn


def tearDownModule() -> None:
    for conn in _OPEN:
        conn.close()


def add_claim(
    conn: sqlite3.Connection,
    *,
    issuer: str,
    item_key: str,
    doc_id: str,
    as_of: str,
    value: float | None = None,
    unit: str = "亿元",
    canonical: float | None = None,
    canonical_unit: str = "元",
    currency: str = "CNY",
    period: str = "FY2026",
    measure: str = "level",
    stance: str = "bullish",
    reason: str = "",
    quality: str = "verified",
    text: str = "",
) -> str:
    issuer_key = "company" if issuer == "company" else resolve_issuer(conn, DATASET, issuer)[0]
    claim_id = f"clm_{issuer_key}_{item_key}_{doc_id}_{period}"
    if canonical is None and value is not None:
        canonical = value * 1e8 if canonical_unit == "元" else value
    conn.execute(
        """
        INSERT INTO atomic_claims (
            claim_id, dataset_id, doc_id, scan_id, item_key, issuer_key, claim_text, claim_type,
            stance, reason, measure, value_numeric, unit, currency, value_canonical, canonical_unit,
            period, period_canonical, confidence, evidence_ids_json, evidence_quotes_json,
            quality_status, status, as_of_date, published_date, window_index, extractor_version,
            created_at, updated_at
        ) VALUES (?, ?, ?, 'scan', ?, ?, ?, 'quantitative', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.8,
                  '["chunk:c1"]', '[{"evidence_id": "chunk:c1", "quote": "q"}]', ?, 'active', ?, ?, 0, 'v', ?, ?)
        """,
        (
            claim_id, DATASET, doc_id, item_key, issuer_key,
            text or f"{issuer} 预计 {item_key} {value} {unit}", stance, reason or f"{issuer} 的理由",
            measure, value, unit, currency if value is not None else None, canonical, canonical_unit if value is not None else None,
            period, period, quality, as_of, as_of, as_of, as_of,
        ),
    )
    return claim_id


def revenue_sample(conn: sqlite3.Connection) -> None:
    add_claim(conn, issuer="高盛", item_key="revenue", doc_id="d_gs", as_of="2026-08-20", value=239.8, reason="下半年出货快速放量")
    add_claim(conn, issuer="华泰证券", item_key="revenue", doc_id="d_htsc_1", as_of="2026-07-01", value=150.0)
    add_claim(conn, issuer="华泰证券", item_key="revenue", doc_id="d_htsc_2", as_of="2026-08-25", value=165.0, reason="上调")
    add_claim(conn, issuer="中金公司", item_key="revenue", doc_id="d_cicc", as_of="2026-08-10", value=140.0, stance="bearish", reason="供应与客户交付限制短期兑现")
    add_claim(conn, issuer="company", item_key="revenue", doc_id="d_co", as_of="2026-08-01", value=160.0, stance="neutral", reason="公司指引")
    add_claim(conn, issuer="国信证券", item_key="revenue", doc_id="d_guosen", as_of="2026-08-15", value=999.0, quality="review_required")
    relink_revision_chains(conn, DATASET)


class NumericCardTest(unittest.TestCase):
    def test_statistics_sides_and_type(self) -> None:
        conn = make_collection()
        revenue_sample(conn)

        cards = build_cards(conn, DATASET, as_of=AS_OF)
        card = next(c for c in cards if c.item_key == "revenue")

        self.assertEqual(card.card_type, CARD_DIVERGENCE)
        self.assertEqual(card.issuer_count, 3, "公司指引和低质量观点不进样本")
        self.assertEqual(card.coverage_total, 3)
        self.assertEqual(card.stats["median_display"], "165 亿元")
        self.assertEqual(card.stats["range_display"], "140 亿元 ~ 239.8 亿元")
        self.assertEqual(card.bull[0]["issuer_key"], "gs")
        self.assertAlmostEqual(card.bull[0]["deviation_from_median_pct"], 45.3, places=1)
        self.assertEqual(card.bear[0]["issuer_key"], "cicc")
        self.assertEqual(card.company_view["value_display"], "160 亿元")
        self.assertEqual(card.excluded_low_quality, 1)

    def test_only_the_latest_view_per_issuer_counts(self) -> None:
        conn = make_collection()
        revenue_sample(conn)
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "revenue")
        htsc = next(s for s in card.bull + card.bear if s["issuer_key"] == "htsc") if any(
            s["issuer_key"] == "htsc" for s in card.bull + card.bear
        ) else None
        values = {s["issuer_key"]: s["value_display"] for s in card.sources if s["issuer_key"] == "htsc"}
        self.assertEqual(card.stats["n"], 3)
        self.assertIn("165 亿元", values.values(), "来源里保留两份华泰报告")
        self.assertTrue(htsc is None or htsc["value_display"] == "165 亿元")

    def test_recent_changes_count_revisions_inside_the_window(self) -> None:
        conn = make_collection()
        revenue_sample(conn)
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "revenue")
        self.assertEqual((card.recent_changes["up"], card.recent_changes["down"]), (1, 0))
        self.assertEqual(card.recent_changes["items"][0]["issuer_key"], "htsc")
        self.assertEqual(card.recent_changes["items"][0]["delta_display"], "15 亿元")

        old = next(c for c in build_cards(conn, DATASET, as_of=date(2026, 12, 1)) if c.item_key == "revenue")
        self.assertEqual(old.recent_changes["up"], 0)

    def test_a_tight_sample_is_consensus(self) -> None:
        conn = make_collection()
        add_claim(conn, issuer="高盛", item_key="gross_margin", doc_id="a", as_of="2026-08-01", value=32.5, unit="%", canonical_unit="%", currency="")
        add_claim(conn, issuer="华泰证券", item_key="gross_margin", doc_id="b", as_of="2026-08-02", value=33.0, unit="%", canonical_unit="%", currency="")
        add_claim(conn, issuer="中金公司", item_key="gross_margin", doc_id="c", as_of="2026-08-03", value=31.5, unit="%", canonical_unit="%", currency="")
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "gross_margin")
        self.assertEqual(card.card_type, CARD_CONSENSUS)
        self.assertEqual(card.stats["median_display"], "32.5%")
        self.assertEqual(card.stats["spread_display"], "1.5pp")

    def test_mixed_currencies_are_not_averaged_together(self) -> None:
        conn = make_collection()
        add_claim(conn, issuer="高盛", item_key="revenue", doc_id="a", as_of="2026-08-01", value=20, unit="亿美元", currency="USD")
        add_claim(conn, issuer="华泰证券", item_key="revenue", doc_id="b", as_of="2026-08-02", value=150, unit="亿元")
        add_claim(conn, issuer="中金公司", item_key="revenue", doc_id="c", as_of="2026-08-03", value=160, unit="亿元")
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "revenue")
        self.assertEqual(card.stats["n"], 2)
        self.assertEqual(card.stats["excluded_unit_mismatch"], 1)
        self.assertEqual(card.stats["currency"], "CNY")


class StanceCardTest(unittest.TestCase):
    def test_qualitative_items_group_across_periods_and_split_by_stance(self) -> None:
        conn = make_collection()
        add_claim(conn, issuer="高盛", item_key="key_risks", doc_id="a", as_of="2026-08-01", period="", stance="bearish", reason="价格战")
        add_claim(conn, issuer="华泰证券", item_key="key_risks", doc_id="b", as_of="2026-08-02", period="FY2026", stance="bearish", reason="海外关税")
        add_claim(conn, issuer="中金公司", item_key="key_risks", doc_id="c", as_of="2026-08-03", period="", stance="bullish", reason="风险可控")
        cards = [c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "key_risks"]
        self.assertEqual(len(cards), 1)
        card = cards[0]
        self.assertEqual(card.card_type, CARD_DIVERGENCE)
        self.assertEqual(card.stance_counts, {"bullish": 1, "bearish": 2, "neutral": 0})
        self.assertEqual({e["issuer_key"] for e in card.bear}, {"gs", "htsc"})

    def test_one_issuer_is_a_single_view(self) -> None:
        conn = make_collection()
        add_claim(conn, issuer="高盛", item_key="target_price", doc_id="a", as_of="2026-08-01", value=2150, unit="EUR", canonical=2150, canonical_unit="元", currency="EUR", period="")
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "target_price")
        self.assertEqual(card.card_type, CARD_SINGLE_VIEW)
        self.assertEqual(card.issuer_count, 1)
        self.assertEqual([e["issuer_key"] for e in card.bull], ["gs"])
        self.assertEqual(card.bear, [], "只有一家机构时不列谨慎方")
        self.assertIn("仅 高盛 一家覆盖", template_narrative(card)["consensus_line"])


class NarrativeAndStorageTest(unittest.TestCase):
    def test_template_narrative_reads_from_the_numbers(self) -> None:
        conn = make_collection()
        revenue_sample(conn)
        card = next(c for c in build_cards(conn, DATASET, as_of=AS_OF) if c.item_key == "revenue")
        text = template_narrative(card)
        self.assertEqual(text["title"], "分歧：FY2026 营业收入预测与增速")
        self.assertIn("中位数 165 亿元", text["consensus_line"])
        self.assertIn("高盛（239.8 亿元）：下半年出货快速放量", text["bull_line"])
        self.assertIn("+45.3%", text["financial_impact"])
        self.assertIn("1 家上调，0 家下调", text["recent_changes_line"])

    def test_a_model_fills_the_prose_and_cards_are_stored(self) -> None:
        conn = make_collection()
        revenue_sample(conn)

        class Client:
            def chat(self, messages, *, max_tokens=None, temperature=None):
                briefs = json.loads(messages[1]["content"].split("卡片数据：\n", 1)[1])
                return json.dumps({"cards": [{
                    "card_id": b["card_id"], "title": "2026 年收入兑现速度",
                    "root_cause": "主要是 H2 销量和交付节奏，而非毛利率判断。",
                    "verification_evidence": "订单、产能、核心客户部署进度和 ASP",
                } for b in briefs]}, ensure_ascii=False)

        summary = build_consensus_cards(conn, DATASET, llm_client=Client(), company_name="阳光电源", as_of=AS_OF)

        self.assertEqual(summary["narrative_method"], "llm")
        self.assertEqual(summary["by_type"]["divergence"], 1)
        stored = load_cards(conn, DATASET, card_types=["divergence"])
        self.assertEqual(len(stored), 1)
        card = stored[0]
        self.assertEqual(card["title"], "2026 年收入兑现速度")
        self.assertEqual(card["narrative"]["root_cause"], "主要是 H2 销量和交付节奏，而非毛利率判断。")
        self.assertIn("中位数 165 亿元", card["narrative"]["consensus_line"], "模型没写的字段保留模板")
        self.assertEqual(card["sources"][0]["evidence_ids"], ["chunk:c1"])
        self.assertEqual(card["company_view"]["value_display"], "160 亿元")

    def test_a_model_failure_keeps_template_narratives(self) -> None:
        conn = make_collection()
        revenue_sample(conn)

        class Broken:
            def chat(self, messages, *, max_tokens=None, temperature=None):
                raise RuntimeError("timeout")

        summary = build_consensus_cards(conn, DATASET, llm_client=Broken(), as_of=AS_OF)
        self.assertEqual(summary["narrative_method"], "template_fallback")
        self.assertTrue(summary["errors"])
        self.assertEqual(len(load_cards(conn, DATASET)), 1)

    def test_rebuilding_replaces_old_cards(self) -> None:
        conn = make_collection()
        revenue_sample(conn)
        build_consensus_cards(conn, DATASET, llm_client=None, as_of=AS_OF)
        conn.execute("UPDATE atomic_claims SET status = 'withdrawn' WHERE doc_id = 'd_gs'")
        build_consensus_cards(conn, DATASET, llm_client=None, as_of=AS_OF)
        card = load_cards(conn, DATASET)[0]
        self.assertEqual(card["issuer_count"], 2)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM consensus_cards").fetchone()[0], 1)


class FormattingTest(unittest.TestCase):
    def test_canonical_amounts_render_in_analyst_units(self) -> None:
        self.assertEqual(format_canonical(1.65e10, "元", "CNY"), "165 亿元")
        self.assertEqual(format_canonical(2.4e8, "元", "USD"), "USD 240mn")
        self.assertEqual(format_canonical(32.5, "%"), "32.5%")
        self.assertEqual(format_canonical(36, "x"), "36x")


if __name__ == "__main__":
    unittest.main()
