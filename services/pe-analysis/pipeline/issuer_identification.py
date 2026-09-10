"""Attribute each document to the institution whose view it expresses.

Consensus and divergence are computed per institution, so every claim needs an
owner. Institutions are discovered, not enumerated: the model reads the name
printed on the cover, header or disclaimer, and the project's ``issuers``
registry maps spellings of the same house (华泰研究 / HTSC / 华泰证券) to one
key. A seed alias table covers the brokers whose spellings are known; anything
else is registered under a hash of its normalized name the first time it is
seen. Nothing is dropped for being unknown.

Documents written by the company itself (annual reports, announcements,
earnings calls) are attributed to the company under the fixed key ``company``
so management guidance and sell-side forecasts can be compared, or kept apart,
by the aggregation layer.

Dates are handled with the same care as attribution. ``published_date`` is what
the document says about itself, read from a labeled date line, the cover as the
model saw it, or a full date in the filename. ``as_of_date`` is the date the
view is treated as current: the published date when known, otherwise the ingest
date, with the source recorded so nobody mistakes one for the other.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from .schema import execute_schema

ISSUER_DETECTOR_VERSION = "pe_issuer_registry_v2"

KIND_SELL_SIDE = "sell_side"
KIND_BUY_SIDE = "buy_side"
KIND_COMPANY = "company"
KIND_THIRD_PARTY = "third_party"
KIND_UNKNOWN = "unknown"
VALID_KINDS = frozenset({KIND_SELL_SIDE, KIND_BUY_SIDE, KIND_COMPANY, KIND_THIRD_PARTY, KIND_UNKNOWN})

COMPANY_ISSUER_KEY = "company"

STATUS_RESOLVED = "resolved"
STATUS_NEEDS_REVIEW = "needs_review"

METHOD_RULES = "rules"
METHOD_LLM = "llm"
METHOD_MANUAL = "manual"
METHOD_DOC_TYPE = "doc_type"
METHOD_NOT_DETECTED = "not_detected"

RULES_ACCEPT_CONFIDENCE = 0.92
RULES_LEAD_MARGIN = 0.12
MODEL_ACCEPT_CONFIDENCE = 0.75
HEADER_CHARS = 1_800
MAX_PREVIEW_CHARS = 12_000

DATE_SOURCE_LABELED = "labeled_text"
DATE_SOURCE_INGEST_METADATA = "ingest_metadata"
DATE_SOURCE_MODEL = "model_cover"
DATE_SOURCE_FILENAME = "filename"
DATE_SOURCE_NONE = ""

AS_OF_PUBLISHED = "published"
AS_OF_INGESTED = "ingested"

# Optional issuer subtype hints whose author is the company.
COMPANY_SUBTYPES = frozenset(
    {
        "annual_report",
        "interim_report",
        "quarterly_report",
        "preliminary_results",
        "results_announcement",
        "earnings_call",
        "roadshow",
        "investor_day",
        "results_presentation",
        "exchange_announcement",
        "corporate_action",
        "risk_disclosure",
        "company_profile",
        "product_material",
        "strategy_material",
    }
)
SELL_SIDE_SUBTYPES = frozenset({"broker_company_report", "broker_industry_report"})
BUY_SIDE_SUBTYPES = frozenset({"internal_research_report", "internal_meeting"})
THIRD_PARTY_SUBTYPES = frozenset({"expert_interview", "research_meeting"})


def kind_from_subtype(doc_subtype: str) -> str:
    if doc_subtype in COMPANY_SUBTYPES:
        return KIND_COMPANY
    if doc_subtype in SELL_SIDE_SUBTYPES:
        return KIND_SELL_SIDE
    if doc_subtype in BUY_SIDE_SUBTYPES:
        return KIND_BUY_SIDE
    if doc_subtype in THIRD_PARTY_SUBTYPES:
        return KIND_THIRD_PARTY
    return KIND_UNKNOWN


# (key, canonical name, aliases). Keys are stable machine identifiers; renaming a
# broker changes the display name, never the key, so historical claims stay
# joinable. The list only needs the houses whose spellings vary; a broker not
# listed here is registered on first sight.
SEED_ISSUERS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("cicc", "中金公司", ("中金公司", "中国国际金融", "CICC")),
    ("citic_sec", "中信证券", ("中信证券", "CITIC Securities")),
    ("csc", "中信建投", ("中信建投", "China Securities")),
    ("htsc", "华泰证券", ("华泰证券", "华泰研究", "HTSC", "Huatai")),
    ("gtja", "国泰海通", ("国泰海通", "国泰君安", "Guotai Junan", "Guotai Haitong")),
    ("haitong", "海通证券", ("海通证券", "Haitong")),
    ("cmschina", "招商证券", ("招商证券", "China Merchants Securities", "CMS")),
    ("gf", "广发证券", ("广发证券", "GF Securities")),
    ("swhy", "申万宏源", ("申万宏源", "Shenwan Hongyuan", "SWS")),
    ("xyzq", "兴业证券", ("兴业证券", "兴证", "Industrial Securities")),
    ("orient", "东方证券", ("东方证券", "东方研究", "Orient Securities")),
    ("ebscn", "光大证券", ("光大证券", "Everbright Securities")),
    ("minsheng", "民生证券", ("民生证券",)),
    ("glms", "国联民生", ("国联民生", "国联证券")),
    ("tfzq", "天风证券", ("天风证券", "TF Securities")),
    ("cjsc", "长江证券", ("长江证券", "Changjiang Securities")),
    ("guosen", "国信证券", ("国信证券", "Guosen")),
    ("stocke", "浙商证券", ("浙商证券",)),
    ("dwzq", "东吴证券", ("东吴证券", "Soochow Securities")),
    ("hcyjs", "华创证券", ("华创证券",)),
    ("western", "西部证券", ("西部证券",)),
    ("pingan", "平安证券", ("平安证券", "Ping An Securities")),
    ("chinastock", "中国银河", ("中国银河", "银河证券", "China Galaxy")),
    ("founder", "方正证券", ("方正证券",)),
    ("sinolink", "国金证券", ("国金证券", "Sinolink")),
    ("essence", "国投证券", ("国投证券", "安信证券", "Essence Securities")),
    ("ctsec", "财通证券", ("财通证券",)),
    ("kysec", "开源证券", ("开源证券",)),
    ("tebon", "德邦证券", ("德邦证券", "Tebon")),
    ("zts", "中泰证券", ("中泰证券", "Zhongtai Securities")),
    ("nesc", "东北证券", ("东北证券", "Northeast Securities")),
    ("hxzq", "华西证券", ("华西证券",)),
    ("ghzq", "国海证券", ("国海证券", "Sealand Securities")),
    ("cgs", "长城证券", ("长城证券", "Great Wall Securities")),
    ("cindasc", "信达证券", ("信达证券", "Cinda Securities")),
    ("bocsec", "中银证券", ("中银证券", "中银国际证券", "BOC International")),
    ("hazq", "华安证券", ("华安证券",)),
    ("tpyzq", "太平洋证券", ("太平洋证券",)),
    ("sxzq", "山西证券", ("山西证券",)),
    ("dxzq", "东兴证券", ("东兴证券",)),
    ("huaxin", "华鑫证券", ("华鑫证券",)),
    ("sczq", "首创证券", ("首创证券",)),
    ("zyzq", "中原证券", ("中原证券",)),
    ("gyzq", "国元证券", ("国元证券",)),
    ("hfzq", "华福证券", ("华福证券",)),
    ("dhzq", "东海证券", ("东海证券",)),
    ("avicsec", "中航证券", ("中航证券",)),
    ("cmbi", "招银国际", ("招银国际", "CMB International", "CMBI")),
    ("ccbi", "建银国际", ("建银国际", "CCB International", "CCBI")),
    ("bocomi", "交银国际", ("交银国际", "BOCOM International")),
    ("spdbi", "浦银国际", ("浦银国际", "SPDB International")),
    ("gs", "高盛", ("高盛", "Goldman Sachs", "Goldman")),
    ("ms", "摩根士丹利", ("摩根士丹利", "大摩", "Morgan Stanley")),
    ("jpm", "摩根大通", ("摩根大通", "小摩", "J.P. Morgan", "JPMorgan")),
    ("ubs", "瑞银", ("瑞银", "UBS")),
    ("citi", "花旗", ("花旗", "Citigroup", "Citi Research", "Citi")),
    ("bofa", "美银证券", ("美银证券", "美银美林", "BofA", "Bank of America", "Merrill Lynch")),
    ("hsbc", "汇丰", ("汇丰", "HSBC")),
    ("nomura", "野村", ("野村", "Nomura")),
    ("daiwa", "大和证券", ("大和证券", "Daiwa")),
    ("clsa", "中信里昂", ("中信里昂", "里昂证券", "CLSA")),
    ("macquarie", "麦格理", ("麦格理", "Macquarie")),
    ("jefferies", "杰富瑞", ("杰富瑞", "Jefferies")),
    ("bernstein", "伯恩斯坦", ("伯恩斯坦", "Bernstein")),
    ("barclays", "巴克莱", ("巴克莱", "Barclays")),
    ("db", "德意志银行", ("德意志银行", "Deutsche Bank")),
    ("mizuho", "瑞穗", ("瑞穗", "Mizuho")),
    ("bnpp", "法国巴黎银行", ("法国巴黎银行", "BNP Paribas")),
)

# "证券" is part of the house's name (华泰证券, 中泰证券) and is kept; only the
# organizational unit and corporate-form suffixes are stripped.
_SUFFIXES = (
    "股份有限公司",
    "有限责任公司",
    "有限公司",
    "研究所",
    "研究部",
    "研究中心",
    "研究院",
    "研究",
    "co.,ltd.",
    "co.,ltd",
    "co.ltd",
    "limited",
    "ltd.",
    "ltd",
    "inc.",
    "inc",
    "research",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).lower()


def normalize_issuer_name(value: str) -> str:
    """Reduce a printed institution name to a comparable core.

    ``华泰证券股份有限公司研究所`` and ``华泰证券`` must match; ``华泰证券`` and
    ``华泰研究`` are matched through the seed aliases instead. Punctuation and
    whitespace are removed, corporate suffixes stripped once from the end.
    """

    text = _normalize(value)
    text = re.sub(r"[\s　·•\-–—_,，。.．()（）\[\]【】/|]+", "", text)
    changed = True
    while changed and text:
        changed = False
        for suffix in _SUFFIXES:
            if text.endswith(suffix) and len(text) > len(suffix):
                text = text[: -len(suffix)]
                changed = True
    return text


_SEED_BY_ALIAS: dict[str, tuple[str, str]] = {}
for _key, _name, _aliases in SEED_ISSUERS:
    for _alias in (_name, *_aliases):
        _SEED_BY_ALIAS.setdefault(normalize_issuer_name(_alias), (_key, _name))
_SEED_BY_KEY: dict[str, tuple[str, tuple[str, ...]]] = {
    key: (name, aliases) for key, name, aliases in SEED_ISSUERS
}


@dataclass
class IssuerIdentification:
    issuer_key: str = ""
    issuer_name: str = ""
    issuer_kind: str = KIND_UNKNOWN
    confidence: float = 0.0
    method: str = METHOD_NOT_DETECTED
    status: str = STATUS_NEEDS_REVIEW
    candidates: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    llm_error: str = ""


# ---------------------------------------------------------------- registry


def ensure_issuer_schema(conn: sqlite3.Connection) -> None:
    execute_schema(conn,
        """
        CREATE TABLE IF NOT EXISTS issuers (
            issuer_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            issuer_key TEXT NOT NULL,
            issuer_name TEXT NOT NULL,
            issuer_kind TEXT NOT NULL DEFAULT 'unknown',
            aliases_json TEXT,
            origin TEXT NOT NULL DEFAULT 'discovered',
            doc_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_issuers_dataset_key
            ON issuers(dataset_id, issuer_key);

        CREATE TABLE IF NOT EXISTS document_issuers (
            doc_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            issuer_key TEXT,
            issuer_name TEXT,
            issuer_kind TEXT NOT NULL DEFAULT 'unknown',
            confidence REAL NOT NULL DEFAULT 0,
            method TEXT NOT NULL DEFAULT 'not_detected',
            status TEXT NOT NULL DEFAULT 'needs_review',
            candidates_json TEXT,
            evidence_json TEXT,
            published_date TEXT,
            published_date_source TEXT,
            as_of_date TEXT,
            as_of_source TEXT,
            detector_version TEXT NOT NULL,
            llm_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_document_issuers_dataset
            ON document_issuers(dataset_id, status, issuer_key);
        """
    )


def _issuer_id(dataset_id: str, issuer_key: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}\0{issuer_key}".encode("utf-8")).hexdigest()
    return f"iss_{digest[:32]}"


def resolve_issuer(
    conn: sqlite3.Connection,
    dataset_id: str,
    name: str,
    *,
    kind: str = KIND_UNKNOWN,
) -> tuple[str, str]:
    """Return ``(issuer_key, canonical_name)`` for a printed name, registering it if new.

    Resolution order: the project's registry (which includes every name seen so
    far and any alias a reviewer added), then the seed alias table, then a new
    registry row keyed by a hash of the normalized name.
    """

    ensure_issuer_schema(conn)
    core = normalize_issuer_name(name)
    if not core:
        return "", ""

    for row in conn.execute(
        "SELECT issuer_key, issuer_name, aliases_json FROM issuers WHERE dataset_id = ?",
        (dataset_id,),
    ):
        try:
            aliases = json.loads(row["aliases_json"] or "[]")
        except json.JSONDecodeError:
            aliases = []
        known = {normalize_issuer_name(row["issuer_name"]), *(normalize_issuer_name(a) for a in aliases)}
        if core in known:
            return str(row["issuer_key"]), str(row["issuer_name"])

    seed = _SEED_BY_ALIAS.get(core)
    if seed is None:
        # A seed alias inside a longer printed name ("华泰证券研究所（深圳）") still
        # identifies the house; require the alias to be the head of the name so
        # "中金黄金" never resolves to 中金公司.
        for alias_core, candidate in _SEED_BY_ALIAS.items():
            if len(alias_core) >= 2 and core.startswith(alias_core) and len(core) - len(alias_core) <= 6:
                seed = candidate
                break

    if seed is not None:
        issuer_key, canonical = seed
        aliases = list(_SEED_BY_KEY[issuer_key][1])
        resolved_kind = KIND_SELL_SIDE if kind == KIND_UNKNOWN else kind
        origin = "seed"
    else:
        issuer_key = f"iss_{hashlib.sha256(core.encode('utf-8')).hexdigest()[:10]}"
        canonical = _display_name(name)
        aliases = []
        resolved_kind = kind
        origin = "discovered"

    timestamp = now_iso()
    conn.execute(
        """
        INSERT OR IGNORE INTO issuers (
            issuer_id, dataset_id, issuer_key, issuer_name, issuer_kind,
            aliases_json, origin, doc_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            _issuer_id(dataset_id, issuer_key),
            dataset_id,
            issuer_key,
            canonical,
            resolved_kind,
            json.dumps(aliases, ensure_ascii=False),
            origin,
            timestamp,
            timestamp,
        ),
    )
    return issuer_key, canonical


