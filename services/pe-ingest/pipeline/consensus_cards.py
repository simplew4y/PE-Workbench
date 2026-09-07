"""Consensus and divergence cards built from atomic claims.

A card answers one checklist question for one period: what the sample of
institutions agrees on, who sits at the optimistic and cautious ends and why,
what the disagreement is really about, how large the financial gap is, what
changed recently, and which evidence would settle it. Every number on a card is
computed here from ``atomic_claims``; the model only writes the prose fields
(title, root cause, verification evidence) from the numbers it is handed, and a
template fills those fields when no model is configured.

Cards are derived data. They are rebuilt from scratch after every ingest and
every card links back to the claims and evidence chunks it was built from.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import statistics
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Protocol, Sequence

try:  # pragma: no cover - import shape depends on caller
    from .analysis_checklist import CLAIM_TYPE_QUANTITATIVE, ChecklistItem, active_checklist  # type: ignore
    from .llm_client import extract_json_object  # type: ignore
except ImportError:  # pragma: no cover
    from analysis_checklist import CLAIM_TYPE_QUANTITATIVE, ChecklistItem, active_checklist  # type: ignore
    from llm_client import extract_json_object  # type: ignore

CARD_BUILDER_VERSION = "pe_consensus_cards_v1"

RECENT_WINDOW_DAYS = 30
CARDS_PER_NARRATIVE_CALL = 12

CARD_CONSENSUS = "consensus"
CARD_DIVERGENCE = "divergence"
CARD_SINGLE_VIEW = "single_view"

# Spread beyond which a numeric sample counts as divergent. Relative for
# scale units, absolute for percentage-like units.
RELATIVE_DIVERGENCE_SPREAD = 0.15
ABSOLUTE_DIVERGENCE_SPREAD = {"%": 3.0, "pp": 2.0}
STANCE_CONSENSUS_SHARE = 0.75

COMPANY_ISSUER_KEY = "company"


class CardChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


@dataclass
class ClaimView:
    claim_id: str
    doc_id: str
    item_key: str
    issuer_key: str
    issuer_name: str
    issuer_kind: str
    claim_text: str
    reason: str
    stance: str
    measure: str
    value_numeric: float | None
    unit: str
    currency: str
    value_canonical: float | None
    canonical_unit: str
    period_canonical: str
    scope_note: str
    confidence: float
    as_of_date: str
    published_date: str
    quality_status: str
    revision_direction: str
    revision_delta: float | None
    evidence_ids: list[str]
    evidence_quotes: list[dict[str, str]]

    def value_display(self) -> str:
        if self.value_numeric is None:
            return ""
        return format_value(self.value_numeric, self.unit, self.currency)


@dataclass
class Card:
    card_id: str
    item_key: str
    question: str
    period_canonical: str
    measure: str
    card_type: str
    issuer_count: int
    coverage_total: int
    stats: dict[str, Any] = field(default_factory=dict)
    bull: list[dict[str, Any]] = field(default_factory=list)
    bear: list[dict[str, Any]] = field(default_factory=list)
    stance_counts: dict[str, int] = field(default_factory=dict)
    recent_changes: dict[str, Any] = field(default_factory=dict)
    company_view: dict[str, Any] | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    narrative: dict[str, str] = field(default_factory=dict)
    priority: float = 0.0
    excluded_low_quality: int = 0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- formatting


def _fmt_number(value: float, digits: int = 1) -> str:
    if float(value).is_integer() or abs(value) >= 1000:
        return f"{value:,.0f}"
    return f"{value:,.{digits}f}".rstrip("0").rstrip(".")


def format_value(value: float, unit: str, currency: str = "") -> str:
    """Render a number the way an analyst would write it."""

    unit = unit or ""
    if unit == "%":
        return f"{_fmt_number(value)}%"
    if unit in ("pp", "x"):
        return f"{_fmt_number(value)}{unit}"
    text = f"{_fmt_number(value, 2)} {unit}".strip()
    if currency and currency != "CNY" and currency not in unit:
        return f"{currency} {text}"
    return text


def format_canonical(value: float, canonical_unit: str, currency: str = "") -> str:
    """Render a canonical value in a readable scale (元 → 亿元 / 百万美元)."""

    if canonical_unit == "元":
        if currency in ("", "CNY"):
            if abs(value) >= 1e8:
                return f"{_fmt_number(value / 1e8, 1)} 亿元"
            if abs(value) >= 1e4:
                return f"{_fmt_number(value / 1e4, 1)} 万元"
            return f"{_fmt_number(value, 2)} 元"
        scale, word = (1e9, "bn") if abs(value) >= 1e9 else (1e6, "mn") if abs(value) >= 1e6 else (1.0, "")
        return f"{currency} {_fmt_number(value / scale, 2)}{word}".strip()
    if canonical_unit == "元/股":
        return f"{currency or 'CNY'} {_fmt_number(value, 2)}/股".replace("CNY ", "")
    return format_value(value, canonical_unit, currency)


# ---------------------------------------------------------------- schema


def ensure_cards_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS consensus_cards (
            card_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            question TEXT NOT NULL,
            period_canonical TEXT,
            measure TEXT,
            card_type TEXT NOT NULL,
            title TEXT,
            issuer_count INTEGER NOT NULL DEFAULT 0,
            coverage_total INTEGER NOT NULL DEFAULT 0,
            priority REAL NOT NULL DEFAULT 0,
            stats_json TEXT,
            bull_json TEXT,
            bear_json TEXT,
            stance_counts_json TEXT,
            recent_changes_json TEXT,
            company_view_json TEXT,
            narrative_json TEXT,
            sources_json TEXT,
            narrative_method TEXT,
            as_of_date TEXT NOT NULL,
            builder_version TEXT NOT NULL,
            built_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_consensus_cards_dataset
            ON consensus_cards(dataset_id, card_type, priority);
        """
    )


