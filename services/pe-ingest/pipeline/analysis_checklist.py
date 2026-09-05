"""Analysis checklist: the question list atomic claim extraction runs against.

A project checklist has two origins. Universal items ship as presets and cover
the dimensions every equity research document touches. Company- and
industry-specific items (chip shipments, token usage, delivery cadence) are
discovered while ingesting analyst documents and appended to the same list.

Both origins live in one table so a later discovery is indistinguishable from a
preset at extraction time, and so bumping ``checklist_version`` invalidates the
aggregated cards that were built from an older question list.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

CHECKLIST_PRESET_VERSION = "pe_analysis_checklist_v1"

SCOPE_UNIVERSAL = "universal"
SCOPE_COMPANY = "company"
SCOPE_INDUSTRY = "industry"

ORIGIN_PRESET = "preset"
ORIGIN_DISCOVERED = "discovered"
ORIGIN_MANUAL = "manual"

STATUS_ACTIVE = "active"
STATUS_RETIRED = "retired"

CLAIM_TYPE_QUANTITATIVE = "quantitative"
CLAIM_TYPE_QUALITATIVE = "qualitative"

VALID_SCOPES = frozenset({SCOPE_UNIVERSAL, SCOPE_COMPANY, SCOPE_INDUSTRY})
VALID_ORIGINS = frozenset({ORIGIN_PRESET, ORIGIN_DISCOVERED, ORIGIN_MANUAL})
VALID_CLAIM_TYPES = frozenset({CLAIM_TYPE_QUANTITATIVE, CLAIM_TYPE_QUALITATIVE})


@dataclass(frozen=True)
class ChecklistItem:
    item_key: str
    question: str
    aliases: tuple[str, ...] = ()
    metric_key: str = ""
    basis_hint: str = ""
    claim_type: str = CLAIM_TYPE_QUANTITATIVE
    scope: str = SCOPE_UNIVERSAL
    origin: str = ORIGIN_PRESET
    status: str = STATUS_ACTIVE
    discovered_from_doc_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def search_terms(self) -> tuple[str, ...]:
        terms = [self.question, *self.aliases]
        return tuple(dict.fromkeys(term for term in terms if term.strip()))


# Universal dimensions. Deliberately small: every extra question multiplies the
# per-document model cost, and a question no analyst writes about only produces
# empty results. Company and industry specifics arrive through discovery.
UNIVERSAL_CHECKLIST: tuple[ChecklistItem, ...] = (
    ChecklistItem(
        item_key="revenue_growth",
        question="营业收入的预测值与增长判断",
        aliases=("营业收入", "营收", "收入增速", "收入预测", "revenue"),
        metric_key="revenue",
        basis_hint="revenue",
    ),
    ChecklistItem(
        item_key="gross_margin",
        question="毛利率水平与变化判断",
        aliases=("毛利率", "毛利", "gross margin", "毛利率环比", "毛利率同比"),
        metric_key="gross_margin",
        basis_hint="ratio",
    ),
    ChecklistItem(
        item_key="net_profit",
        question="归母净利润的预测值与增长判断",
        aliases=("归母净利润", "净利润", "归属于母公司", "扣非净利润", "net profit"),
        metric_key="net_profit_atsopc",
        basis_hint="atsopc",
    ),
    ChecklistItem(
        item_key="operating_margin",
        question="营业利润率与费用率判断",
        aliases=("营业利润率", "期间费用率", "销售费用", "管理费用", "研发费用率"),
        metric_key="operating_margin",
        basis_hint="ratio",
    ),
    ChecklistItem(
        item_key="capacity_shipment",
        question="产能、出货量与交付节奏判断",
        aliases=("出货量", "产能", "交付", "排产", "装机量", "销量", "shipment"),
        metric_key="",
        basis_hint="volume",
    ),
    ChecklistItem(
        item_key="pricing_asp",
        question="产品价格与单位价值判断",
        aliases=("单价", "ASP", "价格", "均价", "提价", "降价"),
        metric_key="",
        basis_hint="price",
    ),
    ChecklistItem(
        item_key="customer_concentration",
        question="客户结构、集中度与大客户进展",
        aliases=("客户集中度", "前五大客户", "大客户", "客户结构", "订单"),
        metric_key="",
        basis_hint="ratio",
        claim_type=CLAIM_TYPE_QUALITATIVE,
    ),
    ChecklistItem(
        item_key="capex_expansion",
        question="资本开支与扩产计划",
        aliases=("资本开支", "capex", "扩产", "在建工程", "新增产能"),
        metric_key="",
        basis_hint="amount",
    ),
    ChecklistItem(
        item_key="competitive_position",
        question="竞争格局、市场份额与壁垒判断",
        aliases=("市场份额", "竞争格局", "份额", "竞争对手", "壁垒", "国产替代"),
        metric_key="",
        basis_hint="",
        claim_type=CLAIM_TYPE_QUALITATIVE,
    ),
    ChecklistItem(
        item_key="target_price",
        question="目标价",
        aliases=("目标价", "target price", "合理估值", "每股价值", "目标市值"),
        metric_key="target_price",
        basis_hint="per_share",
    ),
    ChecklistItem(
        item_key="valuation_multiple",
        question="估值倍数与估值方法判断",
        aliases=("PE", "市盈率", "PB", "EV/EBITDA", "估值", "倍数", "DCF", "WACC"),
        metric_key="valuation_multiple",
        basis_hint="multiple",
    ),
    ChecklistItem(
        item_key="rating",
        question="投资评级及其变动",
        aliases=("评级", "买入", "增持", "中性", "减持", "维持评级", "上调", "下调"),
        metric_key="",
        basis_hint="",
        claim_type=CLAIM_TYPE_QUALITATIVE,
    ),
    ChecklistItem(
        item_key="key_risk",
        question="核心风险与下行情形",
        aliases=("风险", "风险提示", "不及预期", "下行", "承压", "减值"),
        metric_key="",
        basis_hint="",
        claim_type=CLAIM_TYPE_QUALITATIVE,
    ),
    ChecklistItem(
        item_key="catalyst",
        question="催化剂与关键验证事件",
        aliases=("催化剂", "催化", "关键节点", "验证", "落地", "放量", "投产"),
        metric_key="",
        basis_hint="",
        claim_type=CLAIM_TYPE_QUALITATIVE,
    ),
    ChecklistItem(
        item_key="cash_and_leverage",
        question="现金流、负债与财务健康判断",
        aliases=("经营现金流", "自由现金流", "资产负债率", "有息负债", "现金"),
        metric_key="",
        basis_hint="amount",
    ),
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _item_id(dataset_id: str, item_key: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}\0{item_key}".encode("utf-8")).hexdigest()
    return f"cli_{digest[:32]}"


def ensure_checklist_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS analysis_checklist_items (
            item_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            question TEXT NOT NULL,
            aliases_json TEXT,
            metric_key TEXT,
            basis_hint TEXT,
            claim_type TEXT NOT NULL DEFAULT 'quantitative',
            scope TEXT NOT NULL DEFAULT 'universal',
            origin TEXT NOT NULL DEFAULT 'preset',
            status TEXT NOT NULL DEFAULT 'active',
            checklist_version INTEGER NOT NULL DEFAULT 1,
            preset_version TEXT,
            discovered_from_doc_id TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_checklist_dataset_key
            ON analysis_checklist_items(dataset_id, item_key);
        CREATE INDEX IF NOT EXISTS idx_checklist_active
            ON analysis_checklist_items(dataset_id, status, scope);
        """
    )