def _display_name(name: str) -> str:
    text = unicodedata.normalize("NFKC", str(name or "")).strip()
    text = re.sub(r"\s+", " ", text)
    for suffix in ("股份有限公司", "有限责任公司", "有限公司"):
        if text.endswith(suffix) and len(text) > len(suffix):
            text = text[: -len(suffix)]
    return text[:80]


def ensure_company_issuer(conn: sqlite3.Connection, dataset_id: str, company_name: str) -> str:
    ensure_issuer_schema(conn)
    timestamp = now_iso()
    conn.execute(
        """
        INSERT OR IGNORE INTO issuers (
            issuer_id, dataset_id, issuer_key, issuer_name, issuer_kind,
            aliases_json, origin, doc_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '[]', 'preset', 0, ?, ?)
        """,
        (
            _issuer_id(dataset_id, COMPANY_ISSUER_KEY),
            dataset_id,
            COMPANY_ISSUER_KEY,
            company_name or "标的公司",
            KIND_COMPANY,
            timestamp,
            timestamp,
        ),
    )
    return COMPANY_ISSUER_KEY


def refresh_issuer_doc_counts(conn: sqlite3.Connection, dataset_id: str) -> None:
    conn.execute(
        """
        UPDATE issuers
        SET doc_count = (
            SELECT COUNT(*) FROM document_issuers d
            WHERE d.dataset_id = issuers.dataset_id AND d.issuer_key = issuers.issuer_key
        ),
        updated_at = ?
        WHERE dataset_id = ?
        """,
        (now_iso(), dataset_id),
    )