# ---------------------------------------------------------------- loading


def _load_claims(conn: sqlite3.Connection, dataset_id: str) -> list[ClaimView]:
    rows = conn.execute(
        """
        SELECT c.*, i.issuer_name, i.issuer_kind
        FROM atomic_claims c
        LEFT JOIN issuers i ON i.dataset_id = c.dataset_id AND i.issuer_key = c.issuer_key
        WHERE c.dataset_id = ? AND c.status = 'active' AND c.issuer_key IS NOT NULL
        ORDER BY c.item_key, c.as_of_date, c.created_at
        """,
        (dataset_id,),
    ).fetchall()
    views: list[ClaimView] = []
    for row in rows:
        try:
            evidence_ids = json.loads(row["evidence_ids_json"] or "[]")
        except json.JSONDecodeError:
            evidence_ids = []
        try:
            quotes = json.loads(row["evidence_quotes_json"] or "[]")
        except json.JSONDecodeError:
            quotes = []
        views.append(
            ClaimView(
                claim_id=str(row["claim_id"]),
                doc_id=str(row["doc_id"]),
                item_key=str(row["item_key"]),
                issuer_key=str(row["issuer_key"]),
                issuer_name=str(row["issuer_name"] or row["issuer_key"]),
                issuer_kind=str(row["issuer_kind"] or "unknown"),
                claim_text=str(row["claim_text"] or ""),
                reason=str(row["reason"] or ""),
                stance=str(row["stance"] or "neutral"),
                measure=str(row["measure"] or "other"),
                value_numeric=row["value_numeric"],
                unit=str(row["unit"] or ""),
                currency=str(row["currency"] or ""),
                value_canonical=row["value_canonical"],
                canonical_unit=str(row["canonical_unit"] or ""),
                period_canonical=str(row["period_canonical"] or ""),
                scope_note=str(row["scope_note"] or ""),
                confidence=float(row["confidence"] or 0.0),
                as_of_date=str(row["as_of_date"] or ""),
                published_date=str(row["published_date"] or ""),
                quality_status=str(row["quality_status"] or ""),
                revision_direction=str(row["revision_direction"] or ""),
                revision_delta=row["revision_delta"],
                evidence_ids=[str(v) for v in evidence_ids] if isinstance(evidence_ids, list) else [],
                evidence_quotes=[q for q in quotes if isinstance(q, dict)] if isinstance(quotes, list) else [],
            )
        )
    return views


# ---------------------------------------------------------------- building


