"""Tests for issuer attribution and atomic claim extraction.

The model is replaced by a scripted client throughout. What matters here is the
grounding logic: a claim the pipeline cannot tie back to supplied evidence must
never reach the database, and one that is only partly verifiable must arrive
flagged rather than silently trusted.
"""

from __future__ import annotations

import sqlite3
import sys
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from analysis_checklist import (  # noqa: E402
    UNIVERSAL_CHECKLIST,
    ChecklistItem,
    SCOPE_COMPANY,
    active_checklist,
    record_discovered_items,
    seed_universal_checklist,
)
from atomic_claims import (  # noqa: E402
    QUALITY_QUOTE_UNVERIFIED,
    QUALITY_REVIEW_REQUIRED,
    QUALITY_VERIFIED,
    EvidenceItem,
    build_evidence_packet,
    extract_claims_for_document,
    pending_items_for_document,
    validate_claim,
)
from issuer_identification import (  # noqa: E402
    STATUS_NEEDS_REVIEW,
    STATUS_RESOLVED,
    identify_issuer,
    published_date_from,
    store_issuer,
)
from llm_client import extract_json_object, settings_from_env  # noqa: E402
from private_fund_directory_ingest import ensure_collection_schema  # noqa: E402

DATASET = "dataset_test"
DOC = "doc_test"

MARGIN_TEXT = (
    "华泰证券研究所。我们预计公司 2026 年毛利率为 32.5%，"
    "较 2025 年提升 3 个百分点，主要来自上游硅料价格回落。"
)
REVENUE_TEXT = (
    "华泰证券研究所。我们预计公司 2026 年营业收入达到 165.0 亿元，"
    "同比增长 28%，主要受益于下半年出货快速放量。"
)
UNRELATED_TEXT = "公司注册地址位于合肥市高新区，法定代表人未发生变更。"


class ScriptedChatClient:
    """Returns a canned reply per call and records the prompts it received."""

    def __init__(self, replies: list[str]) -> None:
        self._replies = list(replies)
        self.calls: list[list[dict[str, str]]] = []

    def chat(self, messages, *, max_tokens=None, temperature=None) -> str:
        self.calls.append(messages)
        if not self._replies:
            return '{"claims": []}'
        return self._replies.pop(0)


def make_collection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_collection_schema(conn)
    return conn


def add_document(conn: sqlite3.Connection, *, doc_id: str = DOC, filename: str = "华泰证券-深度报告.pdf") -> None:
    conn.execute(
        """
        INSERT INTO documents (
            doc_id, dataset_id, title, original_filename, stored_path, file_type,
            checksum, file_size, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pdf', 'abc', 1024, 'indexed', '2026-09-05', '2026-09-05')
        """,
        (doc_id, DATASET, filename, filename, f"/raw/{filename}"),
    )


def add_chunk(conn: sqlite3.Connection, index: int, content: str, *, doc_id: str = DOC, page: int = 1) -> str:
    chunk_id = f"chunk_{doc_id}_{index}"
    conn.execute(
        """
        INSERT INTO chunks (
            chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
            content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, 'text', ?, '2026-09-05')
        """,
        (chunk_id, DATASET, doc_id, index, content, f"hash{index}"),
    )
    conn.execute(
        """
        INSERT INTO chunk_locations (
            location_id, chunk_id, doc_id, location_index, page_start, page_end, display_text
        ) VALUES (?, ?, ?, 0, ?, ?, ?)
        """,
        (f"loc_{chunk_id}", chunk_id, doc_id, page, page, f"p.{page}"),
    )
    return chunk_id


class ChecklistTest(unittest.TestCase):
    def test_seeding_is_idempotent_and_discovery_appends(self) -> None:
        conn = make_collection()
        first = seed_universal_checklist(conn, DATASET)
        second = seed_universal_checklist(conn, DATASET)

        self.assertEqual(first, len(UNIVERSAL_CHECKLIST))
        self.assertEqual(second, 0)

        added = record_discovered_items(
            conn,
            DATASET,
            [
                ChecklistItem(
                    item_key="chip_shipment",
                    question="芯片出货量指引",
                    aliases=("出货量", "芯片"),
                    scope=SCOPE_COMPANY,
                )
            ],
            doc_id=DOC,
        )
        self.assertEqual([item.item_key for item in added], ["chip_shipment"])
        self.assertEqual(len(active_checklist(conn, DATASET)), len(UNIVERSAL_CHECKLIST) + 1)

    def test_a_universal_item_cannot_be_registered_as_discovered(self) -> None:
        conn = make_collection()
        with self.assertRaises(ValueError):
            record_discovered_items(
                conn, DATASET, [ChecklistItem(item_key="x", question="y")], doc_id=DOC
            )