# ---------------------------------------------------------------- rules


def rule_candidates(text: str, filename: str) -> list[dict[str, Any]]:
    """Rank seed issuers by where their aliases appear.

    A report published by 华泰 that discusses 高盛's forecast mentions both, but
    only 华泰 appears in the filename, the running header and the disclaimer.
    Used as a hint for the model and as the only signal when no model is set.
    """

    body = _normalize(text)[:MAX_PREVIEW_CHARS]
    header = body[:HEADER_CHARS]
    tail = body[-HEADER_CHARS:] if len(body) > HEADER_CHARS else ""
    name = _normalize(filename)

    scores: dict[str, dict[str, Any]] = {}
    for key, canonical, aliases in SEED_ISSUERS:
        for alias in (canonical, *aliases):
            needle = _normalize(alias)
            if len(needle) < 2:
                continue
            in_filename = needle in name
            header_hits = header.count(needle)
            tail_hits = tail.count(needle)
            body_hits = body.count(needle)
            if not (in_filename or body_hits):
                continue
            score = 0.0
            reasons: list[str] = []
            if in_filename:
                score += 0.60
                reasons.append(f"文件名包含「{alias}」")
            if header_hits:
                score += min(0.34, 0.17 * header_hits)
                reasons.append(f"文首出现「{alias}」{header_hits} 次")
            if tail_hits:
                score += min(0.34, 0.17 * tail_hits)
                reasons.append(f"文末出现「{alias}」{tail_hits} 次")
            if body_hits:
                score += min(0.10, 0.02 * body_hits)
            entry = scores.setdefault(
                key, {"issuer_key": key, "issuer_name": canonical, "score": 0.0, "evidence": []}
            )
            if score > entry["score"]:
                entry["score"] = score
                entry["evidence"] = reasons

    ranked = sorted(scores.values(), key=lambda item: item["score"], reverse=True)
    for entry in ranked:
        entry["score"] = round(min(1.0, entry["score"]), 4)
    return ranked[:5]