def _latest_per_issuer(claims: Sequence[ClaimView]) -> dict[str, ClaimView]:
    latest: dict[str, ClaimView] = {}
    for claim in claims:
        current = latest.get(claim.issuer_key)
        if current is None or (claim.as_of_date, claim.confidence) >= (current.as_of_date, current.confidence):
            latest[claim.issuer_key] = claim
    return latest


def _source(claim: ClaimView) -> dict[str, Any]:
    return {
        "claim_id": claim.claim_id,
        "doc_id": claim.doc_id,
        "issuer_key": claim.issuer_key,
        "issuer_name": claim.issuer_name,
        "issuer_kind": claim.issuer_kind,
        "stance": claim.stance,
        "claim_text": claim.claim_text,
        "reason": claim.reason,
        "value_display": claim.value_display(),
        "scope_note": claim.scope_note,
        "as_of_date": claim.as_of_date,
        "confidence": round(claim.confidence, 2),
        "quality_status": claim.quality_status,
        "evidence_ids": claim.evidence_ids,
        "quotes": claim.evidence_quotes[:3],
    }


def _side_entry(claim: ClaimView, deviation_pct: float | None = None) -> dict[str, Any]:
    entry = {
        "issuer_key": claim.issuer_key,
        "issuer_name": claim.issuer_name,
        "value_display": claim.value_display(),
        "reason": claim.reason or claim.claim_text,
        "claim_id": claim.claim_id,
    }
    if deviation_pct is not None:
        entry["deviation_from_median_pct"] = round(deviation_pct, 1)
    return entry


def _parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _recent_changes(series: Sequence[ClaimView], as_of: date, window_days: int) -> dict[str, Any]:
    cutoff = as_of - timedelta(days=window_days)
    changes: list[dict[str, Any]] = []
    for claim in series:
        if claim.revision_direction not in ("up", "down", "changed"):
            continue
        when = _parse_date(claim.as_of_date)
        if when is None or when < cutoff:
            continue
        entry: dict[str, Any] = {
            "issuer_key": claim.issuer_key,
            "issuer_name": claim.issuer_name,
            "direction": claim.revision_direction,
            "as_of_date": claim.as_of_date,
            "value_display": claim.value_display(),
            "claim_id": claim.claim_id,
        }
        if claim.revision_delta is not None and claim.canonical_unit:
            entry["delta_display"] = format_canonical(claim.revision_delta, claim.canonical_unit, claim.currency)
        changes.append(entry)
    return {
        "window_days": window_days,
        "up": sum(1 for c in changes if c["direction"] == "up"),
        "down": sum(1 for c in changes if c["direction"] == "down"),
        "changed": sum(1 for c in changes if c["direction"] == "changed"),
        "items": changes[:10],
    }


def _numeric_stats(sample: Sequence[ClaimView]) -> tuple[dict[str, Any], list[ClaimView]]:
    """Statistics over the claims that share the majority unit and currency."""

    numeric = [c for c in sample if c.value_canonical is not None and c.canonical_unit]
    if not numeric:
        return {}, []
    unit_votes: dict[tuple[str, str], int] = {}
    for claim in numeric:
        key = (claim.canonical_unit, claim.currency)
        unit_votes[key] = unit_votes.get(key, 0) + 1
    (unit, currency), _count = max(unit_votes.items(), key=lambda kv: kv[1])
    comparable = [c for c in numeric if (c.canonical_unit, c.currency) == (unit, currency)]
    values = [float(c.value_canonical) for c in comparable]  # type: ignore[arg-type]
    median = statistics.median(values)
    mean = statistics.fmean(values)
    low, high = min(values), max(values)
    if unit in ABSOLUTE_DIVERGENCE_SPREAD:
        spread = high - low
        spread_display = f"{_fmt_number(spread)}{'pp' if unit == '%' else unit}"
        divergent = spread > ABSOLUTE_DIVERGENCE_SPREAD[unit]
    else:
        spread = (high - low) / abs(median) if median else 0.0
        spread_display = f"{spread * 100:.0f}%"
        divergent = spread > RELATIVE_DIVERGENCE_SPREAD
    stats = {
        "unit": unit,
        "currency": currency,
        "n": len(comparable),
        "excluded_unit_mismatch": len(numeric) - len(comparable),
        "median": median,
        "mean": mean,
        "low": low,
        "high": high,
        "median_display": format_canonical(median, unit, currency),
        "mean_display": format_canonical(mean, unit, currency),
        "range_display": f"{format_canonical(low, unit, currency)} ~ {format_canonical(high, unit, currency)}",
        "spread": round(spread, 4),
        "spread_display": spread_display,
        "divergent": divergent,
    }
    return stats, comparable