def current_checklist_version(conn: sqlite3.Connection, dataset_id: str) -> int:
    row = conn.execute(
        "SELECT MAX(checklist_version) AS version FROM analysis_checklist_items WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchone()
    version = row["version"] if row is not None else None
    return int(version) if version else 0


def seed_universal_checklist(conn: sqlite3.Connection, dataset_id: str) -> int:
    """Insert missing preset items. Existing rows are never overwritten."""

    ensure_checklist_schema(conn)
    version = max(current_checklist_version(conn, dataset_id), 1)
    inserted = 0
    for item in UNIVERSAL_CHECKLIST:
        if _insert_item(conn, dataset_id, item, checklist_version=version):
            inserted += 1
    conn.commit()
    return inserted


def record_discovered_items(
    conn: sqlite3.Connection,
    dataset_id: str,
    items: Iterable[ChecklistItem],
    *,
    doc_id: str = "",
) -> list[ChecklistItem]:
    """Append company/industry questions found while ingesting a document.

    Returns only the items that were new. A new question means previously
    extracted documents no longer cover the full checklist, which is what the
    backfill pass in ``atomic_claims`` looks for.
    """

    ensure_checklist_schema(conn)
    added: list[ChecklistItem] = []
    version = max(current_checklist_version(conn, dataset_id), 1)
    for item in items:
        if item.scope == SCOPE_UNIVERSAL:
            raise ValueError("discovered items must be company or industry scoped")
        candidate = ChecklistItem(
            item_key=item.item_key,
            question=item.question,
            aliases=item.aliases,
            metric_key=item.metric_key,
            basis_hint=item.basis_hint,
            claim_type=item.claim_type,
            scope=item.scope,
            origin=ORIGIN_DISCOVERED,
            status=STATUS_ACTIVE,
            discovered_from_doc_id=doc_id or item.discovered_from_doc_id,
            metadata=item.metadata,
        )
        if _insert_item(conn, dataset_id, candidate, checklist_version=version + 1):
            added.append(candidate)
    if added:
        conn.commit()
    return added


def _insert_item(
    conn: sqlite3.Connection,
    dataset_id: str,
    item: ChecklistItem,
    *,
    checklist_version: int,
) -> bool:
    if item.scope not in VALID_SCOPES:
        raise ValueError(f"unknown checklist scope: {item.scope}")
    if item.origin not in VALID_ORIGINS:
        raise ValueError(f"unknown checklist origin: {item.origin}")
    if item.claim_type not in VALID_CLAIM_TYPES:
        raise ValueError(f"unknown checklist claim type: {item.claim_type}")

    timestamp = now_iso()
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO analysis_checklist_items (
            item_id, dataset_id, item_key, question, aliases_json, metric_key,
            basis_hint, claim_type, scope, origin, status, checklist_version,
            preset_version, discovered_from_doc_id, metadata_json,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _item_id(dataset_id, item.item_key),
            dataset_id,
            item.item_key,
            item.question,
            json.dumps(list(item.aliases), ensure_ascii=False),
            item.metric_key or None,
            item.basis_hint or None,
            item.claim_type,
            item.scope,
            item.origin,
            item.status,
            checklist_version,
            CHECKLIST_PRESET_VERSION if item.origin == ORIGIN_PRESET else None,
            item.discovered_from_doc_id or None,
            json.dumps(item.metadata, ensure_ascii=False) if item.metadata else None,
            timestamp,
            timestamp,
        ),
    )
    return cursor.rowcount > 0