class EvidencePacketTest(unittest.TestCase):
    def test_only_chunks_matching_the_question_enter_the_packet(self) -> None:
        conn = make_collection()
        add_document(conn)
        margin_chunk = add_chunk(conn, 0, MARGIN_TEXT)
        add_chunk(conn, 1, UNRELATED_TEXT, page=2)

        item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "gross_margin")
        packet = build_evidence_packet(conn, doc_id=DOC, item=item)

        self.assertEqual([entry.evidence_id for entry in packet], [f"chunk:{margin_chunk}"])
        self.assertEqual(packet[0].locator, "p.1")

    def test_metric_facts_join_the_packet_for_quantitative_questions(self) -> None:
        conn = make_collection()
        add_document(conn)
        add_chunk(conn, 0, REVENUE_TEXT)
        conn.execute(
            """
            INSERT INTO metric_facts (
                fact_id, dataset_id, doc_id, metric_name, metric_alias, period,
                value_text, value_numeric, unit, sheet_name, cell_ref
            ) VALUES ('fact_1', ?, ?, '营业收入', 'revenue', 'FY2026',
                      '165.0', 165.0, '亿元', '预测表', 'C12')
            """,
            (DATASET, DOC),
        )

        item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "revenue_growth")
        packet = build_evidence_packet(conn, doc_id=DOC, item=item)
        ids = {entry.evidence_id for entry in packet}

        self.assertIn("fact:fact_1", ids)
        self.assertTrue(any(entry.kind == "chunk" for entry in packet))


class ValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "gross_margin")
        self.evidence = [
            EvidenceItem(evidence_id="chunk:c1", kind="chunk", text=MARGIN_TEXT, locator="p.1")
        ]

    def test_a_well_grounded_claim_is_verified(self) -> None:
        claim = validate_claim(
            {
                "claim_text": "华泰预计 2026 年毛利率 32.5%",
                "reason": "上游硅料价格回落",
                "stance": "bullish",
                "value_numeric": 32.5,
                "unit": "%",
                "period": "FY2026",
                "confidence": 0.8,
                "evidence_ids": ["chunk:c1"],
                "evidence_quotes": [
                    {"evidence_id": "chunk:c1", "quote": "2026 年毛利率为 32.5%"}
                ],
            },
            item=self.item,
            evidence=self.evidence,
        )

        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_VERIFIED)
        self.assertEqual(claim.evidence_ids, ["chunk:c1"])
        self.assertAlmostEqual(claim.confidence, 0.8)

    def test_a_claim_citing_an_unknown_evidence_id_is_dropped(self) -> None:
        claim = validate_claim(
            {
                "claim_text": "编造的观点",
                "stance": "bullish",
                "evidence_ids": ["chunk:does_not_exist"],
                "evidence_quotes": [],
            },
            item=self.item,
            evidence=self.evidence,
        )
        self.assertIsNone(claim)

    def test_a_quote_absent_from_the_evidence_is_flagged_not_trusted(self) -> None:
        claim = validate_claim(
            {
                "claim_text": "华泰预计毛利率大幅改善",
                "stance": "bullish",
                "confidence": 0.95,
                "evidence_ids": ["chunk:c1"],
                "evidence_quotes": [
                    {"evidence_id": "chunk:c1", "quote": "毛利率将达到 45%，创历史新高"}
                ],
            },
            item=self.item,
            evidence=self.evidence,
        )

        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_REVIEW_REQUIRED)
        self.assertIn("quote_not_found_in_evidence", claim.quality_issues)
        self.assertLessEqual(claim.confidence, 0.4)

    def test_a_number_without_a_unit_cannot_be_aggregated(self) -> None:
        claim = validate_claim(
            {
                "claim_text": "华泰预计 2026 年毛利率 32.5",
                "stance": "neutral",
                "value_numeric": 32.5,
                "unit": "",
                "confidence": 0.9,
                "evidence_ids": ["chunk:c1"],
                "evidence_quotes": [
                    {"evidence_id": "chunk:c1", "quote": "2026 年毛利率为 32.5%"}
                ],
            },
            item=self.item,
            evidence=self.evidence,
        )

        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertIn("numeric_without_unit", claim.quality_issues)
        self.assertEqual(claim.quality_status, QUALITY_QUOTE_UNVERIFIED)

    def test_an_unknown_stance_falls_back_to_neutral(self) -> None:
        claim = validate_claim(
            {
                "claim_text": "华泰预计毛利率提升",
                "stance": "very-bullish",
                "evidence_ids": ["chunk:c1"],
                "evidence_quotes": [
                    {"evidence_id": "chunk:c1", "quote": "较 2025 年提升 3 个百分点"}
                ],
            },
            item=self.item,
            evidence=self.evidence,
        )
        assert claim is not None
        self.assertEqual(claim.stance, "neutral")
        self.assertIn("stance_defaulted", claim.quality_issues)