def _stance_counts(sample: Sequence[ClaimView]) -> dict[str, int]:
    counts = {"bullish": 0, "bearish": 0, "neutral": 0}
    for claim in sample:
        counts[claim.stance if claim.stance in counts else "neutral"] += 1
    return counts


def _card_id(dataset_id: str, item_key: str, period: str, measure: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}\0{item_key}\0{period}\0{measure}".encode("utf-8")).hexdigest()
    return f"card_{digest[:32]}"


def _build_card(
    *,
    dataset_id: str,
    item: ChecklistItem,
    period: str,
    measure: str,
    series: Sequence[ClaimView],
    coverage_total: int,
    as_of: date,
    window_days: int,
) -> Card:
    institutional = [c for c in series if c.issuer_kind != "company"]
    company_claims = [c for c in series if c.issuer_kind == "company"]
    latest = _latest_per_issuer(institutional)
    sample = list(latest.values())
    stance_counts = _stance_counts(sample)
    stats, comparable = _numeric_stats(sample)

    card = Card(
        card_id=_card_id(dataset_id, item.item_key, period, measure),
        item_key=item.item_key,
        question=item.question,
        period_canonical=period,
        measure=measure,
        card_type=CARD_SINGLE_VIEW,
        issuer_count=len(sample),
        coverage_total=coverage_total,
        stats=stats,
        stance_counts=stance_counts,
        recent_changes=_recent_changes(institutional, as_of, window_days),
        sources=[_source(c) for c in sorted(series, key=lambda c: (c.issuer_name, c.as_of_date))],
    )

    if comparable:
        median = stats["median"]
        ordered = sorted(comparable, key=lambda c: float(c.value_canonical))  # type: ignore[arg-type]
        deviation = (
            lambda c: ((float(c.value_canonical) - median) / abs(median) * 100.0) if median else None  # type: ignore[arg-type]
        )
        card.bull = [_side_entry(c, deviation(c)) for c in reversed(ordered[-2:])]
        # With one comparable value there is no cautious side to show.
        card.bear = [_side_entry(c, deviation(c)) for c in ordered[:2]] if len(ordered) > 1 else []
    else:
        card.bull = [_side_entry(c) for c in sample if c.stance == "bullish"][:3]
        card.bear = [_side_entry(c) for c in sample if c.stance == "bearish"][:3]

    if company_claims:
        guidance = _latest_per_issuer(company_claims)[COMPANY_ISSUER_KEY]
        card.company_view = _side_entry(guidance)

    if len(sample) >= 2:
        if comparable and len(comparable) >= 2:
            card.card_type = CARD_DIVERGENCE if stats["divergent"] else CARD_CONSENSUS
        else:
            dominant = max(stance_counts.values())
            if stance_counts["bullish"] and stance_counts["bearish"]:
                card.card_type = CARD_DIVERGENCE
            elif dominant / len(sample) >= STANCE_CONSENSUS_SHARE:
                card.card_type = CARD_CONSENSUS
            else:
                card.card_type = CARD_DIVERGENCE

    spread_term = float(stats.get("spread", 0.0)) if stats else (
        1.0 if (stance_counts["bullish"] and stance_counts["bearish"]) else 0.0
    )
    card.priority = round(len(sample) * (1.0 + min(spread_term, 2.0)) + card.recent_changes["up"] + card.recent_changes["down"], 3)
    return card


