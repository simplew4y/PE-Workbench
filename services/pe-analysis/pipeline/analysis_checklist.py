"""Analysis checklist: the question list every document is read against.

A project checklist has two origins. Universal items ship as presets and cover
the dimensions sell-side and buy-side research on a listed company always
touches: the forecast lines, the volume/price/cost drivers behind them, and the
opinion layer (rating, target price, valuation, risks, catalysts). Company- and
industry-specific items (芯片出货量, token 用量, 某条产线的投产时间) are
discovered while reading documents: the extractor tags every judgment with an
existing item or proposes a new one, and proposals are canonicalized into
items once per ingest run.

Both origins live in one table so a later discovery is indistinguishable from a
preset at extraction time. Discovery never re-reads a document: claims that
were extracted under a proposed question are re-keyed to the canonical item.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Protocol
from .schema import execute_schema

from .llm_client import extract_json_object

CHECKLIST_PRESET_VERSION = "pe_analysis_checklist_v2"

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

# What kind of number the item's quantitative claims usually carry. Only a hint
# for the model and for the aggregation layer; value normalization is driven by
# the unit actually printed, never by this.
VALUE_AMOUNT = "amount"
VALUE_PERCENT = "percent"
VALUE_PRICE = "price"
VALUE_VOLUME = "volume"
VALUE_MULTIPLE = "multiple"
VALUE_CATEGORICAL = "categorical"
VALUE_NONE = "none"

PROPOSAL_PENDING = "pending"
PROPOSAL_RESOLVED = "resolved"

VALID_SCOPES = frozenset({SCOPE_UNIVERSAL, SCOPE_COMPANY, SCOPE_INDUSTRY})
VALID_ORIGINS = frozenset({ORIGIN_PRESET, ORIGIN_DISCOVERED, ORIGIN_MANUAL})
VALID_CLAIM_TYPES = frozenset({CLAIM_TYPE_QUANTITATIVE, CLAIM_TYPE_QUALITATIVE})
VALID_VALUE_KINDS = frozenset(
    {VALUE_AMOUNT, VALUE_PERCENT, VALUE_PRICE, VALUE_VOLUME, VALUE_MULTIPLE, VALUE_CATEGORICAL, VALUE_NONE}
)

MAX_PROPOSALS_PER_RESOLUTION = 80


class ChecklistChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


@dataclass(frozen=True)
class ChecklistItem:
    item_key: str
    question: str
    description: str = ""
    claim_type: str = CLAIM_TYPE_QUANTITATIVE
    value_kind: str = VALUE_NONE
    period_required: bool = False
    scope: str = SCOPE_UNIVERSAL
    origin: str = ORIGIN_PRESET
    status: str = STATUS_ACTIVE
    aliases: tuple[str, ...] = ()
    discovered_from_doc_id: str = ""
    support_doc_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ChecklistProposal:
    proposal_id: str
    doc_id: str
    proposed_key: str
    question: str
    scope: str
    claim_type: str
    value_kind: str
    rationale: str = ""


# Universal dimensions of a listed-company research view. The list is what a
# sell-side earnings model and its accompanying note always express an opinion
# on; anything narrower (a product line, a customer, a regulatory event) is
# discovered per project. Descriptions are read by the model, so they say what
# belongs to the item and what does not.
UNIVERSAL_CHECKLIST: tuple[ChecklistItem, ...] = (
    # ---- forecast lines
    ChecklistItem(
        item_key="revenue",
        question="营业收入预测与增速",
        description="公司整体营业收入的绝对值预测及同比增速判断。分业务或分产品的收入不归这里，归到对应的特有问题。",
        value_kind=VALUE_AMOUNT,
        period_required=True,
        aliases=("营收", "总收入", "revenue", "top line"),
    ),
    ChecklistItem(
        item_key="net_profit",
        question="归母净利润预测与增速",
        description="归属于母公司股东的净利润预测及增速；扣非净利润也归这里并在口径中注明。",
        value_kind=VALUE_AMOUNT,
        period_required=True,
        aliases=("净利润", "归母净利", "扣非净利润", "net profit", "earnings"),
    ),
    ChecklistItem(
        item_key="eps",
        question="每股收益 EPS 预测",
        description="每股收益的预测值，一致预期比较的基础字段。",
        value_kind=VALUE_PRICE,
        period_required=True,
        aliases=("EPS", "每股盈利"),
    ),
    ChecklistItem(
        item_key="gross_margin",
        question="毛利率水平与变化",
        description="整体毛利率的预测值、环比或同比变化及其驱动因素。分业务毛利率归对应特有问题。",
        value_kind=VALUE_PERCENT,
        period_required=True,
        aliases=("毛利率", "gross margin", "GPM"),
    ),
    ChecklistItem(
        item_key="opex_and_margin",
        question="费用率与经营利润率",
        description="销售、管理、研发费用率，经营利润率或净利率的水平与趋势判断，包括经营杠杆和降本增效。",
        value_kind=VALUE_PERCENT,
        period_required=True,
        aliases=("费用率", "净利率", "营业利润率", "opex", "operating margin", "OPM", "NPM"),
    ),
    ChecklistItem(
        item_key="capex",
        question="资本开支与扩产计划",
        description="资本开支金额、新增产能规模、投产时点等扩张计划及对折旧的影响。",
        value_kind=VALUE_AMOUNT,
        period_required=True,
        aliases=("资本开支", "capex", "扩产", "在建工程"),
    ),
    ChecklistItem(
        item_key="cash_flow_and_balance_sheet",
        question="现金流、负债与资金状况",
        description="经营现金流、自由现金流、资产负债率、有息负债、应收账款与营运资本的判断。",
        value_kind=VALUE_AMOUNT,
        aliases=("经营现金流", "自由现金流", "资产负债率", "应收账款", "FCF"),
    ),
    # ---- volume / price / cost drivers
    ChecklistItem(
        item_key="volume",
        question="销量、出货量与产能利用率",
        description="公司整体的销量、出货量、装机量、产能利用率及交付节奏判断。某一具体产品的出货量归特有问题。",
        value_kind=VALUE_VOLUME,
        period_required=True,
        aliases=("出货量", "销量", "产能利用率", "交付", "shipment", "volume"),
    ),
    ChecklistItem(
        item_key="pricing",
        question="产品价格与 ASP 走势",
        description="产品售价、平均单价的水平与涨跌判断，包括提价、降价和价格战。",
        value_kind=VALUE_PRICE,
        aliases=("ASP", "单价", "均价", "提价", "降价", "价格战", "pricing"),
    ),
    ChecklistItem(
        item_key="input_costs",
        question="成本端：原材料、能源与人工",
        description="主要原材料、能源、运费、人工等成本项的价格走势及对盈利的影响。",
        value_kind=VALUE_PRICE,
        aliases=("原材料", "成本", "硅料", "锂价", "铜价", "运费", "input cost"),
    ),
    ChecklistItem(
        item_key="product_mix_and_new_business",
        question="产品结构升级与新业务放量",
        description="高毛利产品占比、新产品或新业务的贡献、业务结构变化的判断。具体某个新产品的量价归特有问题。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("产品结构", "新业务", "新产品", "第二增长曲线", "mix"),
    ),
    ChecklistItem(
        item_key="customers_and_orders",
        question="客户与订单进展",
        description="大客户导入与份额、在手订单、框架协议、客户集中度的判断。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("大客户", "在手订单", "订单", "客户集中度", "backlog"),
    ),
    ChecklistItem(
        item_key="market_share_and_competition",
        question="市场份额与竞争格局",
        description="公司市场份额、行业集中度、竞争对手动向、壁垒与国产替代进展的判断。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        value_kind=VALUE_PERCENT,
        aliases=("市场份额", "竞争格局", "份额", "壁垒", "国产替代", "market share"),
    ),
    ChecklistItem(
        item_key="industry_demand",
        question="行业需求与景气度",
        description="所处行业的总量、增速、渗透率、周期位置与供需格局的判断。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        value_kind=VALUE_VOLUME,
        aliases=("行业需求", "景气度", "渗透率", "供需", "周期", "行业增速"),
    ),
    ChecklistItem(
        item_key="overseas_expansion",
        question="海外市场与出海进展",
        description="海外收入占比、海外产能、出口订单、关税与本地化的判断。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("海外", "出海", "出口", "关税", "海外产能", "overseas"),
    ),
    ChecklistItem(
        item_key="policy_and_regulation",
        question="政策与监管影响",
        description="补贴、行业规范、反垄断、贸易政策、环保等政策事件对公司的影响判断。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("政策", "补贴", "监管", "反内卷", "关税", "regulation"),
    ),
    # ---- opinion and valuation
    ChecklistItem(
        item_key="rating",
        question="投资评级及其变动",
        description="买入、增持、中性、减持等评级，以及首次覆盖、维持、上调、下调。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        value_kind=VALUE_CATEGORICAL,
        aliases=("评级", "买入", "增持", "中性", "减持", "rating", "overweight"),
    ),
    ChecklistItem(
        item_key="target_price",
        question="目标价",
        description="目标价或合理估值区间及其调整；目标市值折算的每股价值也归这里。",
        value_kind=VALUE_PRICE,
        aliases=("目标价", "target price", "合理估值", "目标市值"),
    ),
    ChecklistItem(
        item_key="valuation",
        question="估值倍数与估值方法",
        description="给予的目标 PE、PB、EV/EBITDA、PS 倍数，DCF 关键假设，以及与可比公司的比较。",
        value_kind=VALUE_MULTIPLE,
        period_required=True,
        aliases=("PE", "市盈率", "PB", "EV/EBITDA", "DCF", "估值", "倍"),
    ),
    ChecklistItem(
        item_key="key_risks",
        question="核心风险与下行情形",
        description="分析师认为最可能影响判断的风险及其量化下行情形。模板式风险提示只有在被具体展开时才算。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("风险", "风险提示", "下行情形", "不及预期", "downside"),
    ),
    ChecklistItem(
        item_key="catalysts",
        question="催化剂与关键验证事件",
        description="未来将验证或推翻判断的具体事件：投产、发布、订单落地、数据披露及其时间点。",
        claim_type=CLAIM_TYPE_QUALITATIVE,
        aliases=("催化剂", "催化", "关键节点", "验证", "catalyst"),
    ),
    ChecklistItem(
        item_key="shareholder_return",
        question="分红、回购与股东回报",
        description="分红率、股息率、回购计划、股权激励等股东回报安排的判断。",
        value_kind=VALUE_PERCENT,
        aliases=("分红", "股息", "回购", "股东回报", "dividend", "buyback"),
    ),
)

UNIVERSAL_KEYS = frozenset(item.item_key for item in UNIVERSAL_CHECKLIST)

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _item_id(dataset_id: str, item_key: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}\0{item_key}".encode("utf-8")).hexdigest()
    return f"cli_{digest[:32]}"


def _proposal_id(dataset_id: str, doc_id: str, proposed_key: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}\0{doc_id}\0{proposed_key}".encode("utf-8")).hexdigest()
    return f"prp_{digest[:32]}"


_KEY_ALLOWED = re.compile(r"[^a-z0-9]+")


def normalize_item_key(value: str) -> str:
    """Turn a model-suggested key into a stable snake_case identifier.

    Non-ASCII suggestions (the model wrote the question itself as the key) hash
    to ``disc_<digest>`` so two documents suggesting the same Chinese phrase
    still agree on the key.
    """

    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    if not text:
        return ""
    if text.isascii():
        ascii_key = _KEY_ALLOWED.sub("_", text).strip("_")
        if len(ascii_key) >= 3:
            return ascii_key[:64]
    digest = hashlib.sha256(re.sub(r"\s+", "", text).encode("utf-8")).hexdigest()
    return f"disc_{digest[:12]}"


def ensure_checklist_schema(conn: sqlite3.Connection) -> None:
    execute_schema(conn, 
        """
        CREATE TABLE IF NOT EXISTS analysis_checklist_items (
            item_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            question TEXT NOT NULL,
            description TEXT,
            aliases_json TEXT,
            claim_type TEXT NOT NULL DEFAULT 'quantitative',
            value_kind TEXT NOT NULL DEFAULT 'none',
            period_required INTEGER NOT NULL DEFAULT 0,
            scope TEXT NOT NULL DEFAULT 'universal',
            origin TEXT NOT NULL DEFAULT 'preset',
            status TEXT NOT NULL DEFAULT 'active',
            preset_version TEXT,
            discovered_from_doc_id TEXT,
            support_doc_count INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_checklist_dataset_key
            ON analysis_checklist_items(dataset_id, item_key);
        CREATE INDEX IF NOT EXISTS idx_checklist_active
            ON analysis_checklist_items(dataset_id, status, scope);

        CREATE TABLE IF NOT EXISTS checklist_proposals (
            proposal_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            proposed_key TEXT NOT NULL,
            question TEXT NOT NULL,
            scope TEXT NOT NULL,
            claim_type TEXT NOT NULL,
            value_kind TEXT NOT NULL DEFAULT 'none',
            rationale TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            resolved_item_key TEXT,
            resolution_method TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_checklist_proposals_status
            ON checklist_proposals(dataset_id, status);
        """
    )


def seed_universal_checklist(conn: sqlite3.Connection, dataset_id: str) -> int:
    """Insert missing presets and upgrade presets from older extractor versions."""

    ensure_checklist_schema(conn)
    inserted = sum(1 for item in UNIVERSAL_CHECKLIST if _insert_item(conn, dataset_id, item))
    for item in UNIVERSAL_CHECKLIST:
        conn.execute(
            """
            UPDATE analysis_checklist_items
            SET question = ?, description = ?, aliases_json = ?, claim_type = ?,
                value_kind = ?, period_required = ?, scope = ?, preset_version = ?,
                updated_at = ?
            WHERE dataset_id = ? AND item_key = ? AND origin = ?
            """,
            (
                item.question,
                item.description or None,
                json.dumps(list(item.aliases), ensure_ascii=False),
                item.claim_type,
                item.value_kind,
                1 if item.period_required else 0,
                item.scope,
                CHECKLIST_PRESET_VERSION,
                now_iso(),
                dataset_id,
                item.item_key,
                ORIGIN_PRESET,
            ),
        )
    conn.commit()
    return inserted


def _insert_item(conn: sqlite3.Connection, dataset_id: str, item: ChecklistItem) -> bool:
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
            item_id, dataset_id, item_key, question, description, aliases_json,
            claim_type, value_kind, period_required, scope, origin, status,
            preset_version, discovered_from_doc_id, support_doc_count,
            metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _item_id(dataset_id, item.item_key),
            dataset_id,
            item.item_key,
            item.question,
            item.description or None,
            json.dumps(list(item.aliases), ensure_ascii=False),
            item.claim_type,
            item.value_kind if item.value_kind in VALID_VALUE_KINDS else VALUE_NONE,
            1 if item.period_required else 0,
            item.scope,
            item.origin,
            item.status,
            CHECKLIST_PRESET_VERSION if item.origin == ORIGIN_PRESET else None,
            item.discovered_from_doc_id or None,
            item.support_doc_count,
            json.dumps(item.metadata, ensure_ascii=False) if item.metadata else None,
            timestamp,
            timestamp,
        ),
    )
    return cursor.rowcount > 0


def _row_to_item(row: sqlite3.Row) -> ChecklistItem:
    def _json(raw: Any, fallback: Any) -> Any:
        try:
            return json.loads(raw) if raw else fallback
        except (TypeError, json.JSONDecodeError):
            return fallback

    aliases = _json(row["aliases_json"], [])
    metadata = _json(row["metadata_json"], {})
    return ChecklistItem(
        item_key=str(row["item_key"]),
        question=str(row["question"]),
        description=str(row["description"] or ""),
        claim_type=str(row["claim_type"]),
        value_kind=str(row["value_kind"] or VALUE_NONE),
        period_required=bool(row["period_required"]),
        scope=str(row["scope"]),
        origin=str(row["origin"]),
        status=str(row["status"]),
        aliases=tuple(str(alias) for alias in aliases) if isinstance(aliases, list) else (),
        discovered_from_doc_id=str(row["discovered_from_doc_id"] or ""),
        support_doc_count=int(row["support_doc_count"] or 0),
        metadata=metadata if isinstance(metadata, dict) else {},
    )


def active_checklist(conn: sqlite3.Connection, dataset_id: str) -> list[ChecklistItem]:
    ensure_checklist_schema(conn)
    rows = conn.execute(
        """
        SELECT * FROM analysis_checklist_items
        WHERE dataset_id = ? AND status = ?
        ORDER BY CASE scope WHEN 'universal' THEN 0 ELSE 1 END, created_at, item_key
        """,
        (dataset_id, STATUS_ACTIVE),
    ).fetchall()
    return [_row_to_item(row) for row in rows]


def add_checklist_item(
    conn: sqlite3.Connection,
    dataset_id: str,
    item: ChecklistItem,
    *,
    origin: str = ORIGIN_DISCOVERED,
) -> bool:
    """Append one company/industry question. Returns False when the key exists."""

    if item.scope == SCOPE_UNIVERSAL:
        raise ValueError("company or industry scope required for a non-preset item")
    candidate = ChecklistItem(
        item_key=normalize_item_key(item.item_key),
        question=item.question,
        description=item.description,
        claim_type=item.claim_type,
        value_kind=item.value_kind,
        period_required=item.period_required,
        scope=item.scope,
        origin=origin,
        status=STATUS_ACTIVE,
        aliases=item.aliases,
        discovered_from_doc_id=item.discovered_from_doc_id,
        support_doc_count=item.support_doc_count,
        metadata=item.metadata,
    )
    if not candidate.item_key:
        return False
    return _insert_item(conn, dataset_id, candidate)


# ---------------------------------------------------------------- proposals


def make_proposal(
    *,
    dataset_id: str,
    doc_id: str,
    key: str,
    question: str,
    scope: str,
    claim_type: str,
    value_kind: str = VALUE_NONE,
    rationale: str = "",
) -> ChecklistProposal | None:
    proposed_key = normalize_item_key(key or question)
    question = str(question or "").strip()
    if not proposed_key or not question:
        return None
    if scope not in (SCOPE_COMPANY, SCOPE_INDUSTRY):
        scope = SCOPE_COMPANY
    if claim_type not in VALID_CLAIM_TYPES:
        claim_type = CLAIM_TYPE_QUALITATIVE
    return ChecklistProposal(
        proposal_id=_proposal_id(dataset_id, doc_id, proposed_key),
        doc_id=doc_id,
        proposed_key=proposed_key,
        question=question[:200],
        scope=scope,
        claim_type=claim_type,
        value_kind=value_kind if value_kind in VALID_VALUE_KINDS else VALUE_NONE,
        rationale=str(rationale or "")[:300],
    )


def record_proposals(
    conn: sqlite3.Connection,
    dataset_id: str,
    proposals: Iterable[ChecklistProposal],
) -> int:
    """Store the questions one document raised that the checklist lacks."""

    ensure_checklist_schema(conn)
    timestamp = now_iso()
    stored = 0
    for proposal in proposals:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO checklist_proposals (
                proposal_id, dataset_id, doc_id, proposed_key, question, scope,
                claim_type, value_kind, rationale, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                proposal.proposal_id,
                dataset_id,
                proposal.doc_id,
                proposal.proposed_key,
                proposal.question,
                proposal.scope,
                proposal.claim_type,
                proposal.value_kind,
                proposal.rationale or None,
                PROPOSAL_PENDING,
                timestamp,
            ),
        )
        stored += cursor.rowcount
    return stored


def pending_proposals(conn: sqlite3.Connection, dataset_id: str) -> list[sqlite3.Row]:
    ensure_checklist_schema(conn)
    return conn.execute(
        """
        SELECT * FROM checklist_proposals
        WHERE dataset_id = ? AND status = ?
        ORDER BY created_at, proposal_id
        """,
        (dataset_id, PROPOSAL_PENDING),
    ).fetchall()


@dataclass
class ProposalResolution:
    """Outcome of one canonicalization pass.

    ``mapping`` goes from ``(doc_id, proposed_key)`` to the item key that now
    owns the claims extracted under that proposal.
    """

    mapping: dict[tuple[str, str], str] = field(default_factory=dict)
    created_items: list[str] = field(default_factory=list)
    merged_into_existing: int = 0
    method: str = "none"
    error: str = ""


def resolve_pending_proposals(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    llm_client: ChecklistChatClient | None,
    company_name: str = "",
) -> ProposalResolution:
    """Fold pending proposals into the checklist.

    With a model, bounded batches decide for every pending proposal whether it is a
    rewording of an existing item, a duplicate of another proposal, or a new
    question worth tracking. Without a model, proposals that share a normalized
    key become one item each; that is the deterministic floor, not the target.
    """

    rows = pending_proposals(conn, dataset_id)
    resolution = ProposalResolution()
    if not rows:
        return resolution

    existing = active_checklist(conn, dataset_id)
    decisions: dict[str, dict[str, Any]] = {}
    if llm_client is not None:
        try:
            conn.commit()
            for start in range(0, len(rows), MAX_PROPOSALS_PER_RESOLUTION):
                decisions.update(_model_decisions(
                    rows[start:start + MAX_PROPOSALS_PER_RESOLUTION], existing, llm_client, company_name
                ))
            resolution.method = "llm"
        except Exception as exc:  # noqa: BLE001 - fall back to the deterministic floor
            resolution.error = f"{type(exc).__name__}: {exc}"[:300]
            decisions = {}
    if not decisions:
        decisions = _deterministic_decisions(rows)
        resolution.method = "deterministic_fallback" if resolution.error else "deterministic"
    else:
        # A valid partial model response must not silently strand the remaining proposals.
        for key, decision in _deterministic_decisions(rows).items():
            decisions.setdefault(key, decision)

    existing_keys = {item.item_key for item in existing}
    timestamp = now_iso()
    for row in rows:
        proposed_key = str(row["proposed_key"])
        decision = decisions.get(proposed_key)
        if decision is None:
            continue
        target_key = normalize_item_key(str(decision.get("item_key") or proposed_key))
        if not target_key:
            continue
        if target_key not in existing_keys:
            claim_type = str(decision.get("claim_type") or row["claim_type"])
            scope = str(decision.get("scope") or row["scope"])
            item = ChecklistItem(
                item_key=target_key,
                question=str(decision.get("question") or row["question"]).strip()[:200],
                description=str(decision.get("description") or "").strip()[:400],
                claim_type=claim_type if claim_type in VALID_CLAIM_TYPES else CLAIM_TYPE_QUALITATIVE,
                value_kind=str(decision.get("value_kind") or row["value_kind"] or VALUE_NONE),
                period_required=bool(decision.get("period_required", False)),
                scope=scope if scope in (SCOPE_COMPANY, SCOPE_INDUSTRY) else SCOPE_COMPANY,
                origin=ORIGIN_DISCOVERED,
                discovered_from_doc_id=str(row["doc_id"]),
            )
            if add_checklist_item(conn, dataset_id, item):
                existing_keys.add(target_key)
                resolution.created_items.append(target_key)
        else:
            resolution.merged_into_existing += 1

        resolution.mapping[(str(row["doc_id"]), proposed_key)] = target_key
        conn.execute(
            """
            UPDATE checklist_proposals
            SET status = ?, resolved_item_key = ?, resolution_method = ?, resolved_at = ?
            WHERE proposal_id = ?
            """,
            (PROPOSAL_RESOLVED, target_key, resolution.method, timestamp, row["proposal_id"]),
        )

    # Support counts make a question raised by one document distinguishable
    # from one raised by eight, without deciding here which threshold matters.
    conn.execute(
        """
        UPDATE analysis_checklist_items
        SET support_doc_count = (
                SELECT COUNT(DISTINCT p.doc_id) FROM checklist_proposals p
                WHERE p.dataset_id = analysis_checklist_items.dataset_id
                  AND p.resolved_item_key = analysis_checklist_items.item_key
            ),
            updated_at = ?
        WHERE dataset_id = ? AND origin = ?
        """,
        (timestamp, dataset_id, ORIGIN_DISCOVERED),
    )
    conn.commit()
    return resolution


def _deterministic_decisions(rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    decisions: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row["proposed_key"])
        decisions.setdefault(
            key,
            {
                "item_key": key,
                "question": row["question"],
                "scope": row["scope"],
                "claim_type": row["claim_type"],
                "value_kind": row["value_kind"],
            },
        )
    return decisions


def _model_decisions(
    rows: list[sqlite3.Row],
    existing: list[ChecklistItem],
    llm_client: ChecklistChatClient,
    company_name: str,
) -> dict[str, dict[str, Any]]:
    # Collapse identical keys before asking so the model sees one line per
    # distinct proposal, with how many documents raised it.
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = grouped.setdefault(
            str(row["proposed_key"]),
            {
                "question": row["question"],
                "scope": row["scope"],
                "claim_type": row["claim_type"],
                "docs": 0,
            },
        )
        entry["docs"] += 1

    existing_lines = "\n".join(
        f"- {item.item_key}: {item.question}" + (f"（{item.description}）" if item.description else "")
        for item in existing
    )
    proposal_lines = "\n".join(
        f"- {key}: {entry['question']} [scope={entry['scope']}, claim_type={entry['claim_type']}, 提出文档数={entry['docs']}]"
        for key, entry in grouped.items()
    )
    company_line = f"研究标的：{company_name}\n" if company_name else ""
    messages = [
        {
            "role": "system",
            "content": (
                "你维护一份投研分析问题清单。清单用于把多家机构对同一问题的观点聚合成共识与分歧，"
                "因此每个问题必须是一个可以被多家机构分别回答的独立分析维度，粒度与「毛利率」「某产品出货量」相当。\n"
                "现在给你已有清单和新提出的候选问题。对每个候选问题做一个决定：\n"
                "1. 它是已有问题的换种说法，则归并到该已有问题，item_key 填已有问题的键；\n"
                "2. 它与另一个候选问题是同一问题，则给它们同一个新的 item_key；\n"
                "3. 它是一个新的、值得跨机构比较的问题，则创建，给出简洁问题名和一句描述。\n"
                "不要因为只有一份文档提出就拒绝创建；也不要把一次性事件或过于具体的数字当成问题。\n"
                "item_key 用英文 snake_case。只输出一个 JSON 对象：\n"
                '{"decisions": [{"proposed_key": str, "item_key": str, "question": str, '
                '"description": str, "scope": "company|industry", '
                '"claim_type": "quantitative|qualitative", '
                '"value_kind": "amount|percent|price|volume|multiple|categorical|none", '
                '"period_required": bool}]}'
            ),
        },
        {
            "role": "user",
            "content": f"{company_line}已有清单：\n{existing_lines}\n\n候选问题：\n{proposal_lines}",
        },
    ]
    raw = llm_client.chat(messages, max_tokens=3000, temperature=0.0)
    payload = extract_json_object(raw)
    decisions: dict[str, dict[str, Any]] = {}
    entries = payload.get("decisions")
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        proposed_key = normalize_item_key(str(entry.get("proposed_key") or ""))
        if proposed_key in grouped and proposed_key not in decisions:
            decisions[proposed_key] = entry
    return decisions


__all__ = [
    "CHECKLIST_PRESET_VERSION",
    "CLAIM_TYPE_QUALITATIVE",
    "CLAIM_TYPE_QUANTITATIVE",
    "ChecklistItem",
    "ChecklistProposal",
    "ORIGIN_DISCOVERED",
    "ORIGIN_MANUAL",
    "ORIGIN_PRESET",
    "PROPOSAL_PENDING",
    "PROPOSAL_RESOLVED",
    "ProposalResolution",
    "SCOPE_COMPANY",
    "SCOPE_INDUSTRY",
    "SCOPE_UNIVERSAL",
    "STATUS_ACTIVE",
    "STATUS_RETIRED",
    "UNIVERSAL_CHECKLIST",
    "UNIVERSAL_KEYS",
    "VALID_VALUE_KINDS",
    "VALUE_AMOUNT",
    "VALUE_CATEGORICAL",
    "VALUE_MULTIPLE",
    "VALUE_NONE",
    "VALUE_PERCENT",
    "VALUE_PRICE",
    "VALUE_VOLUME",
    "active_checklist",
    "add_checklist_item",
    "ensure_checklist_schema",
    "make_proposal",
    "normalize_item_key",
    "pending_proposals",
    "record_proposals",
    "resolve_pending_proposals",
    "seed_universal_checklist",
]