class IssuerTest(unittest.TestCase):
    def test_filename_and_header_resolve_the_issuer(self) -> None:
        result = identify_issuer(
            text="华泰证券研究所\n\n" + MARGIN_TEXT + "\n\n华泰证券股份有限公司 免责声明",
            filename="华泰证券-阳光电源-深度报告.pdf",
        )
        self.assertEqual(result.issuer_key, "htsc")
        self.assertEqual(result.status, STATUS_RESOLVED)

    def test_a_broker_only_discussed_in_the_body_is_not_the_issuer(self) -> None:
        body = "正文提到高盛的预测与我们不同。" * 3
        result = identify_issuer(
            text="中金公司研究部\n\n" + body + "\n\n中金公司 免责声明 中金公司",
            filename="中金公司-点评.pdf",
        )
        self.assertEqual(result.issuer_key, "cicc")
        self.assertEqual(result.status, STATUS_RESOLVED)

    def test_an_unattributable_document_needs_review(self) -> None:
        result = identify_issuer(text=UNRELATED_TEXT, filename="2025年年度报告.pdf")
        self.assertEqual(result.issuer_key, "")
        self.assertEqual(result.status, STATUS_NEEDS_REVIEW)

    def test_published_date_is_read_from_the_filename_or_header(self) -> None:
        self.assertEqual(published_date_from("", "华泰证券-点评-2026-08-14.pdf"), "2026-08-14")
        self.assertEqual(published_date_from("发布日期：2026年8月3日", ""), "2026-08-03")
        self.assertEqual(published_date_from("无日期", "报告.pdf"), "")


class ExtractionTest(unittest.TestCase):
    def _prepare(self) -> sqlite3.Connection:
        conn = make_collection()
        add_document(conn)
        add_chunk(conn, 0, MARGIN_TEXT)
        seed_universal_checklist(conn, DATASET)
        store_issuer(
            conn,
            dataset_id=DATASET,
            doc_id=DOC,
            identification=identify_issuer(
                text="华泰证券研究所 " + MARGIN_TEXT, filename="华泰证券-报告.pdf"
            ),
            published_date="2026-08-14",
        )
        return conn

    def test_extraction_stores_grounded_claims_and_skips_unasked_questions(self) -> None:
        conn = self._prepare()
        item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "gross_margin")
        chunk_id = f"chunk:chunk_{DOC}_0"
        client = ScriptedChatClient(
            [
                '{"claims": [{"claim_text": "华泰预计 2026 年毛利率 32.5%",'
                ' "reason": "硅料价格回落", "stance": "bullish", "value_numeric": 32.5,'
                ' "value_text": "32.5%", "unit": "%", "currency": "", "basis": "ratio",'
                ' "period": "FY2026", "scope": "base", "confidence": 0.82,'
                f' "evidence_ids": ["{chunk_id}"],'
                f' "evidence_quotes": [{{"evidence_id": "{chunk_id}",'
                ' "quote": "2026 年毛利率为 32.5%"}]}]}'
            ]
        )

        result = extract_claims_for_document(
            conn,
            dataset_id=DATASET,
            doc_id=DOC,
            llm_client=client,
            items=[item],
            company_name="阳光电源",
        )

        self.assertEqual(len(result.claims), 1)
        self.assertEqual(result.issuer_key, "htsc")
        row = conn.execute("SELECT * FROM atomic_claims").fetchone()
        self.assertEqual(row["issuer_key"], "htsc")
        self.assertEqual(row["quality_status"], QUALITY_VERIFIED)
        self.assertEqual(row["published_date"], "2026-08-14")

    def test_a_question_with_no_matching_evidence_never_reaches_the_model(self) -> None:
        conn = self._prepare()
        item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "target_price")
        client = ScriptedChatClient([])

        result = extract_claims_for_document(
            conn, dataset_id=DATASET, doc_id=DOC, llm_client=client, items=[item]
        )

        self.assertEqual(client.calls, [])
        self.assertEqual(result.items_skipped, 1)
        self.assertEqual(len(result.claims), 0)

    def test_rerunning_is_a_no_op_and_a_new_question_backfills_alone(self) -> None:
        conn = self._prepare()
        margin = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "gross_margin")
        chunk_id = f"chunk:chunk_{DOC}_0"
        reply = (
            '{"claims": [{"claim_text": "华泰预计 2026 年毛利率 32.5%", "stance": "bullish",'
            ' "value_numeric": 32.5, "unit": "%", "confidence": 0.8,'
            f' "evidence_ids": ["{chunk_id}"],'
            f' "evidence_quotes": [{{"evidence_id": "{chunk_id}",'
            ' "quote": "2026 年毛利率为 32.5%"}]}]}'
        )
        client = ScriptedChatClient([reply, reply])

        extract_claims_for_document(
            conn, dataset_id=DATASET, doc_id=DOC, llm_client=client, items=[margin]
        )
        calls_after_first = len(client.calls)
        extract_claims_for_document(
            conn, dataset_id=DATASET, doc_id=DOC, llm_client=client, items=[margin]
        )

        self.assertEqual(len(client.calls), calls_after_first, "已抽取过的问题不应重复调用模型")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM atomic_claims").fetchone()[0], 1)

        discovered = ChecklistItem(
            item_key="silicon_price",
            question="硅料价格走势",
            aliases=("硅料",),
            scope=SCOPE_COMPANY,
        )
        record_discovered_items(conn, DATASET, [discovered], doc_id=DOC)
        pending = pending_items_for_document(
            conn,
            dataset_id=DATASET,
            doc_id=DOC,
            items=active_checklist(conn, DATASET),
        )

        self.assertEqual([item.item_key for item in pending if item.item_key == "gross_margin"], [])
        self.assertIn("silicon_price", [item.item_key for item in pending])

    def test_a_model_failure_is_recorded_without_failing_the_document(self) -> None:
        conn = self._prepare()
        item = next(entry for entry in UNIVERSAL_CHECKLIST if entry.item_key == "gross_margin")

        class BrokenClient:
            def chat(self, messages, *, max_tokens=None, temperature=None) -> str:
                raise RuntimeError("gateway timeout")

        result = extract_claims_for_document(
            conn, dataset_id=DATASET, doc_id=DOC, llm_client=BrokenClient(), items=[item]
        )

        self.assertEqual(len(result.claims), 0)
        self.assertTrue(result.errors)
        run = conn.execute("SELECT * FROM claim_extraction_runs").fetchone()
        self.assertEqual(run["status"], "failed")
        # A failed run stays pending so the next ingest retries it.
        pending = pending_items_for_document(
            conn, dataset_id=DATASET, doc_id=DOC, items=[item]
        )
        self.assertEqual([entry.item_key for entry in pending], ["gross_margin"])