def build_cards(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    as_of: date | None = None,
    window_days: int = RECENT_WINDOW_DAYS,
) -> list[Card]:
    """Compute every card for a dataset without touching the model."""

    as_of = as_of or datetime.now(timezone.utc).date()
    items = {item.item_key: item for item in active_checklist(conn, dataset_id)}
    claims = _load_claims(conn, dataset_id)
    usable = [c for c in claims if c.quality_status != "review_required" and c.item_key in items]
    low_quality: dict[str, int] = {}
    for claim in claims:
        if claim.quality_status == "review_required":
            low_quality[claim.item_key] = low_quality.get(claim.item_key, 0) + 1

    coverage_total = len({c.issuer_key for c in usable if c.issuer_kind != "company"})

    groups: dict[tuple[str, str, str], list[ClaimView]] = {}
    for claim in usable:
        item = items[claim.item_key]
        if item.claim_type == CLAIM_TYPE_QUANTITATIVE:
            key = (claim.item_key, claim.period_canonical, claim.measure)
        else:
            key = (claim.item_key, "", "")
        groups.setdefault(key, []).append(claim)

    cards: list[Card] = []
    for (item_key, period, measure), series in groups.items():
        card = _build_card(
            dataset_id=dataset_id,
            item=items[item_key],
            period=period,
            measure=measure,
            series=series,
            coverage_total=coverage_total,
            as_of=as_of,
            window_days=window_days,
        )
        card.excluded_low_quality = low_quality.get(item_key, 0)
        cards.append(card)
    cards.sort(key=lambda c: (-c.priority, c.item_key, c.period_canonical))
    return cards


# ---------------------------------------------------------------- narrative


_TYPE_LABEL = {CARD_CONSENSUS: "共识", CARD_DIVERGENCE: "分歧", CARD_SINGLE_VIEW: "单一观点"}


def template_narrative(card: Card) -> dict[str, str]:
    """Prose from the numbers alone, used when no model is configured."""

    label = _TYPE_LABEL[card.card_type]
    period = f"{card.period_canonical} " if card.period_canonical else ""
    stats = card.stats
    if card.card_type == CARD_SINGLE_VIEW and card.sources:
        only = card.bull[0] if card.bull else card.bear[0] if card.bear else None
        who = only["issuer_name"] if only else card.sources[0]["issuer_name"]
        consensus = f"仅 {who} 一家覆盖" + (f"，{only['value_display']}" if only and only.get("value_display") else "") + "。"
    elif stats:
        consensus = (
            f"中位数 {stats['median_display']}，区间 {stats['range_display']}，"
            f"覆盖 {card.issuer_count}/{card.coverage_total} 家机构。"
        )
    else:
        counts = card.stance_counts
        consensus = (
            f"{counts['bullish']} 家偏正面、{counts['bearish']} 家偏负面、{counts['neutral']} 家中性，"
            f"覆盖 {card.issuer_count}/{card.coverage_total} 家机构。"
        )
    bull = "；".join(
        f"{e['issuer_name']}{'（' + e['value_display'] + '）' if e.get('value_display') else ''}：{e['reason']}"
        for e in card.bull
    ) or "无"
    bear = "；".join(
        f"{e['issuer_name']}{'（' + e['value_display'] + '）' if e.get('value_display') else ''}：{e['reason']}"
        for e in card.bear
    ) or "无"
    impact = ""
    if card.bull and card.bull[0].get("deviation_from_median_pct") is not None:
        impact = f"最高预测高于样本中位数 {card.bull[0]['deviation_from_median_pct']:+.1f}%。"
    changes = card.recent_changes
    recent = f"过去 {changes['window_days']} 天，{changes['up']} 家上调，{changes['down']} 家下调。"
    return {
        "title": f"{label}：{period}{card.question}",
        "consensus_line": consensus,
        "bull_line": bull,
        "bear_line": bear,
        "root_cause": "" if card.card_type != CARD_DIVERGENCE else "各方理由见乐观方与谨慎方。",
        "financial_impact": impact,
        "recent_changes_line": recent,
        "verification_evidence": "",
    }