# ---------------------------------------------------------------- decision


def identify_issuer(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    text: str,
    filename: str,
    doc_subtype: str = "",
    company_name: str = "",
    model_document: dict[str, Any] | None = None,
    llm_error: str = "",
) -> IssuerIdentification:
    """Combine document type, rules and what the model read into one attribution.

    ``model_document`` is the ``document`` block the scan returned for the first
    window: ``issuer_name`` as printed, ``issuer_kind``, ``confidence``. When it
    is absent (no model, or the model failed) the rules decide alone and only a
    filename plus a repeated header clears the bar.
    """

    candidates = rule_candidates(text, filename)
    result = IssuerIdentification(candidates=candidates, llm_error=llm_error)
    subtype_kind = kind_from_subtype(doc_subtype)

    model_name = ""
    model_kind = KIND_UNKNOWN
    model_confidence = 0.0
    model_evidence: list[str] = []
    if isinstance(model_document, dict):
        model_name = str(model_document.get("issuer_name") or "").strip()
        model_kind = str(model_document.get("issuer_kind") or "").strip().lower()
        if model_kind not in VALID_KINDS:
            model_kind = KIND_UNKNOWN
        model_confidence = _clamp(model_document.get("issuer_confidence"), 0.0)
        raw_evidence = model_document.get("issuer_evidence")
        if isinstance(raw_evidence, list):
            model_evidence = [str(item)[:200] for item in raw_evidence[:4] if str(item).strip()]

    # 1. The company's own material: attribution comes from the document type
    #    or from the model saying so, never from a broker name in the body.
    company_by_model = model_kind == KIND_COMPANY
    if subtype_kind == KIND_COMPANY or company_by_model:
        result.issuer_key = ensure_company_issuer(conn, dataset_id, company_name)
        result.issuer_name = company_name or model_name or "标的公司"
        result.issuer_kind = KIND_COMPANY
        result.confidence = max(model_confidence, 0.9 if subtype_kind == KIND_COMPANY else 0.0)
        result.method = METHOD_LLM if company_by_model else METHOD_DOC_TYPE
        result.status = STATUS_RESOLVED
        result.evidence = model_evidence or [f"文档类型 {doc_subtype} 由公司发布"]
        return result

    # 2. The model read a name off the cover. Register it whatever it is.
    if model_name:
        kind = model_kind if model_kind != KIND_UNKNOWN else subtype_kind
        issuer_key, canonical = resolve_issuer(conn, dataset_id, model_name, kind=kind)
        if issuer_key:
            result.issuer_key = issuer_key
            result.issuer_name = canonical
            result.issuer_kind = kind if kind != KIND_UNKNOWN else KIND_SELL_SIDE
            result.confidence = model_confidence
            result.method = METHOD_LLM
            result.evidence = model_evidence
            rules_agree = bool(candidates) and candidates[0]["issuer_key"] == issuer_key
            result.status = (
                STATUS_RESOLVED
                if model_confidence >= MODEL_ACCEPT_CONFIDENCE or rules_agree
                else STATUS_NEEDS_REVIEW
            )
            return result

    # 3. Rules only.
    if candidates:
        top = candidates[0]
        runner_up = candidates[1]["score"] if len(candidates) > 1 else 0.0
        issuer_key, canonical = resolve_issuer(conn, dataset_id, top["issuer_name"], kind=KIND_SELL_SIDE)
        result.issuer_key = issuer_key
        result.issuer_name = canonical
        result.issuer_kind = KIND_SELL_SIDE
        result.confidence = float(top["score"])
        result.evidence = list(top["evidence"])
        result.method = METHOD_RULES
        strong = result.confidence >= RULES_ACCEPT_CONFIDENCE and (result.confidence - runner_up) >= RULES_LEAD_MARGIN
        result.status = STATUS_RESOLVED if strong else STATUS_NEEDS_REVIEW
        return result

    result.issuer_kind = subtype_kind
    return result