def _row_to_item(row: sqlite3.Row) -> ChecklistItem:
    aliases_raw = row["aliases_json"]
    try:
        aliases = tuple(json.loads(aliases_raw)) if aliases_raw else ()
    except (TypeError, json.JSONDecodeError):
        aliases = ()
    metadata_raw = row["metadata_json"]
    try:
        metadata = json.loads(metadata_raw) if metadata_raw else {}
    except (TypeError, json.JSONDecodeError):
        metadata = {}
    return ChecklistItem(
        item_key=str(row["item_key"]),
        question=str(row["question"]),
        aliases=tuple(str(alias) for alias in aliases),
        metric_key=str(row["metric_key"] or ""),
        basis_hint=str(row["basis_hint"] or ""),
        claim_type=str(row["claim_type"]),
        scope=str(row["scope"]),
        origin=str(row["origin"]),
        status=str(row["status"]),
        discovered_from_doc_id=str(row["discovered_from_doc_id"] or ""),
        metadata=metadata if isinstance(metadata, dict) else {},
    )


def active_checklist(conn: sqlite3.Connection, dataset_id: str) -> list[ChecklistItem]:
    ensure_checklist_schema(conn)
    rows = conn.execute(
        """
        SELECT * FROM analysis_checklist_items
        WHERE dataset_id = ? AND status = ?
        ORDER BY CASE scope WHEN 'universal' THEN 0 ELSE 1 END, item_key
        """,
        (dataset_id, STATUS_ACTIVE),
    ).fetchall()
    return [_row_to_item(row) for row in rows]


__all__ = [
    "CHECKLIST_PRESET_VERSION",
    "CLAIM_TYPE_QUALITATIVE",
    "CLAIM_TYPE_QUANTITATIVE",
    "ChecklistItem",
    "ORIGIN_DISCOVERED",
    "ORIGIN_MANUAL",
    "ORIGIN_PRESET",
    "SCOPE_COMPANY",
    "SCOPE_INDUSTRY",
    "SCOPE_UNIVERSAL",
    "STATUS_ACTIVE",
    "STATUS_RETIRED",
    "UNIVERSAL_CHECKLIST",
    "active_checklist",
    "current_checklist_version",
    "ensure_checklist_schema",
    "record_discovered_items",
    "seed_universal_checklist",
]
