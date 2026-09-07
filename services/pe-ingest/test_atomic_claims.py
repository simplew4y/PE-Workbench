"""Tests for the single-scan claim pipeline: discovery, attribution, history.

The model is replaced by a scripted client throughout. What matters here is
the deterministic half of the design: a claim the pipeline cannot tie back to
supplied evidence never reaches the database, numbers are canonicalized in
code rather than by the model, proposals become checklist items without
re-reading documents, and an institution's later view is linked to its earlier
one.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent / "pipeline"
sys.path.insert(0, str(PIPELINE_DIR))

from analysis_checklist import (  # noqa: E402
    ORIGIN_DISCOVERED,
    UNIVERSAL_CHECKLIST,
    active_checklist,
    ensure_checklist_schema,
    make_proposal,
    pending_proposals,
    record_proposals,
    resolve_pending_proposals,
    seed_universal_checklist,
)
from atomic_claims import (  # noqa: E402
    CLAIM_ACTIVE,
    CLAIM_REPLACED,
    CLAIM_SUPERSEDED,
    SCAN_PARTIAL,
    QUALITY_QUOTE_UNVERIFIED,
    QUALITY_REVIEW_REQUIRED,
    QUALITY_VERIFIED,
    REVISION_DOWN,
    REVISION_NEW,
    REVISION_UP,
    EvidenceItem,
    build_windows,
    ensure_claims_schema,
    pending_scan,
    relink_revision_chains,
    scan_document,
    scan_documents,
    validate_claim,
)
from issuer_identification import (  # noqa: E402
    AS_OF_INGESTED,
    AS_OF_PUBLISHED,
    COMPANY_ISSUER_KEY,
    DATE_SOURCE_FILENAME,
    DATE_SOURCE_INGEST_METADATA,
    DATE_SOURCE_LABELED,
    DATE_SOURCE_MODEL,
    KIND_COMPANY,
    METHOD_MANUAL,
    STATUS_NEEDS_REVIEW,
    STATUS_RESOLVED,
    as_of_from,
    identify_issuer,
    ensure_issuer_schema,
    issuer_for_document,
    published_date_from,
    resolve_issuer,
    set_issuer_manually,
)
from llm_client import extract_json_object, settings_from_env  # noqa: E402
from private_fund_directory_ingest import ensure_collection_schema  # noqa: E402
from value_normalization import normalize_period, normalize_value  # noqa: E402

DATASET = "dataset_test"
DOC = "doc_test"
INGESTED_AT = "2026-09-06T02:00:00+00:00"

MARGIN_TEXT = (
    "华泰证券研究所。我们预计公司 2026 年毛利率为 32.5%，"
    "较 2025 年提升 3 个百分点，主要来自上游硅料价格回落。"
)
REVENUE_TEXT = (
    "我们预计公司 2026 年营业收入达到 165.0 亿元，"
    "同比增长 28%，主要受益于下半年出货快速放量。"
)
CHIP_TEXT = "我们预计 2026 年 AI 芯片出货量达到 120 万颗，主要客户为头部云厂商。"
UNRELATED_TEXT = "公司注册地址位于合肥市高新区，法定代表人未发生变更。"

RESOLUTION_MARKER = "维护一份投研分析问题清单"


class ScriptedChatClient:
    """Replies per scan window in order; proposal resolution has its own reply."""

    model = "scripted"

    def __init__(self, replies: list[str], resolution_reply: str = '{"decisions": []}') -> None:
        self._replies = list(replies)
        self._resolution_reply = resolution_reply
        self.calls: list[list[dict[str, str]]] = []
        self.resolution_calls = 0

    def chat(self, messages, *, max_tokens=None, temperature=None) -> str:
        self.calls.append(messages)
        if RESOLUTION_MARKER in messages[0]["content"]:
            self.resolution_calls += 1
            return self._resolution_reply
        if not self._replies:
            return '{"claims": [], "proposed_items": []}'
        return self._replies.pop(0)


_OPEN_CONNECTIONS: list[sqlite3.Connection] = []


def make_collection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_collection_schema(conn)
    _OPEN_CONNECTIONS.append(conn)
    return conn


def tearDownModule() -> None:
    for conn in _OPEN_CONNECTIONS:
        conn.close()


class SchemaMigrationTest(unittest.TestCase):
    def test_v1_analysis_tables_upgrade_in_place(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        _OPEN_CONNECTIONS.append(conn)
        conn.executescript(
            """
            CREATE TABLE analysis_checklist_items (
                item_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, item_key TEXT NOT NULL,
                question TEXT NOT NULL, aliases_json TEXT, metric_key TEXT, basis_hint TEXT,
                claim_type TEXT NOT NULL DEFAULT 'quantitative', scope TEXT NOT NULL DEFAULT 'universal',
                origin TEXT NOT NULL DEFAULT 'preset', status TEXT NOT NULL DEFAULT 'active',
                checklist_version INTEGER NOT NULL DEFAULT 1, preset_version TEXT,
                discovered_from_doc_id TEXT, metadata_json TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX idx_checklist_dataset_key
                ON analysis_checklist_items(dataset_id, item_key);
            CREATE TABLE atomic_claims (
                claim_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, doc_id TEXT NOT NULL,
                item_key TEXT NOT NULL, issuer_key TEXT, claim_text TEXT NOT NULL,
                claim_type TEXT NOT NULL, stance TEXT NOT NULL, reason TEXT,
                value_numeric REAL, value_text TEXT, unit TEXT, currency TEXT,
                basis TEXT, period TEXT, scope TEXT, confidence REAL NOT NULL DEFAULT 0,
                evidence_ids_json TEXT NOT NULL, evidence_quotes_json TEXT,
                quality_status TEXT NOT NULL DEFAULT 'review_required', quality_issues_json TEXT,
                published_date TEXT, extractor_version TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX idx_atomic_claims_item
                ON atomic_claims(dataset_id, item_key, quality_status);
            CREATE TABLE document_issuers (
                doc_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, issuer_key TEXT,
                issuer_name TEXT, confidence REAL NOT NULL DEFAULT 0,
                method TEXT NOT NULL DEFAULT 'not_detected',
                status TEXT NOT NULL DEFAULT 'needs_review', candidates_json TEXT,
                evidence_json TEXT, published_date TEXT, detector_version TEXT NOT NULL,
                llm_error TEXT, updated_at TEXT NOT NULL
            );
            INSERT INTO analysis_checklist_items VALUES (
                'old-item', 'dataset_test', 'revenue_growth', '营收增长', '[]', '', 'amount',
                'quantitative', 'universal', 'preset', 'active', 1, 'v1', NULL, NULL,
                '2026-01-01', '2026-01-01'
            );
            INSERT INTO atomic_claims VALUES (
                'old-claim', 'dataset_test', 'doc_test', 'revenue_growth', 'htsc',
                '预计营收 165 亿元', 'quantitative', 'bullish', '需求增长', 165, '165',
                '亿元', 'CNY', 'amount', '2026E', '', 0.8, '["chunk:old"]', '[]',
                'verified', NULL, '2026-08-14', 'pe_atomic_claims_v1', '2026-08-14T00:00:00Z'
            );
            INSERT INTO document_issuers VALUES (
                'doc_test', 'dataset_test', 'htsc', '华泰证券', 0.9, 'rules', 'resolved',
                '[]', '[]', '2026-08-14', 'v1', NULL, '2026-08-14T00:00:00Z'
            );
            """
        )

        ensure_checklist_schema(conn)
        ensure_claims_schema(conn)
        ensure_issuer_schema(conn)
        seed_universal_checklist(conn, DATASET)

        claim = conn.execute(
            """
            SELECT item_key, scan_id, status, value_canonical, canonical_unit,
                   period_canonical, as_of_date, updated_at
            FROM atomic_claims WHERE claim_id = 'old-claim'
            """
        ).fetchone()
        self.assertEqual(claim["item_key"], "revenue")
        self.assertEqual(claim["scan_id"], "legacy:old-claim")
        self.assertEqual(claim["status"], "active")
        self.assertEqual(claim["value_canonical"], 16_500_000_000)
        self.assertEqual(claim["canonical_unit"], "元")
        self.assertEqual(claim["period_canonical"], "FY2026")
        self.assertEqual(claim["as_of_date"], "2026-08-14")
        self.assertTrue(claim["updated_at"])
        self.assertIsNone(conn.execute(
            "SELECT 1 FROM analysis_checklist_items WHERE item_key = 'revenue_growth'"
        ).fetchone())
        self.assertIsNotNone(conn.execute(
            "SELECT 1 FROM analysis_checklist_items WHERE item_key = 'revenue'"
        ).fetchone())
        issuer = conn.execute("SELECT issuer_name FROM issuers WHERE issuer_key = 'htsc'").fetchone()
        self.assertEqual(issuer["issuer_name"], "华泰证券")


def add_document(
    conn: sqlite3.Connection,
    *,
    doc_id: str = DOC,
    filename: str = "华泰证券-深度报告.pdf",
    doc_subtype: str = "broker_company_report",
) -> None:
    conn.execute(
        """
        INSERT INTO documents (
            doc_id, dataset_id, title, original_filename, stored_path, file_type,
            doc_subtype, checksum, file_size, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pdf', ?, 'abc', 1024, 'indexed', '2026-09-05', '2026-09-05')
        """,
        (doc_id, DATASET, filename, filename, f"/raw/{filename}", doc_subtype),
    )


def add_chunk(
    conn: sqlite3.Connection,
    index: int,
    content: str,
    *,
    doc_id: str = DOC,
    page: int = 1,
    content_type: str = "pdf_page",
) -> str:
    chunk_id = f"chunk_{doc_id}_{index}"
    conn.execute(
        """
        INSERT INTO chunks (
            chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
            content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-05')
        """,
        (chunk_id, DATASET, doc_id, index, content, content_type, f"hash{index}"),
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


def replace_with_current_pdf_pages(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TABLE pdf_pages")
    conn.execute(
        """
        CREATE TABLE pdf_pages (
            page_id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            page_text TEXT NOT NULL,
            page_header TEXT NOT NULL,
            role TEXT NOT NULL
        )
        """
    )


def add_page(
    conn: sqlite3.Connection,
    index: int,
    content: str,
    *,
    doc_id: str = DOC,
    role: str = "body",
    header: str = "",
) -> str:
    page_id = f"page_{doc_id}_{index}"
    conn.execute(
        """
        INSERT INTO pdf_pages (page_id, doc_id, page_number, page_text, page_header, role)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (page_id, doc_id, index + 1, content, header, role),
    )
    return page_id


def evidence_id(doc_id: str, index: int) -> str:
    return f"chunk:chunk_{doc_id}_{index}"


def claim_json(
    *,
    item_key: str,
    text: str,
    evidence: str,
    quote: str,
    value: float | None = None,
    unit: str = "",
    period: str = "",
    stance: str = "bullish",
    measure: str = "level",
    confidence: float = 0.8,
) -> dict:
    return {
        "item_key": item_key,
        "claim_text": text,
        "reason": "测试",
        "stance": stance,
        "measure": measure,
        "value_numeric": value,
        "unit": unit,
        "currency": "",
        "period": period,
        "scope_note": "",
        "confidence": confidence,
        "evidence_ids": [evidence],
        "evidence_quotes": [{"evidence_id": evidence, "quote": quote}],
    }


def window_reply(
    claims: list[dict],
    *,
    document: dict | None = None,
    proposed_items: list[dict] | None = None,
) -> str:
    payload: dict = {"claims": claims, "proposed_items": proposed_items or []}
    if document is not None:
        payload["document"] = document
    return json.dumps(payload, ensure_ascii=False)


HTSC_DOCUMENT = {
    "issuer_name": "华泰证券研究所",
    "issuer_kind": "sell_side",
    "issuer_confidence": 0.95,
    "issuer_evidence": ["页眉华泰证券研究所"],
    "published_date": "2026-08-14",
    "title": "深度报告",
    "analysts": [],
}


# ---------------------------------------------------------------- normalization


class ValueNormalizationTest(unittest.TestCase):
    def test_amounts_share_one_canonical_scale_and_keep_currency_apart(self) -> None:
        yi = normalize_value(165, "亿元")
        mn = normalize_value(16500, "百万元")
        usd = normalize_value(2.4, "亿美元")
        self.assertEqual(yi.value_canonical, 165e8)
        self.assertEqual(mn.value_canonical, yi.value_canonical)
        self.assertEqual((yi.canonical_unit, yi.currency), ("元", "CNY"))
        self.assertEqual((usd.canonical_unit, usd.currency), ("元", "USD"))

    def test_percent_points_and_multiples_are_distinct_units(self) -> None:
        self.assertEqual(normalize_value(32.5, "%").canonical_unit, "%")
        self.assertEqual(normalize_value(3, "个百分点").canonical_unit, "pp")
        self.assertEqual(normalize_value(50, "bps").value_canonical, 0.5)
        self.assertEqual(normalize_value(25, "倍").canonical_unit, "x")

    def test_prices_and_volumes_are_kept_verbatim(self) -> None:
        self.assertEqual(normalize_value(0.35, "元/Wh").canonical_unit, "元/wh")
        self.assertEqual(normalize_value(120, "GW").value_canonical, 120)
        self.assertEqual(normalize_value(35.5, "元/股").canonical_unit, "元/股")

    def test_periods(self) -> None:
        for raw, expected in (
            ("2026E", "FY2026"),
            ("FY26", "FY2026"),
            ("2026年", "FY2026"),
            ("2026H2", "2026H2"),
            ("2026年下半年", "2026H2"),
            ("3Q26", "2026Q3"),
            ("2026年第三季度", "2026Q3"),
            ("2026-2028", "FY2026-FY2028"),
            ("未来三年", "未来三年"),
        ):
            self.assertEqual(normalize_period(raw), expected, raw)


# ---------------------------------------------------------------- checklist


class ChecklistTest(unittest.TestCase):
    def test_seeding_is_idempotent(self) -> None:
        conn = make_collection()
        self.assertEqual(seed_universal_checklist(conn, DATASET), len(UNIVERSAL_CHECKLIST))
        self.assertEqual(seed_universal_checklist(conn, DATASET), 0)

    def test_proposals_become_items_without_a_model(self) -> None:
        conn = make_collection()
        seed_universal_checklist(conn, DATASET)
        proposal = make_proposal(
            dataset_id=DATASET, doc_id=DOC, key="ai_chip_shipments", question="AI 芯片出货量",
            scope="company", claim_type="quantitative", value_kind="volume",
        )
        assert proposal is not None
        record_proposals(conn, DATASET, [proposal])
        self.assertEqual(len(pending_proposals(conn, DATASET)), 1)

        resolution = resolve_pending_proposals(conn, DATASET, llm_client=None)

        self.assertEqual(resolution.created_items, ["ai_chip_shipments"])
        self.assertEqual(resolution.mapping, {(DOC, "ai_chip_shipments"): "ai_chip_shipments"})
        self.assertEqual(pending_proposals(conn, DATASET), [])
        created = next(i for i in active_checklist(conn, DATASET) if i.item_key == "ai_chip_shipments")
        self.assertEqual(created.origin, ORIGIN_DISCOVERED)
        self.assertEqual(created.support_doc_count, 1)

    def test_a_model_can_fold_a_proposal_into_an_existing_item(self) -> None:
        conn = make_collection()
        seed_universal_checklist(conn, DATASET)
        proposal = make_proposal(
            dataset_id=DATASET, doc_id=DOC, key="gpm_trend", question="毛利率趋势",
            scope="company", claim_type="quantitative",
        )
        assert proposal is not None
        record_proposals(conn, DATASET, [proposal])
        client = ScriptedChatClient(
            [], resolution_reply='{"decisions": [{"proposed_key": "gpm_trend", "item_key": "gross_margin"}]}'
        )

        resolution = resolve_pending_proposals(conn, DATASET, llm_client=client)

        self.assertEqual(resolution.mapping, {(DOC, "gpm_trend"): "gross_margin"})
        self.assertEqual(resolution.created_items, [])
        self.assertEqual(resolution.merged_into_existing, 1)
        self.assertEqual(len(active_checklist(conn, DATASET)), len(UNIVERSAL_CHECKLIST))


# ---------------------------------------------------------------- issuers


class IssuerRegistryTest(unittest.TestCase):
    def test_spellings_of_one_house_share_a_key(self) -> None:
        conn = make_collection()
        names = ("华泰证券研究所", "HTSC", "华泰研究", "华泰证券股份有限公司")
        self.assertEqual({resolve_issuer(conn, DATASET, name)[0] for name in names}, {"htsc"})

    def test_an_unknown_house_is_registered_once(self) -> None:
        conn = make_collection()
        first = resolve_issuer(conn, DATASET, "甬兴证券研究所")
        second = resolve_issuer(conn, DATASET, "甬兴证券")
        self.assertEqual(first, second)
        self.assertTrue(first[0].startswith("iss_"))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM issuers").fetchone()[0], 1)

    def test_a_company_named_like_a_broker_is_not_the_broker(self) -> None:
        conn = make_collection()
        key, _name = resolve_issuer(conn, DATASET, "中金黄金股份有限公司")
        self.assertNotEqual(key, "cicc")

    def test_company_documents_are_attributed_to_the_company(self) -> None:
        conn = make_collection()
        result = identify_issuer(
            conn, DATASET, text=UNRELATED_TEXT, filename="2025年年度报告.pdf",
            doc_subtype="annual_report", company_name="阳光电源",
        )
        self.assertEqual(result.issuer_key, COMPANY_ISSUER_KEY)
        self.assertEqual(result.issuer_kind, KIND_COMPANY)
        self.assertEqual(result.status, STATUS_RESOLVED)

    def test_the_model_reading_of_the_cover_wins_and_registers(self) -> None:
        conn = make_collection()
        result = identify_issuer(
            conn, DATASET, text="正文提到高盛的预测。", filename="report.pdf",
            doc_subtype="broker_company_report",
            model_document={"issuer_name": "中泰证券研究所", "issuer_kind": "sell_side", "issuer_confidence": 0.9},
        )
        self.assertEqual(result.issuer_key, "zts")
        self.assertEqual(result.status, STATUS_RESOLVED)

    def test_rules_alone_need_filename_and_header(self) -> None:
        conn = make_collection()
        strong = identify_issuer(
            conn, DATASET, filename="华泰证券-阳光电源-深度报告.pdf",
            text="华泰证券研究所\n\n" + MARGIN_TEXT + "\n\n华泰证券股份有限公司 免责声明",
        )
        weak = identify_issuer(conn, DATASET, filename="阳光电源点评.pdf", text="华泰证券研究所 " + MARGIN_TEXT)
        self.assertEqual((strong.issuer_key, strong.status), ("htsc", STATUS_RESOLVED))
        self.assertEqual((weak.issuer_key, weak.status), ("htsc", STATUS_NEEDS_REVIEW))

    def test_a_manual_attribution_survives_rescans(self) -> None:
        conn = make_collection()
        add_document(conn)
        add_chunk(conn, 0, MARGIN_TEXT)
        seed_universal_checklist(conn, DATASET)
        set_issuer_manually(conn, dataset_id=DATASET, doc_id=DOC, issuer_name="国信证券")
        client = ScriptedChatClient([window_reply([], document=HTSC_DOCUMENT)])

        scan_document(conn, dataset_id=DATASET, doc_id=DOC, llm_client=client,
                      items=active_checklist(conn, DATASET), ingested_at=INGESTED_AT)

        row = issuer_for_document(conn, DOC)
        self.assertEqual(row["issuer_key"], "guosen")
        self.assertEqual(row["method"], METHOD_MANUAL)


class DateTest(unittest.TestCase):
    def test_a_labeled_date_beats_the_fiscal_period_on_the_cover(self) -> None:
        text = "阳光电源 2025年12月31日 财务数据摘要 ... 报告日期：2026年8月14日"
        self.assertEqual(
            published_date_from(text, "点评.pdf", ingested_at=INGESTED_AT), ("2026-08-14", DATE_SOURCE_LABELED)
        )

    def test_an_unlabeled_cover_date_is_not_trusted(self) -> None:
        self.assertEqual(
            published_date_from("2025年12月31日 资产负债表", "点评.pdf", ingested_at=INGESTED_AT), ("", "")
        )

    def test_model_then_filename_fallbacks(self) -> None:
        self.assertEqual(
            published_date_from("无日期", "点评.pdf", model_date="2026-08-03", ingested_at=INGESTED_AT),
            ("2026-08-03", DATE_SOURCE_MODEL),
        )
        self.assertEqual(
            published_date_from("无日期", "华泰-点评-20260814.pdf", ingested_at=INGESTED_AT),
            ("2026-08-14", DATE_SOURCE_FILENAME),
        )

    def test_english_labeled_dates(self) -> None:
        text = "BERNSTEIN FLASHMAIL 27 May 2026 ... First Published: 27 May 2026 10:31 UTC"
        self.assertEqual(published_date_from(text, "x.pdf", ingested_at=INGESTED_AT), ("2026-05-27", DATE_SOURCE_LABELED))
        self.assertEqual(
            published_date_from("Published May 3, 2026", "x.pdf", ingested_at=INGESTED_AT), ("2026-05-03", DATE_SOURCE_LABELED)
        )

    def test_future_dates_are_rejected(self) -> None:
        self.assertEqual(published_date_from("报告日期 2027-01-01", "x.pdf", ingested_at=INGESTED_AT), ("", ""))

    def test_ingestion_metadata_precedes_the_model_cover_date(self) -> None:
        self.assertEqual(
            published_date_from(
                "",
                "x.pdf",
                metadata_date="2026-09-04",
                model_date="2026-09-05",
                ingested_at=INGESTED_AT,
            ),
            ("2026-09-04", DATE_SOURCE_INGEST_METADATA),
        )

    def test_as_of_falls_back_to_the_ingest_day(self) -> None:
        self.assertEqual(as_of_from("2026-08-14", INGESTED_AT), ("2026-08-14", AS_OF_PUBLISHED))
        self.assertEqual(as_of_from("", INGESTED_AT), ("2026-09-06", AS_OF_INGESTED))


# ---------------------------------------------------------------- windows and validation


class WindowTest(unittest.TestCase):
    def test_current_pdf_pages_use_resolvable_page_evidence(self) -> None:
        conn = make_collection()
        add_document(conn)
        replace_with_current_pdf_pages(conn)
        first = add_page(conn, 0, MARGIN_TEXT, role="cover", header="华泰证券 | 2026-09-05")
        second = add_page(conn, 1, REVENUE_TEXT)

        windows, truncated = build_windows(conn, DOC)

        self.assertFalse(truncated)
        self.assertEqual(
            [entry.evidence_id for entry in windows[0].evidence],
            [f"page:{first}", f"page:{second}"],
        )
        self.assertEqual(windows[0].evidence[0].locator, "p.1 | cover | 华泰证券 | 2026-09-05")

    def test_chunks_are_packed_in_order_and_capped(self) -> None:
        conn = make_collection()
        add_document(conn)
        for index in range(6):
            add_chunk(conn, index, f"第{index}段。" + "内容" * 40, page=index + 1)

        windows, truncated = build_windows(conn, DOC, window_chars=200, max_windows=2)

        self.assertEqual(len(windows), 2)
        self.assertTrue(truncated)
        self.assertEqual(windows[0].evidence[0].evidence_id, evidence_id(DOC, 0))
        self.assertEqual(windows[0].evidence[0].locator, "p.1")
        self.assertEqual(windows[1].evidence[0].evidence_id, evidence_id(DOC, len(windows[0].evidence)))


    def test_a_pdf_page_is_read_once_and_metadata_is_skipped(self) -> None:
        conn = make_collection()
        add_document(conn)
        add_chunk(conn, 0, "PDF document: x.pdf\nPages: 1", content_type="pdf_document_summary")
        add_chunk(conn, 1, MARGIN_TEXT, content_type="pdf_page")
        add_chunk(conn, 2, MARGIN_TEXT + "\n" + REVENUE_TEXT, content_type="pdf_speaker_turn")
        add_chunk(conn, 3, REVENUE_TEXT, content_type="pdf_page", page=2)

        windows, _truncated = build_windows(conn, DOC)

        self.assertEqual(
            [entry.evidence_id for entry in windows[0].evidence],
            [evidence_id(DOC, 1), evidence_id(DOC, 3)],
        )

    def test_current_document_schema_scans_without_legacy_doc_subtype(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        _OPEN_CONNECTIONS.append(conn)
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                doc_type TEXT,
                company_name TEXT,
                brokerage TEXT,
                document_date TEXT,
                lifecycle_state TEXT NOT NULL DEFAULT 'active',
                deleted_at TEXT
            );
            CREATE TABLE pdf_pages (
                page_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                page_text TEXT NOT NULL,
                page_header TEXT NOT NULL,
                role TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            INSERT INTO documents (
                doc_id, dataset_id, original_filename, file_type, doc_type,
                company_name, brokerage, document_date
            ) VALUES (?, ?, '华泰证券-深度报告.pdf', 'pdf', 'research_report', '测试公司', '华泰证券', '2026-09-05')
            """,
            (DOC, DATASET),
        )
        page_id = add_page(conn, 0, REVENUE_TEXT, role="cover", header="华泰证券")
        reply = window_reply(
            [
                claim_json(
                    item_key="revenue",
                    text="预计 2026 年营收 165 亿元",
                    evidence=f"page:{page_id}",
                    quote="2026 年营业收入达到 165.0 亿元",
                    value=165,
                    unit="亿元",
                    period="2026",
                )
            ],
            document={"issuer_name": "另一家机构", "issuer_confidence": "invalid"},
        )

        result = scan_document(
            conn,
            dataset_id=DATASET,
            doc_id=DOC,
            llm_client=ScriptedChatClient([reply]),
            items=UNIVERSAL_CHECKLIST,
            company_name="测试公司",
            ingested_at=INGESTED_AT,
        )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.issuer_key, "htsc")
        self.assertEqual(result.claims[0].evidence_ids, [f"page:{page_id}"])


class ValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.items = {item.item_key: item for item in UNIVERSAL_CHECKLIST}
        self.evidence = [EvidenceItem(evidence_id="chunk:c1", text=REVENUE_TEXT, locator="p.1")]
        proposal = make_proposal(
            dataset_id=DATASET, doc_id=DOC, key="ai_chip_shipments", question="AI 芯片出货量",
            scope="company", claim_type="quantitative", value_kind="volume",
        )
        assert proposal is not None
        self.proposals = {"ai_chip_shipments": proposal}

    def _validate(self, raw: dict):
        return validate_claim(raw, items_by_key=self.items, proposals_by_key=self.proposals, evidence=self.evidence)

    def test_a_grounded_forecast_is_verified_and_canonicalized(self) -> None:
        claim = self._validate(claim_json(
            item_key="revenue", text="华泰预计 2026 年营收 165 亿元", evidence="chunk:c1",
            quote="2026 年营业收入达到 165.0 亿元", value=165, unit="亿元", period="2026E",
        ))
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_VERIFIED)
        self.assertEqual(claim.value_canonical, 165e8)
        self.assertEqual((claim.canonical_unit, claim.currency), ("元", "CNY"))
        self.assertEqual(claim.period_canonical, "FY2026")
        self.assertEqual(claim.proposed_key, "")

    def test_a_claim_under_a_proposed_question_is_kept_and_marked(self) -> None:
        claim = self._validate(claim_json(
            item_key="ai_chip_shipments", text="出货 120 万颗", evidence="chunk:c1",
            quote="下半年出货快速放量", value=120, unit="万颗", period="2026",
        ))
        assert claim is not None
        self.assertEqual(claim.item_key, "ai_chip_shipments")
        self.assertEqual(claim.proposed_key, "ai_chip_shipments")

    def test_unknown_question_or_fabricated_evidence_drops_the_claim(self) -> None:
        self.assertIsNone(self._validate(claim_json(
            item_key="not_a_question", text="x", evidence="chunk:c1", quote="下半年出货快速放量",
        )))
        self.assertIsNone(self._validate(claim_json(
            item_key="revenue", text="编造", evidence="chunk:nope", quote="下半年出货快速放量",
        )))

    def test_a_quote_absent_from_the_evidence_is_flagged_not_trusted(self) -> None:
        claim = self._validate(claim_json(
            item_key="revenue", text="营收大增", evidence="chunk:c1", quote="营业收入将翻倍增长至 300 亿元",
            confidence=0.95,
        ))
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_REVIEW_REQUIRED)
        self.assertIn("quote_not_found_in_evidence", claim.quality_issues)
        self.assertLessEqual(claim.confidence, 0.4)

    def test_a_partly_verified_claim_is_quote_unverified(self) -> None:
        raw = claim_json(item_key="revenue", text="营收", evidence="chunk:c1", quote="165.0 亿元")
        raw["evidence_quotes"].append({"evidence_id": "chunk:c1", "quote": "这句话不在证据里出现"})
        claim = self._validate(raw)
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_QUOTE_UNVERIFIED)

    def test_a_number_without_a_unit_needs_review(self) -> None:
        claim = self._validate(claim_json(
            item_key="revenue", text="营收 165", evidence="chunk:c1", quote="165.0 亿元", value=165, unit="",
        ))
        assert claim is not None
        self.assertIn("numeric_without_unit", claim.quality_issues)
        self.assertEqual(claim.quality_status, QUALITY_REVIEW_REQUIRED)

    def test_a_currency_stands_in_for_a_missing_unit(self) -> None:
        raw = claim_json(item_key="target_price", text="目标价 2150 欧元", evidence="chunk:c1", quote="165.0 亿元", value=2150)
        raw["currency"] = "EUR"
        claim = self._validate(raw)
        assert claim is not None
        self.assertNotIn("numeric_without_unit", claim.quality_issues)
        self.assertEqual((claim.canonical_unit, claim.currency, claim.value_canonical), ("元", "EUR", 2150))
        euro = claim_json(item_key="target_price", text="目标价", evidence="chunk:c1", quote="165.0 亿元", value=2150, unit="€")
        self.assertEqual(self._validate(euro).currency, "EUR")

    def test_typographic_quotes_do_not_break_quote_verification(self) -> None:
        evidence = [EvidenceItem(evidence_id="chunk:c1", text="could push Hermès in a “classic corner” – a risk", locator="p.9")]
        claim = validate_claim(
            claim_json(item_key="key_risks", text="x", evidence="chunk:c1", quote='push Hermès in a "classic corner" - a risk'),
            items_by_key=self.items, proposals_by_key={}, evidence=evidence,
        )
        assert claim is not None
        self.assertEqual(claim.quality_status, QUALITY_VERIFIED)

    def test_a_number_missing_from_its_quote_needs_review(self) -> None:
        claim = self._validate(claim_json(
            item_key="revenue", text="营收 180 亿元", evidence="chunk:c1", quote="2026 年营业收入达到 165.0 亿元",
            value=180, unit="亿元", period="2026E",
        ))
        assert claim is not None
        self.assertIn("value_not_in_quote", claim.quality_issues)
        self.assertEqual(claim.quality_status, QUALITY_REVIEW_REQUIRED)
        ok = self._validate(claim_json(
            item_key="revenue", text="营收", evidence="chunk:c1", quote="2026 年营业收入达到 165.0 亿元",
            value=165, unit="亿元", period="2026E",
        ))
        self.assertEqual(ok.quality_status, QUALITY_VERIFIED)

    def test_a_forecast_without_a_period_is_flagged(self) -> None:
        claim = self._validate(claim_json(
            item_key="revenue", text="营收 165 亿", evidence="chunk:c1", quote="165.0 亿元", value=165, unit="亿元",
        ))
        assert claim is not None
        self.assertIn("period_missing", claim.quality_issues)


# ---------------------------------------------------------------- scanning


class ScanTest(unittest.TestCase):
    def _prepare(self, *, doc_id: str = DOC, filename: str = "华泰证券-深度报告.pdf") -> sqlite3.Connection:
        conn = make_collection()
        add_document(conn, doc_id=doc_id, filename=filename)
        add_chunk(conn, 0, MARGIN_TEXT, doc_id=doc_id)
        add_chunk(conn, 1, REVENUE_TEXT, doc_id=doc_id, page=2)
        add_chunk(conn, 2, CHIP_TEXT, doc_id=doc_id, page=3)
        seed_universal_checklist(conn, DATASET)
        return conn

    def _htsc_reply(self, doc_id: str, *, revenue: float = 165, with_proposal: bool = True) -> str:
        claims = [
            claim_json(
                item_key="gross_margin", text="华泰预计 2026 年毛利率 32.5%", evidence=evidence_id(doc_id, 0),
                quote="2026 年毛利率为 32.5%", value=32.5, unit="%", period="2026E",
            ),
            claim_json(
                item_key="revenue", text=f"华泰预计 2026 年营收 {revenue} 亿元", evidence=evidence_id(doc_id, 1),
                quote="下半年出货快速放量", value=revenue, unit="亿元", period="2026E",
            ),
        ]
        proposals = []
        if with_proposal:
            claims.append(claim_json(
                item_key="ai_chip_shipments", text="华泰预计 2026 年 AI 芯片出货 120 万颗",
                evidence=evidence_id(doc_id, 2), quote="AI 芯片出货量达到 120 万颗", value=120, unit="万颗",
                period="2026E", measure="volume",
            ))
            proposals = [{
                "key": "ai_chip_shipments", "question": "AI 芯片出货量", "scope": "company",
                "claim_type": "quantitative", "value_kind": "volume", "rationale": "核心驱动",
            }]
        return window_reply(claims, document=HTSC_DOCUMENT, proposed_items=proposals)

    def test_one_scan_stores_issuer_date_claims_and_ledger(self) -> None:
        conn = self._prepare()
        client = ScriptedChatClient([self._htsc_reply(DOC)])

        result = scan_document(conn, dataset_id=DATASET, doc_id=DOC, llm_client=client,
                               items=active_checklist(conn, DATASET), company_name="阳光电源",
                               ingested_at=INGESTED_AT)

        self.assertEqual(len(client.calls), 1, "三个 chunk 应合并成一个窗口，一次调用")
        self.assertEqual(result.issuer_key, "htsc")
        self.assertEqual(len(result.claims), 3)
        self.assertEqual([p.proposed_key for p in result.proposals], ["ai_chip_shipments"])

        issuer = issuer_for_document(conn, DOC)
        self.assertEqual((issuer["status"], issuer["published_date"], issuer["as_of_source"]),
                         (STATUS_RESOLVED, "2026-08-14", AS_OF_PUBLISHED))
        rows = conn.execute("SELECT * FROM atomic_claims ORDER BY item_key").fetchall()
        self.assertEqual([r["issuer_key"] for r in rows], ["htsc"] * 3)
        self.assertEqual({r["as_of_date"] for r in rows}, {"2026-08-14"})
        revenue = next(r for r in rows if r["item_key"] == "revenue")
        self.assertEqual(revenue["value_canonical"], 165e8)
        self.assertEqual(revenue["status"], CLAIM_ACTIVE)
        scan = conn.execute("SELECT * FROM document_scans").fetchone()
        self.assertEqual((scan["status"], scan["window_count"], scan["claim_count"], scan["proposal_count"]),
                         ("completed", 1, 3, 1))

    def test_the_first_window_carries_the_document_block_and_later_windows_do_not(self) -> None:
        conn = self._prepare()
        client = ScriptedChatClient([self._htsc_reply(DOC), window_reply([])])
        os.environ["PE_INGEST_SCAN_WINDOW_CHARS"] = "80"
        try:
            scan_document(conn, dataset_id=DATASET, doc_id=DOC, llm_client=client,
                          items=active_checklist(conn, DATASET), ingested_at=INGESTED_AT)
        finally:
            os.environ.pop("PE_INGEST_SCAN_WINDOW_CHARS")
        self.assertGreaterEqual(len(client.calls), 2)
        self.assertIn('"document"', client.calls[0][0]["content"])
        self.assertNotIn('"document"', client.calls[1][0]["content"])
        self.assertIn("窗口：1/", client.calls[0][1]["content"])

    def test_rescanning_is_free_and_a_forced_rescan_replaces_old_claims(self) -> None:
        conn = self._prepare()
        client = ScriptedChatClient([self._htsc_reply(DOC), self._htsc_reply(DOC, revenue=170)])

        first = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT)
        calls_after_first = len(client.calls)
        second = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT)

        self.assertEqual(first["documents_scanned"], 1)
        self.assertEqual(second["documents_skipped"], 1)
        self.assertEqual(len(client.calls), calls_after_first, "已扫描的文档不应再调用模型")

        scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT, force=True)
        statuses = conn.execute(
            "SELECT status, COUNT(*) FROM atomic_claims GROUP BY status ORDER BY status"
        ).fetchall()
        self.assertEqual([tuple(r) for r in statuses], [(CLAIM_ACTIVE, 3), (CLAIM_REPLACED, 3)],
                         "上一次扫描的全部观点被整体替换，而不是逐条比对")
        active_revenue = conn.execute(
            "SELECT value_numeric FROM atomic_claims WHERE item_key = 'revenue' AND status = ?", (CLAIM_ACTIVE,)
        ).fetchone()
        self.assertEqual(active_revenue["value_numeric"], 170)

    def test_discovery_creates_the_question_and_rekeys_without_rereading(self) -> None:
        conn = self._prepare()
        client = ScriptedChatClient(
            [self._htsc_reply(DOC)],
            resolution_reply=json.dumps({"decisions": [{
                "proposed_key": "ai_chip_shipments", "item_key": "ai_chip_volume",
                "question": "AI 芯片出货量", "description": "公司 AI 芯片年度出货量指引与预测",
                "scope": "company", "claim_type": "quantitative", "value_kind": "volume", "period_required": True,
            }]}, ensure_ascii=False),
        )

        summary = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT)

        self.assertEqual(summary["checklist_created"], ["ai_chip_volume"])
        self.assertEqual(client.resolution_calls, 1)
        item = next(i for i in active_checklist(conn, DATASET) if i.item_key == "ai_chip_volume")
        self.assertTrue(item.period_required)
        row = conn.execute("SELECT item_key, proposed_key FROM atomic_claims WHERE proposed_key IS NOT NULL").fetchone()
        self.assertEqual((row["item_key"], row["proposed_key"]), ("ai_chip_volume", "ai_chip_shipments"))
        self.assertEqual(len(client.calls), 2, "发掘不应触发对文档的二次读取")

    def test_a_model_failure_leaves_the_document_pending(self) -> None:
        conn = self._prepare()

        class BrokenClient:
            model = "broken"

            def chat(self, messages, *, max_tokens=None, temperature=None) -> str:
                raise RuntimeError("gateway timeout")

        summary = scan_documents(
            conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=BrokenClient(), ingested_at=INGESTED_AT
        )

        self.assertEqual(summary["documents_failed"], 1)
        self.assertEqual(summary["status"], "failed")
        scan = conn.execute("SELECT status FROM document_scans").fetchone()
        self.assertEqual(scan["status"], "failed")
        retry = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC],
                               llm_client=ScriptedChatClient([self._htsc_reply(DOC)]), ingested_at=INGESTED_AT)
        self.assertEqual(retry["documents_scanned"], 1)

    def test_a_failed_window_is_retried_alone_and_earlier_claims_survive(self) -> None:
        conn = self._prepare()
        os.environ["PE_INGEST_SCAN_WINDOW_CHARS"] = "80"

        class FlakyClient:
            model = "flaky"

            def __init__(self) -> None:
                self.calls: list[int] = []
                self.fail_window_index = 1

            def chat(self, messages, *, max_tokens=None, temperature=None) -> str:
                user = messages[1]["content"]
                window_index = int(user.split("窗口：", 1)[1].split("/", 1)[0]) - 1
                self.calls.append(window_index)
                if window_index == self.fail_window_index:
                    raise RuntimeError("gateway timeout")
                if window_index == 0:
                    return window_reply([claim_json(
                        item_key="gross_margin", text="毛利率 32.5%", evidence=evidence_id(DOC, 0),
                        quote="2026 年毛利率为 32.5%", value=32.5, unit="%", period="2026E",
                    )], document=HTSC_DOCUMENT)
                return window_reply([claim_json(
                    item_key="revenue", text="营收 165 亿元", evidence=evidence_id(DOC, 1),
                    quote="165.0 亿元", value=165, unit="亿元", period="2026E",
                )])

        try:
            client = FlakyClient()
            first = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT)
            self.assertEqual(first["documents_partial"], 1)
            self.assertEqual(conn.execute("SELECT status FROM document_scans ORDER BY created_at DESC").fetchone()[0], SCAN_PARTIAL)
            self.assertEqual(pending_scan(conn, dataset_id=DATASET, doc_id=DOC), (True, {1}))
            margin_id = conn.execute("SELECT claim_id FROM atomic_claims WHERE item_key = 'gross_margin'").fetchone()[0]

            client.fail_window_index = -1
            calls_before = len(client.calls)
            second = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=client, ingested_at=INGESTED_AT)
        finally:
            os.environ.pop("PE_INGEST_SCAN_WINDOW_CHARS")

        self.assertEqual(client.calls[calls_before:], [1], "只重跑失败的那个窗口")
        self.assertEqual(second["documents_scanned"], 1)
        self.assertEqual(pending_scan(conn, dataset_id=DATASET, doc_id=DOC), (False, None))
        rows = {r["item_key"]: (r["claim_id"], r["status"]) for r in conn.execute("SELECT item_key, claim_id, status FROM atomic_claims")}
        self.assertEqual(rows["gross_margin"], (margin_id, CLAIM_ACTIVE), "窗口 0 的观点原样保留")
        self.assertEqual(rows["revenue"][1], CLAIM_ACTIVE)
        self.assertEqual(issuer_for_document(conn, DOC)["issuer_key"], "htsc")

    def test_without_a_model_the_checklist_is_seeded_and_nothing_is_read(self) -> None:
        conn = self._prepare()
        summary = scan_documents(conn, dataset_id=DATASET, doc_ids=[DOC], llm_client=None, ingested_at=INGESTED_AT)
        self.assertEqual(summary["status"], "skipped_no_model")
        self.assertEqual(summary["checklist_items"], len(UNIVERSAL_CHECKLIST))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM document_scans").fetchone()[0], 0)

    def test_an_undated_document_takes_the_ingest_day_as_of(self) -> None:
        conn = self._prepare(filename="report.pdf")
        document = {**HTSC_DOCUMENT, "published_date": ""}
        reply = window_reply([claim_json(
            item_key="gross_margin", text="毛利率 32.5%", evidence=evidence_id(DOC, 0),
            quote="2026 年毛利率为 32.5%", value=32.5, unit="%", period="2026E",
        )], document=document)
        scan_document(conn, dataset_id=DATASET, doc_id=DOC, llm_client=ScriptedChatClient([reply]),
                      items=active_checklist(conn, DATASET), ingested_at=INGESTED_AT)
        issuer = issuer_for_document(conn, DOC)
        self.assertEqual((issuer["published_date"], issuer["as_of_date"], issuer["as_of_source"]),
                         (None, "2026-09-06", AS_OF_INGESTED))


class HistoryTest(unittest.TestCase):
    def _two_reports(self, order: tuple[str, str]) -> sqlite3.Connection:
        conn = make_collection()
        seed_universal_checklist(conn, DATASET)
        dates = {"doc_aug": "2026-08-14", "doc_sep": "2026-09-01"}
        revenues = {"doc_aug": 165.0, "doc_sep": 180.0}
        for doc_id in order:
            add_document(conn, doc_id=doc_id, filename=f"华泰-{doc_id}.pdf")
            add_chunk(conn, 0, REVENUE_TEXT, doc_id=doc_id)
            document = {**HTSC_DOCUMENT, "published_date": dates[doc_id]}
            reply = window_reply([claim_json(
                item_key="revenue", text=f"华泰预计 2026 年营收 {revenues[doc_id]} 亿元",
                evidence=evidence_id(doc_id, 0), quote="下半年出货快速放量",
                value=revenues[doc_id], unit="亿元", period="2026E",
            )], document=document)
            scan_documents(conn, dataset_id=DATASET, doc_ids=[doc_id],
                           llm_client=ScriptedChatClient([reply]), ingested_at=INGESTED_AT)
        return conn

    def _chain(self, conn: sqlite3.Connection) -> list[tuple]:
        return [
            tuple(r) for r in conn.execute(
                """
                SELECT doc_id, revision_direction, revision_delta, supersedes_claim_id IS NOT NULL
                FROM atomic_claims WHERE item_key = 'revenue' ORDER BY as_of_date
                """
            ).fetchall()
        ]

    def test_a_later_report_links_to_the_earlier_one_with_direction(self) -> None:
        conn = self._two_reports(("doc_aug", "doc_sep"))
        self.assertEqual(self._chain(conn), [
            ("doc_aug", REVISION_NEW, None, 0),
            ("doc_sep", REVISION_UP, 15e8, 1),
        ])

    def test_out_of_order_ingest_still_chains_by_date(self) -> None:
        conn = self._two_reports(("doc_sep", "doc_aug"))
        self.assertEqual(self._chain(conn), [
            ("doc_aug", REVISION_NEW, None, 0),
            ("doc_sep", REVISION_UP, 15e8, 1),
        ])

    def test_a_cut_shows_as_down(self) -> None:
        conn = self._two_reports(("doc_aug", "doc_sep"))
        conn.execute("UPDATE atomic_claims SET value_canonical = 150e8 WHERE doc_id = 'doc_sep'")
        relink_revision_chains(conn, DATASET)
        self.assertEqual(self._chain(conn)[1][1], REVISION_DOWN)

    def test_claims_of_a_superseded_document_version_are_retired(self) -> None:
        conn = self._two_reports(("doc_aug", "doc_sep"))
        conn.execute("UPDATE documents SET lifecycle_state = 'superseded', is_current = 0 WHERE doc_id = 'doc_aug'")

        summary = scan_documents(conn, dataset_id=DATASET, doc_ids=["doc_sep"], llm_client=None, ingested_at=INGESTED_AT)

        self.assertEqual(summary["retired"], {"superseded": 1, "withdrawn": 0})
        status = conn.execute("SELECT status FROM atomic_claims WHERE doc_id = 'doc_aug'").fetchone()[0]
        self.assertEqual(status, CLAIM_SUPERSEDED)


# ---------------------------------------------------------------- llm client


class LlmClientTest(unittest.TestCase):
    def test_json_is_recovered_from_a_fenced_reply(self) -> None:
        value = extract_json_object('```json\n{"claims": [], "note": "ok"}\n```')
        self.assertEqual(value, {"claims": [], "note": "ok"})

    def test_unescaped_inner_quotes_are_repaired(self) -> None:
        raw = '{"claims": [{"claim_text": "核心"增长公式"依然完好", "reason": "见 "第 2 页"", "n": 1}]}'
        value = extract_json_object(raw)
        self.assertEqual(value["claims"][0]["claim_text"], '核心"增长公式"依然完好')
        self.assertEqual(value["claims"][0]["reason"], '见 "第 2 页"')

    def test_prose_wrapped_json_is_recovered(self) -> None:
        value = extract_json_object('好的，结果如下：\n{"claims": []}\n以上。')
        self.assertEqual(value, {"claims": []})

    def test_extra_body_is_merged_but_cannot_override_the_pipeline(self) -> None:
        saved = {key: os.environ.get(key) for key in ("PE_INGEST_LLM_BASE_URL", "PE_INGEST_LLM_API_KEY", "PE_INGEST_LLM_EXTRA_BODY")}
        os.environ["PE_INGEST_LLM_BASE_URL"] = "https://example.test/v1"
        os.environ["PE_INGEST_LLM_API_KEY"] = "k"
        os.environ["PE_INGEST_LLM_EXTRA_BODY"] = '{"enable_thinking": false, "model": "evil", "temperature": 1}'
        try:
            settings = settings_from_env()
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        assert settings is not None
        self.assertEqual(dict(settings.extra_body), {"enable_thinking": False})

    def test_an_unconfigured_environment_yields_no_settings(self) -> None:
        saved = {key: os.environ.pop(key, None) for key in ("PE_INGEST_LLM_BASE_URL", "PE_INGEST_LLM_API_KEY")}
        try:
            self.assertIsNone(settings_from_env())
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