def _clamp(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(1.0, number))


# ---------------------------------------------------------------- dates

_DATE_LABEL = r"(?:报告日期|发布日期|发布时间|报告时间|日期|first\s*published|published|publication\s*date|completion\s*date|report\s*date|date)"
_LABELED_DATE = re.compile(
    _DATE_LABEL + r"\s*[:：]?\s*(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})",
    re.IGNORECASE,
)
_MONTHS = {
    name: index
    for index, names in enumerate(
        (
            ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",),
            ("jun", "june"), ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"),
            ("oct", "october"), ("nov", "november"), ("dec", "december"),
        ),
        start=1,
    )
    for name in names
}
_MONTH_NAMES = "|".join(sorted(_MONTHS, key=len, reverse=True))
# "First Published: 27 May 2026" and "Published May 27, 2026".
_LABELED_DATE_EN = re.compile(
    _DATE_LABEL + r"\s*[:：]?\s*(?:(\d{1,2})\s+(" + _MONTH_NAMES + r")\.?,?\s+(20\d{2})"
    r"|(" + _MONTH_NAMES + r")\.?\s+(\d{1,2}),?\s+(20\d{2}))",
    re.IGNORECASE,
)
_FULL_DATE = re.compile(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})")
_COMPACT_DATE = re.compile(r"(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)")
_ISO_DATE = re.compile(r"^(20\d{2})-(\d{2})-(\d{2})$")