class IngestIntegrationTest(unittest.TestCase):
    def test_without_a_model_the_checklist_is_still_seeded(self) -> None:
        from private_fund_directory_ingest import _extract_atomic_claims

        conn = make_collection()
        add_document(conn)
        add_chunk(conn, 0, MARGIN_TEXT)

        summary = _extract_atomic_claims(
            conn, dataset_id=DATASET, doc_ids=[DOC], company_name="阳光电源", llm_client=None
        )

        self.assertEqual(summary["status"], "skipped_no_model")
        self.assertEqual(summary["checklist_items"], len(UNIVERSAL_CHECKLIST))
        self.assertEqual(len(active_checklist(conn, DATASET)), len(UNIVERSAL_CHECKLIST))

    def test_an_unattributable_document_is_skipped_before_any_model_call(self) -> None:
        from private_fund_directory_ingest import _extract_atomic_claims

        conn = make_collection()
        add_document(conn, filename="2025年年度报告.pdf")
        add_chunk(conn, 0, UNRELATED_TEXT)
        client = ScriptedChatClient(['{"issuer_key": "", "requires_review": true}'])

        summary = _extract_atomic_claims(
            conn, dataset_id=DATASET, doc_ids=[DOC], company_name="阳光电源", llm_client=client
        )

        self.assertEqual(summary["unattributed_skipped"], 1)
        self.assertEqual(summary["documents"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM claim_extraction_runs").fetchone()[0], 0)
        # The issuer attempt is recorded so a later manual fix has something to update.
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM document_issuers").fetchone()[0], 1)


class LlmClientTest(unittest.TestCase):
    def test_json_is_recovered_from_a_fenced_reply(self) -> None:
        value = extract_json_object('```json\n{"claims": [], "note": "ok"}\n```')
        self.assertEqual(value, {"claims": [], "note": "ok"})

    def test_prose_wrapped_json_is_recovered(self) -> None:
        value = extract_json_object('好的，结果如下：\n{"claims": []}\n以上。')
        self.assertEqual(value, {"claims": []})

    def test_an_unconfigured_environment_yields_no_settings(self) -> None:
        import os

        saved = {
            key: os.environ.pop(key, None)
            for key in ("PE_INGEST_LLM_BASE_URL", "PE_INGEST_LLM_API_KEY")
        }
        try:
            self.assertIsNone(settings_from_env())
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