def _card_brief(card: Card) -> dict[str, Any]:
    return {
        "card_id": card.card_id,
        "question": card.question,
        "period": card.period_canonical,
        "measure": card.measure,
        "type": card.card_type,
        "issuer_count": card.issuer_count,
        "coverage_total": card.coverage_total,
        "stats": {k: v for k, v in card.stats.items() if k.endswith("_display") or k in ("n", "divergent")},
        "stance_counts": card.stance_counts,
        "bull": card.bull,
        "bear": card.bear,
        "company_view": card.company_view,
        "recent_changes": {k: v for k, v in card.recent_changes.items() if k != "items"},
        "recent_items": [
            f"{i['issuer_name']} {i['direction']} {i.get('delta_display', '')}".strip() for i in card.recent_changes["items"][:5]
        ],
        "all_positions": [
            f"{s['issuer_name']}[{s['stance']}]{'(' + s['value_display'] + ')' if s['value_display'] else ''}: {s['claim_text']}"
            for s in card.sources[:12]
        ],
    }


def _narrative_messages(cards: Sequence[Card], company_name: str) -> list[dict[str, str]]:
    briefs = [_card_brief(card) for card in cards]
    company_line = f"研究标的：{company_name}\n" if company_name else ""
    return [
        {
            "role": "system",
            "content": (
                "你为投研团队撰写「共识/分歧卡片」的文字部分。每张卡片的数字（中位数、区间、覆盖、上调下调）已经算好，"
                "你只根据给定的机构观点写判断性文字，不得新增数字或机构。\n"
                "对每张卡片输出：\n"
                "title：一句话点出核心共识或核心分歧是什么（如「2026 年收入兑现速度」），不超过 25 字；\n"
                "consensus_line：样本内共识一句话，引用给定的中位数/区间/覆盖；\n"
                "bull_line：乐观方是谁、预测多少、主要依据；\n"
                "bear_line：谨慎方是谁、主要顾虑；\n"
                "root_cause：分歧根因，说明分歧来自哪个驱动因素的判断差异，并排除不是根因的因素；共识卡片写共识建立在什么假设上；"
                "type 为 single_view 的卡片只有一家机构，不存在共识或分歧，consensus_line 写「仅 X 一家覆盖」，"
                "root_cause 写该机构判断依赖的核心假设，financial_impact 留空；\n"
                "financial_impact：分歧对财务预测的量级影响一句话；\n"
                "recent_changes_line：最近变化一句话；\n"
                "verification_evidence：列出能验证或推翻判断的具体证据（订单、产能、客户部署、价格等），用顿号分隔。\n"
                "只输出一个 JSON 对象：{\"cards\": [{\"card_id\": str, \"title\": str, \"consensus_line\": str, "
                "\"bull_line\": str, \"bear_line\": str, \"root_cause\": str, \"financial_impact\": str, "
                "\"recent_changes_line\": str, \"verification_evidence\": str}]}"
            ),
        },
        {"role": "user", "content": f"{company_line}卡片数据：\n{json.dumps(briefs, ensure_ascii=False)}"},
    ]


_NARRATIVE_FIELDS = (
    "title",
    "consensus_line",
    "bull_line",
    "bear_line",
    "root_cause",
    "financial_impact",
    "recent_changes_line",
    "verification_evidence",
)


def write_narratives(
    cards: Sequence[Card],
    *,
    llm_client: CardChatClient | None,
    company_name: str = "",
) -> tuple[str, list[str]]:
    """Fill each card's prose; returns ``(method, errors)``."""

    for card in cards:
        card.narrative = template_narrative(card)
    if llm_client is None or not cards:
        return "template", []

    errors: list[str] = []
    filled = 0
    for start in range(0, len(cards), CARDS_PER_NARRATIVE_CALL):
        batch = cards[start : start + CARDS_PER_NARRATIVE_CALL]
        try:
            raw = llm_client.chat(_narrative_messages(batch, company_name), max_tokens=6000, temperature=0.2)
            payload = extract_json_object(raw)
        except Exception as exc:  # noqa: BLE001 - template narrative stays in place
            errors.append(f"cards {start}-{start + len(batch)}: {type(exc).__name__}: {exc}"[:300])
            continue
        by_id = {card.card_id: card for card in batch}
        entries = payload.get("cards")
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            card = by_id.get(str(entry.get("card_id") or ""))
            if card is None:
                continue
            for field_name in _NARRATIVE_FIELDS:
                value = str(entry.get(field_name) or "").strip()
                if value:
                    card.narrative[field_name] = value[:600]
            filled += 1
    if filled == 0:
        return "template_fallback" if errors else "template", errors
    return "llm" if filled == len(cards) else "llm_partial", errors