def _valid_date(year: int, month: int, day: int, *, latest: date) -> str:
    try:
        value = date(year, month, day)
    except ValueError:
        return ""
    if value < date(2000, 1, 1) or value > latest:
        return ""
    return value.isoformat()


def published_date_from(
    text: str,
    filename: str,
    *,
    metadata_date: str = "",
    model_date: str = "",
    ingested_at: str = "",
) -> tuple[str, str]:
    """Return ``(published_date, source)``.

    Preference order: a labeled date line in the opening of the document (报告
    日期 2026-08-14), deterministic ingestion metadata, the cover date the
    model read, then a full date in the filename. Bare dates in the header are deliberately not used: the first
    date on a cover is as likely to be the fiscal period (2025年12月31日) as
    the publication date.
    """

    latest = _latest_allowed(ingested_at)
    opening = unicodedata.normalize("NFKC", str(text or ""))[:4_000]
    match = _LABELED_DATE.search(opening)
    if match:
        value = _valid_date(*(int(part) for part in match.groups()), latest=latest)
        if value:
            return value, DATE_SOURCE_LABELED
    match = _LABELED_DATE_EN.search(opening)
    if match:
        day, month_a, year, month_b, day_b, year_b = match.groups()
        month = _MONTHS[(month_a or month_b).lower()]
        value = _valid_date(int(year or year_b), month, int(day or day_b), latest=latest)
        if value:
            return value, DATE_SOURCE_LABELED

    iso = _ISO_DATE.match(str(metadata_date or "").strip())
    if iso:
        value = _valid_date(*(int(part) for part in iso.groups()), latest=latest)
        if value:
            return value, DATE_SOURCE_INGEST_METADATA

    iso = _ISO_DATE.match(str(model_date or "").strip())
    if iso:
        value = _valid_date(*(int(part) for part in iso.groups()), latest=latest)
        if value:
            return value, DATE_SOURCE_MODEL

    name = unicodedata.normalize("NFKC", str(filename or ""))
    for pattern in (_FULL_DATE, _COMPACT_DATE):
        match = pattern.search(name)
        if match:
            value = _valid_date(*(int(part) for part in match.groups()), latest=latest)
            if value:
                return value, DATE_SOURCE_FILENAME
    return "", DATE_SOURCE_NONE


