import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from datetime import date
from unittest.mock import patch

from analyze_collection import analyze_collection
from pipeline.analysis_checklist import (
    UNIVERSAL_CHECKLIST, active_checklist, make_proposal, record_proposals,
    resolve_pending_proposals, seed_universal_checklist,
)
from pipeline.atomic_claims import (
    EvidenceItem, _dedupe, relink_revision_chains, validate_claim,
)
from pipeline.consensus_cards import (
    _latest_per_issuer, _load_claims, _numeric_stats, build_cards, template_narrative, write_narratives,
)
from pipeline.state import collection_fingerprint
from pipeline.value_normalization import normalize_period, normalize_value


class FakeClient:
    model = "local-fake"

    def __init__(self, database: Path):
        self.database = database
        self.calls = []
        self.fail_pages = set()
        self.fail_narrative = False

    def chat(self, messages, **_kwargs):
        # Every upstream call must permit another process to obtain a SQLite write lock.
        with closing(sqlite3.connect(self.database, timeout=0)) as other:
            other.execute("BEGIN IMMEDIATE")
            other.rollback()
        system, text = messages[0]["content"], messages[1]["content"]
        self.calls.append(system)
        if "维护一份" in system:
            return '{"decisions":[]}'
        if "卡片" in system:
            if self.fail_narrative:
                raise RuntimeError("injected narrative failure")
            return '{"cards":[]}'
        ids = re.findall(r"\[(page:[^\]]+)\]", text)
        if any(item in self.fail_pages for item in ids):
            raise RuntimeError("injected page failure")
        issuer = "中信证券" if "CITIC" in text else "华泰证券"
        company = "Company.pdf" in text
        claims = []
        for evidence_id in ids:
            block = text.split(f"[{evidence_id}]", 1)[1].split("\n", 1)[1].split("\n\n[", 1)[0]
            for quote in block.splitlines():
                match = re.search(r"(20\d{2})年收入预计(\d+)亿元", quote)
                if match:
                    claims.append({
                        "item_key": "revenue", "claim_text": quote, "stance": "bullish", "measure": "level",
                        "value_numeric": int(match[2]), "unit": "亿元", "period": match[1] + "年",
                        "evidence_ids": [evidence_id], "evidence_quotes": [{"evidence_id": evidence_id, "quote": quote}],
                        "confidence": 0.95,
                    })
        return json.dumps({
            "document": {"issuer_name": "Example" if company else issuer,
                         "issuer_kind": "company" if company else "sell_side",
                         "issuer_confidence": 0.95, "published_date": "2026-09-01"},
            "proposed_items": [], "claims": claims,
        }, ensure_ascii=False)


class PageAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "meta" / "collection.sqlite3"
        self.database.parent.mkdir()
        self.conn = sqlite3.connect(self.database)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE project_metadata(dataset_id TEXT);
            INSERT INTO project_metadata VALUES ('dataset');
            CREATE TABLE documents(doc_id TEXT PRIMARY KEY,dataset_id TEXT,sha256 TEXT,version_no INTEGER,
                status TEXT,title TEXT,brokerage TEXT,document_date TEXT,original_filename TEXT,
                file_type TEXT,is_current INTEGER,lifecycle_state TEXT,deleted_at TEXT);
            CREATE TABLE pdf_pages(page_id TEXT PRIMARY KEY,doc_id TEXT,page_number INTEGER,page_text TEXT,
                text_quality TEXT,role TEXT,page_header TEXT);
        """)
        self.add_doc("one", "HTSC.pdf", ["2026年收入预计100亿元，需求增长带动。"])
        self.client = FakeClient(self.database)
        self.environment = patch.dict(os.environ, {
            "PE_INGEST_ANALYSIS_DISABLED": "0", "PE_INGEST_SCAN_WINDOW_CHARS": "20000",
            "PE_INGEST_SCAN_MAX_WINDOWS": "12",
        })
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.conn.close()
        self.temp.cleanup()

    def add_doc(self, doc_id, filename, texts):
        self.conn.execute("INSERT INTO documents VALUES (?,?,?,1,'completed',?,'','2026-09-01',?,'pdf',1,'active',NULL)",
                          (doc_id, "dataset", doc_id, filename, filename))
        for page, text in enumerate(texts, 1):
            self.conn.execute("INSERT INTO pdf_pages VALUES (?,?,?,?,'passed','body',?)",
                              (f"{doc_id}-{page}", doc_id, page, text, f"{filename} p.{page}"))
        self.conn.commit()

    def run_analysis(self):
        with patch("analyze_collection.build_chat_client_from_env", return_value=self.client):
            return analyze_collection(str(self.database), "dataset", company_name="Example",
                                      ingested_at="2026-09-07T00:00:00+00:00")

    def test_analysis_is_page_only_idempotent_and_grounded(self):
        result = self.run_analysis()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["claims"], 1)
        self.assertEqual(len(active_checklist(self.conn, "dataset")), 22)
        card = self.conn.execute("SELECT * FROM consensus_cards").fetchone()
        self.assertEqual(json.loads(card["stats_json"])["median"], 100e8)
        self.assertIn("page:one-1", card["sources_json"])
        self.assertIn("2026年收入预计100亿元", card["sources_json"])
        self.assertIsNone(self.conn.execute("SELECT 1 FROM sqlite_master WHERE name='chunks'").fetchone())
        scans = self.conn.execute("SELECT COUNT(*) FROM document_scans").fetchone()[0]
        self.assertEqual(self.run_analysis()["documents_skipped"], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM document_scans").fetchone()[0], scans)
        self.assertEqual(self.conn.execute("SELECT snapshot_fingerprint FROM pe_analysis_metadata").fetchone()[0],
                         collection_fingerprint(self.conn, "dataset"))

    def test_units_periods_quotes_and_substring_numbers(self):
        item = {item.item_key: item for item in UNIVERSAL_CHECKLIST}
        text = "2026年收入预计100亿元，需求增长带动。"
        raw = {"item_key": "revenue", "claim_text": "预计收入", "stance": "bullish", "measure": "level",
               "value_numeric": 100, "unit": "亿元", "period": "2026年", "evidence_ids": ["page:p"],
               "evidence_quotes": [{"evidence_id": "page:p", "quote": text}]}
        evidence = [EvidenceItem("page:p", text)]
        valid = lambda data: validate_claim(data, items_by_key=item, proposals_by_key={}, evidence=evidence)
        self.assertEqual(valid(raw).quality_status, "verified")
        for change in ({"value_numeric": 10}, {"value_numeric": 100.3}, {"unit": "百万元"}, {"period": "2027年"}, {"period": ""}):
            self.assertEqual(valid({**raw, **change}).quality_status, "review_required")
        self.assertIsNone(valid({**raw, "evidence_quotes": []}))
        self.assertIsNone(valid({**raw, "evidence_ids": ["page:foreign"],
                                 "evidence_quotes": [{"evidence_id": "page:foreign", "quote": text}]}))
        self.assertEqual(normalize_value(100, "亿元").value_canonical, normalize_value(10000, "百万元").value_canonical)
        self.assertEqual(normalize_period("3Q26"), "2026Q3")

    def test_cap_is_incomplete_and_completed_windows_are_not_rescanned(self):
        self.add_doc("long", "Long.pdf", ["2026年收入预计110亿元，判断一。", "2027年收入预计120亿元，判断二。"])
        with patch.dict(os.environ, {"PE_INGEST_SCAN_WINDOW_CHARS": "25", "PE_INGEST_SCAN_MAX_WINDOWS": "1"}):
            result = self.run_analysis()
            self.assertEqual(result["status"], "partial")
            self.assertFalse(result["coverage"]["complete"])
            self.assertIn("long", result["coverage"]["incomplete_documents"])
            self.assertEqual(self.conn.execute("SELECT status FROM document_scans WHERE doc_id='long'").fetchone()[0], "partial")
            calls = len(self.client.calls)
            self.run_analysis()
            self.assertEqual(len(self.client.calls), calls)
        self.assertEqual(self.run_analysis()["status"], "completed")

    def test_changed_input_retries_failures_and_keeps_previous_snapshot(self):
        self.add_doc("long", "CITIC.pdf", ["2026年收入预计110亿元，判断一。", "2027年收入预计120亿元，判断二。"])
        with patch.dict(os.environ, {"PE_INGEST_SCAN_WINDOW_CHARS": "25"}):
            self.assertEqual(self.run_analysis()["status"], "completed")
            old_card = self.conn.execute("SELECT sources_json FROM consensus_cards ORDER BY card_id").fetchall()
            self.conn.execute("UPDATE pdf_pages SET page_text='2026年收入预计140亿元，新的判断。' WHERE page_id='long-1'")
            self.conn.commit()
            self.client.fail_pages = {"page:long-2"}
            result = self.run_analysis()
            self.assertEqual(result["status"], "partial")
            self.assertEqual(self.conn.execute("SELECT sources_json FROM consensus_cards ORDER BY card_id").fetchall(), old_card)
            old = self.conn.execute("SELECT status FROM atomic_claims WHERE doc_id='long' AND window_index=1").fetchone()
            self.assertEqual(old[0], "active")
            self.client.fail_pages.clear()
            self.assertEqual(self.run_analysis()["status"], "completed")

    def test_failed_narrative_and_database_publication_keep_old_cards(self):
        self.run_analysis()
        previous = self.conn.execute("SELECT built_at FROM consensus_cards").fetchone()[0]
        self.client.fail_narrative = True
        self.assertEqual(self.run_analysis()["status"], "failed")
        self.assertEqual(self.conn.execute("SELECT built_at FROM consensus_cards").fetchone()[0], previous)
        self.client.fail_narrative = False
        self.conn.executescript("CREATE TRIGGER fail_card BEFORE INSERT ON consensus_cards BEGIN SELECT RAISE(ABORT,'injected'); END;")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected"):
            self.run_analysis()
        self.assertEqual(self.conn.execute("SELECT built_at FROM consensus_cards").fetchone()[0], previous)

    def test_project_sample_median_excludes_company_and_retired_documents(self):
        self.add_doc("two", "CITIC.pdf", ["2026年收入预计120亿元，需求增长。"])
        self.add_doc("company", "Company.pdf", ["2026年收入预计200亿元，公司指引。"])
        self.run_analysis()
        cards = build_cards(self.conn, "dataset")
        self.assertEqual(cards[0].issuer_count, 2)
        self.assertEqual(cards[0].stats["median"], 110e8)
        self.assertIsNotNone(cards[0].company_view)
        self.conn.execute("UPDATE documents SET is_current=0 WHERE doc_id='two'")
        self.conn.commit()
        self.assertEqual(build_cards(self.conn, "dataset")[0].issuer_count, 1)

    def test_disabled_and_empty_projects_do_not_require_model(self):
        with patch.dict(os.environ, {"PE_INGEST_ANALYSIS_DISABLED": "1"}):
            self.assertEqual(self.run_analysis()["status"], "skipped_disabled")
        self.assertEqual(self.client.calls, [])
        self.conn.execute("DELETE FROM pdf_pages")
        self.conn.execute("DELETE FROM documents")
        self.conn.commit()
        self.assertEqual(self.run_analysis()["status"], "completed")

    def test_dispersion_uses_one_comparable_sample_and_handles_small_samples(self):
        self.run_analysis()
        original = _load_claims(self.conn, "dataset")[0]
        claims = [replace(original, issuer_key=str(i), value_canonical=value, scope_note="")
                  for i, value in enumerate([100, 110, 120, 150])]
        incompatible = replace(original, issuer_key="foreign", value_canonical=999, currency="USD")
        stats, comparable = _numeric_stats([*claims, incompatible])
        self.assertEqual(len(comparable), 4)
        self.assertEqual(stats["median"], 115)
        self.assertEqual(stats["mean"], 120)
        self.assertEqual(stats["iqr"], 20)
        self.assertEqual(stats["mad"], 10)
        self.assertEqual(stats["excluded_unit_mismatch"], 1)
        self.assertEqual(_numeric_stats([]), ({}, []))
        self.assertEqual(_numeric_stats([replace(original, value_canonical=float("inf"))]), ({}, []))
        one, _ = _numeric_stats(claims[:1])
        self.assertEqual((one["iqr"], one["mad"]), (0, 0))
        persisted = json.loads(self.conn.execute("SELECT stats_json FROM consensus_cards").fetchone()[0])
        self.assertEqual((persisted["iqr"], persisted["mad"]), (0, 0))

    def test_latest_vote_is_stable_and_counts_an_institution_once(self):
        self.add_doc("two", "HTSC_new.pdf", ["2026年收入预计120亿元，需求增长。"])
        self.run_analysis()
        claims = _load_claims(self.conn, "dataset")
        old = replace(claims[0], claim_id="a", created_at="2026-09-09T00:00:00Z")
        latest = replace(old, claim_id="b", created_at="2026-09-10T00:00:00Z")
        self.assertEqual(_latest_per_issuer([latest, old]), _latest_per_issuer([old, latest]))
        self.assertEqual(list(_latest_per_issuer([old, latest]).values()), [latest])
        cards = build_cards(self.conn, "dataset")
        self.assertEqual(cards[0].issuer_count, 1)
        self.assertEqual(cards[0].stats["sample"]["included_count"], 1)
        self.assertEqual(len(cards[0].stats["sample"]["claim_ids"]), 1)
        self.assertEqual(cards[0].stats["sample"]["stance_ratios"]["bullish"], 1)

    def test_missing_verified_views_are_not_counted_as_opposition(self):
        self.add_doc("silent", "CITIC.pdf", ["行业讨论，未提供收入预测。"])
        self.run_analysis()
        card = build_cards(self.conn, "dataset")[0]
        self.assertEqual((card.issuer_count, card.coverage_total), (1, 2))
        self.assertEqual(card.stance_counts["bearish"], 0)
        self.assertEqual([item["issuer_name"] for item in card.stats["sample"]["not_mentioned"]], ["中信证券"])
        self.conn.execute("UPDATE documents SET deleted_at='2026-09-10' WHERE doc_id='silent'")
        card = build_cards(self.conn, "dataset")[0]
        self.assertEqual(card.coverage_total, 1)
        self.assertEqual(card.stats["sample"]["not_mentioned"], [])

    def test_future_views_are_excluded_and_qualitative_cards_keep_stance_narratives(self):
        self.add_doc("two", "CITIC.pdf", ["2026年收入预计120亿元，需求增长。"])
        self.run_analysis()
        self.conn.execute("UPDATE atomic_claims SET as_of_date='2026-10-01' WHERE doc_id='two'")
        card = build_cards(self.conn, "dataset", as_of=date(2026, 9, 10))[0]
        self.assertEqual(card.issuer_count, 1)
        self.assertEqual(card.stats["median"], 100e8)
        item = next(item for item in UNIVERSAL_CHECKLIST if item.claim_type == "qualitative")
        self.conn.execute("UPDATE atomic_claims SET item_key=?,value_canonical=NULL,value_numeric=NULL,as_of_date='2026-09-01'", (item.item_key,))
        self.conn.execute("UPDATE atomic_claims SET stance='bearish' WHERE doc_id='two'")
        card = build_cards(self.conn, "dataset")[0]
        self.assertEqual(card.card_type, "divergence")
        self.assertNotIn("median", card.stats)
        self.assertIn("1 家偏正面、1 家偏负面", template_narrative(card)["consensus_line"])

    def test_company_only_card_does_not_claim_institution_coverage(self):
        self.conn.execute("DELETE FROM pdf_pages")
        self.conn.execute("DELETE FROM documents")
        self.add_doc("company", "Company.pdf", ["2026年收入预计200亿元，公司指引。"])
        self.run_analysis()
        card = build_cards(self.conn, "dataset")[0]
        self.assertEqual((card.issuer_count, card.coverage_total), (0, 0))
        self.assertIsNotNone(card.company_view)
        self.assertEqual(card.stats["sample"]["stance_ratios"], {"bullish": None, "bearish": None, "neutral": None})
        self.assertIn("没有可比机构观点", template_narrative(card)["consensus_line"])

    def test_claim_identity_preserves_window_currency_and_scope(self):
        text = "2026年收入预计100亿元，需求增长带动。"
        claim = validate_claim({
            "item_key": "revenue", "claim_text": text, "value_numeric": 100,
            "unit": "亿元", "period": "2026年", "stance": "bullish",
            "evidence_ids": ["page:p"], "evidence_quotes": [{"evidence_id": "page:p", "quote": text}],
        }, items_by_key={i.item_key: i for i in UNIVERSAL_CHECKLIST}, proposals_by_key={},
            evidence=[EvidenceItem("page:p", text)])
        self.assertIsNotNone(claim)
        variants = [claim, replace(claim), replace(claim, window_index=1),
                    replace(claim, currency="USD"), replace(claim, scope_note="扣非")]
        self.assertEqual(len(_dedupe(variants)), 4)

    def test_revision_chains_require_comparable_verified_values(self):
        self.add_doc("two", "HTSC_new.pdf", ["2026年收入预计120亿元，需求增长。"])
        self.run_analysis()
        relink_revision_chains(self.conn, "dataset")
        row = self.conn.execute("SELECT revision_direction,revision_delta FROM atomic_claims WHERE doc_id='two'").fetchone()
        self.assertEqual(tuple(row), ("up", 20e8))
        for field, value in (("currency", "USD"), ("scope_note", "扣非"), ("canonical_unit", "%")):
            self.conn.execute(f"UPDATE atomic_claims SET {field}=? WHERE doc_id='one'", (value,))
            relink_revision_chains(self.conn, "dataset")
            direction = self.conn.execute("SELECT revision_direction FROM atomic_claims WHERE doc_id='two'").fetchone()[0]
            self.assertEqual(direction, "new")
            self.conn.execute("UPDATE atomic_claims SET currency='CNY',scope_note=NULL,canonical_unit='元' WHERE doc_id='one'")
        self.conn.execute("UPDATE atomic_claims SET quality_status='review_required' WHERE doc_id='one'")
        relink_revision_chains(self.conn, "dataset")
        self.assertEqual(self.conn.execute("SELECT revision_direction FROM atomic_claims WHERE doc_id='two'").fetchone()[0], "new")

    def test_scope_mismatch_is_not_averaged_and_model_cannot_rewrite_numbers(self):
        self.add_doc("two", "CITIC.pdf", ["2026年收入预计120亿元，需求增长。"])
        self.run_analysis()
        self.conn.execute("UPDATE atomic_claims SET scope_note='乐观情形' WHERE doc_id='two'")
        cards = build_cards(self.conn, "dataset")
        self.assertEqual(cards[0].stats["n"], 1)
        self.assertEqual(cards[0].stats["excluded_scope_mismatch"], 1)
        self.assertEqual(cards[0].card_type, "single_view")
        class BadNarrative:
            def chat(_self, *_args, **_kwargs):
                return json.dumps({"cards": [{"card_id": cards[0].card_id,
                    "title": "收入达到999999999", "consensus_line": "中位数999999999",
                    "financial_impact": "999999999亿元"}]})
        _, errors = write_narratives(cards, llm_client=BadNarrative())
        self.assertTrue(errors)
        self.assertNotIn("999999999", json.dumps(cards[0].narrative))

    def test_question_proposals_over_batch_limit_are_all_resolved_without_rescanning(self):
        seed_universal_checklist(self.conn, "dataset")
        proposals = [make_proposal(dataset_id="dataset", doc_id="one", key=f"product_{i}",
            question=f"产品{i}出货", scope="company", claim_type="quantitative", value_kind="volume") for i in range(81)]
        record_proposals(self.conn, "dataset", proposals)
        self.conn.commit()
        calls = []
        class PartialDecisions:
            def chat(_self, messages, **_kwargs):
                with closing(sqlite3.connect(self.database, timeout=0)) as other:
                    other.execute("BEGIN IMMEDIATE")
                    other.rollback()
                calls.append(messages)
                return '{"decisions":[{"proposed_key":"product_0","item_key":"product_0"}]}'
        result = resolve_pending_proposals(self.conn, "dataset", llm_client=PartialDecisions())
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(result.mapping), 81)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM checklist_proposals WHERE status='pending'").fetchone()[0], 0)

    def test_changed_text_during_http_is_not_published(self):
        self.run_analysis()
        previous = self.conn.execute("SELECT built_at FROM consensus_cards").fetchone()[0]
        self.conn.execute("UPDATE pdf_pages SET page_text=page_text || '第一次修改'")
        self.conn.commit()
        original = self.client.chat
        def changing_chat(messages, **kwargs):
            with closing(sqlite3.connect(self.database)) as other:
                other.execute("UPDATE pdf_pages SET page_text=page_text || '并发修改'")
                other.commit()
            return original(messages, **kwargs)
        with patch.object(self.client, "chat", side_effect=changing_chat):
            with self.assertRaisesRegex(ValueError, "changed during analysis"):
                self.run_analysis()
        self.assertEqual(self.conn.execute("SELECT built_at FROM consensus_cards").fetchone()[0], previous)

    def test_retried_cover_attributes_previously_completed_body_windows(self):
        self.add_doc("unknown", "Unknown_report.pdf", ["2026年收入预计110亿元，判断一。", "2027年收入预计120亿元，判断二。"])
        self.client.fail_pages = {"page:unknown-1"}
        with patch.dict(os.environ, {"PE_INGEST_SCAN_WINDOW_CHARS": "25"}):
            self.assertEqual(self.run_analysis()["status"], "partial")
            self.client.fail_pages.clear()
            self.assertEqual(self.run_analysis()["status"], "completed")
        issuer = self.conn.execute("SELECT issuer_key FROM document_issuers WHERE doc_id='unknown'").fetchone()[0]
        claims = self.conn.execute("SELECT issuer_key FROM atomic_claims WHERE doc_id='unknown' AND status='active'").fetchall()
        self.assertEqual(len(claims), 2)
        self.assertTrue(issuer)
        self.assertTrue(all(row[0] == issuer for row in claims))


if __name__ == "__main__":
    unittest.main()