# ---------------------------------------------------------------- persistence


def store_cards(
    conn: sqlite3.Connection,
    dataset_id: str,
    cards: Sequence[Card],
    *,
    as_of: date,
    narrative_method: str,
) -> None:
    ensure_cards_schema(conn)
    conn.execute("DELETE FROM consensus_cards WHERE dataset_id = ?", (dataset_id,))
    timestamp = now_iso()
    for card in cards:
        conn.execute(
            """
            INSERT INTO consensus_cards (
                card_id, dataset_id, item_key, question, period_canonical, measure,
                card_type, title, issuer_count, coverage_total, priority, stats_json,
                bull_json, bear_json, stance_counts_json, recent_changes_json,
                company_view_json, narrative_json, sources_json, narrative_method,
                as_of_date, builder_version, built_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                card.card_id,
                dataset_id,
                card.item_key,
                card.question,
                card.period_canonical or None,
                card.measure or None,
                card.card_type,
                card.narrative.get("title") or None,
                card.issuer_count,
                card.coverage_total,
                card.priority,
                json.dumps(card.stats, ensure_ascii=False),
                json.dumps(card.bull, ensure_ascii=False),
                json.dumps(card.bear, ensure_ascii=False),
                json.dumps(card.stance_counts, ensure_ascii=False),
                json.dumps(card.recent_changes, ensure_ascii=False),
                json.dumps(card.company_view, ensure_ascii=False) if card.company_view else None,
                json.dumps(card.narrative, ensure_ascii=False),
                json.dumps(card.sources, ensure_ascii=False),
                narrative_method,
                as_of.isoformat(),
                CARD_BUILDER_VERSION,
                timestamp,
            ),
        )
    conn.commit()


def build_consensus_cards(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    llm_client: CardChatClient | None,
    company_name: str = "",
    as_of: date | None = None,
    window_days: int = RECENT_WINDOW_DAYS,
) -> dict[str, Any]:
    """Rebuild all cards for a dataset: compute, narrate, store."""

    as_of = as_of or datetime.now(timezone.utc).date()
    ensure_cards_schema(conn)
    cards = build_cards(conn, dataset_id, as_of=as_of, window_days=window_days)
    method, errors = write_narratives(cards, llm_client=llm_client, company_name=company_name)
    store_cards(conn, dataset_id, cards, as_of=as_of, narrative_method=method)
    counts = {kind: sum(1 for c in cards if c.card_type == kind) for kind in _TYPE_LABEL}
    return {
        "cards": len(cards),
        "by_type": counts,
        "narrative_method": method,
        "as_of_date": as_of.isoformat(),
        "errors": errors[:10],
    }


def load_cards(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    card_types: Sequence[str] | None = None,
    item_key: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Read stored cards as plain dictionaries (for the API and the agent tool)."""

    ensure_cards_schema(conn)
    clauses = ["dataset_id = ?"]
    params: list[Any] = [dataset_id]
    if card_types:
        clauses.append(f"card_type IN ({','.join('?' for _ in card_types)})")
        params.extend(card_types)
    if item_key:
        clauses.append("item_key = ?")
        params.append(item_key)
    rows = conn.execute(
        f"SELECT * FROM consensus_cards WHERE {' AND '.join(clauses)} ORDER BY priority DESC, item_key LIMIT ?",
        (*params, limit),
    ).fetchall()
    result = []
    for row in rows:
        entry = {key: row[key] for key in row.keys() if not key.endswith("_json")}
        for key in row.keys():
            if key.endswith("_json"):
                try:
                    entry[key[:-5]] = json.loads(row[key]) if row[key] else None
                except json.JSONDecodeError:
                    entry[key[:-5]] = None
        result.append(entry)
    return result


__all__ = [
    "CARD_BUILDER_VERSION",
    "CARD_CONSENSUS",
    "CARD_DIVERGENCE",
    "CARD_SINGLE_VIEW",
    "Card",
    "build_cards",
    "build_consensus_cards",
    "ensure_cards_schema",
    "format_canonical",
    "format_value",
    "load_cards",
    "store_cards",
    "template_narrative",
    "write_narratives",
]