def _latest_allowed(ingested_at: str) -> date:
    try:
        base = datetime.fromisoformat(ingested_at).date() if ingested_at else datetime.now(timezone.utc).date()
    except ValueError:
        base = datetime.now(timezone.utc).date()
    return base + timedelta(days=1)


def as_of_from(published_date: str, ingested_at: str) -> tuple[str, str]:
    """The date a document's views count from, and where that date came from."""

    if published_date:
        return published_date, AS_OF_PUBLISHED
    try:
        ingest_day = datetime.fromisoformat(ingested_at).date().isoformat()
    except ValueError:
        ingest_day = datetime.now(timezone.utc).date().isoformat()
    return ingest_day, AS_OF_INGESTED


# ---------------------------------------------------------------- persistence


def store_issuer(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    doc_id: str,
    identification: IssuerIdentification,
    published_date: str = "",
    published_date_source: str = "",
    as_of_date: str = "",
    as_of_source: str = "",
) -> bool:
    """Persist an attribution. A manual attribution is never overwritten.

    Returns False when the row was left alone because a reviewer set it.
    """

    ensure_issuer_schema(conn)
    existing = conn.execute(
        "SELECT method FROM document_issuers WHERE doc_id = ?", (doc_id,)
    ).fetchone()
    if existing is not None and existing["method"] == METHOD_MANUAL:
        return False

    conn.execute(
        """
        INSERT INTO document_issuers (
            doc_id, dataset_id, issuer_key, issuer_name, issuer_kind, confidence,
            method, status, candidates_json, evidence_json, published_date,
            published_date_source, as_of_date, as_of_source, detector_version,
            llm_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            issuer_key = excluded.issuer_key,
            issuer_name = excluded.issuer_name,
            issuer_kind = excluded.issuer_kind,
            confidence = excluded.confidence,
            method = excluded.method,
            status = excluded.status,
            candidates_json = excluded.candidates_json,
            evidence_json = excluded.evidence_json,
            published_date = excluded.published_date,
            published_date_source = excluded.published_date_source,
            as_of_date = excluded.as_of_date,
            as_of_source = excluded.as_of_source,
            detector_version = excluded.detector_version,
            llm_error = excluded.llm_error,
            updated_at = excluded.updated_at
        """,
        (
            doc_id,
            dataset_id,
            identification.issuer_key or None,
            identification.issuer_name or None,
            identification.issuer_kind,
            identification.confidence,
            identification.method,
            identification.status,
            json.dumps(identification.candidates, ensure_ascii=False),
            json.dumps(identification.evidence, ensure_ascii=False),
            published_date or None,
            published_date_source or None,
            as_of_date or None,
            as_of_source or None,
            ISSUER_DETECTOR_VERSION,
            identification.llm_error or None,
            now_iso(),
        ),
    )
    return True


def set_issuer_manually(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    doc_id: str,
    issuer_name: str,
    issuer_kind: str = KIND_SELL_SIDE,
) -> str:
    """Reviewer override: attribute a document and re-own its claims.

    Returns the resolved issuer key. The claims table carries a copy of the key
    for cheap grouping, so it is updated here rather than left to drift.
    """

    if issuer_kind == KIND_COMPANY:
        issuer_key = ensure_company_issuer(conn, dataset_id, issuer_name)
        canonical = issuer_name
    else:
        issuer_key, canonical = resolve_issuer(conn, dataset_id, issuer_name, kind=issuer_kind)
    if not issuer_key:
        raise ValueError("issuer name is empty")
    timestamp = now_iso()
    conn.execute(
        """
        INSERT INTO document_issuers (
            doc_id, dataset_id, issuer_key, issuer_name, issuer_kind, confidence,
            method, status, candidates_json, evidence_json, detector_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, '[]', '[]', ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            issuer_key = excluded.issuer_key,
            issuer_name = excluded.issuer_name,
            issuer_kind = excluded.issuer_kind,
            confidence = 1.0,
            method = excluded.method,
            status = excluded.status,
            updated_at = excluded.updated_at
        """,
        (
            doc_id,
            dataset_id,
            issuer_key,
            canonical,
            issuer_kind if issuer_kind in VALID_KINDS else KIND_SELL_SIDE,
            METHOD_MANUAL,
            STATUS_RESOLVED,
            ISSUER_DETECTOR_VERSION,
            timestamp,
        ),
    )
    conn.execute(
        "UPDATE atomic_claims SET issuer_key = ? WHERE doc_id = ?", (issuer_key, doc_id)
    )
    refresh_issuer_doc_counts(conn, dataset_id)
    conn.commit()
    return issuer_key


def issuer_for_document(conn: sqlite3.Connection, doc_id: str) -> sqlite3.Row | None:
    ensure_issuer_schema(conn)
    return conn.execute(
        "SELECT * FROM document_issuers WHERE doc_id = ?", (doc_id,)
    ).fetchone()


__all__ = [
    "AS_OF_INGESTED",
    "AS_OF_PUBLISHED",
    "COMPANY_ISSUER_KEY",
    "DATE_SOURCE_FILENAME",
    "DATE_SOURCE_INGEST_METADATA",
    "DATE_SOURCE_LABELED",
    "DATE_SOURCE_MODEL",
    "ISSUER_DETECTOR_VERSION",
    "IssuerIdentification",
    "KIND_BUY_SIDE",
    "KIND_COMPANY",
    "KIND_SELL_SIDE",
    "KIND_THIRD_PARTY",
    "KIND_UNKNOWN",
    "METHOD_DOC_TYPE",
    "METHOD_LLM",
    "METHOD_MANUAL",
    "METHOD_NOT_DETECTED",
    "METHOD_RULES",
    "SEED_ISSUERS",
    "STATUS_NEEDS_REVIEW",
    "STATUS_RESOLVED",
    "as_of_from",
    "ensure_company_issuer",
    "ensure_issuer_schema",
    "identify_issuer",
    "issuer_for_document",
    "kind_from_subtype",
    "normalize_issuer_name",
    "published_date_from",
    "refresh_issuer_doc_counts",
    "resolve_issuer",
    "rule_candidates",
    "set_issuer_manually",
    "store_issuer",
]
