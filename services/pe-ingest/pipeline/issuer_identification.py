"""Identify which institution issued a research document.

Consensus and divergence are computed per institution, so an unattributed
document cannot participate in aggregation. The thresholds mirror the company
router in ``document_classifier``: accept automatically only when the leading
candidate is confident and clearly ahead of the runner-up, otherwise leave the
document in ``needs_review`` for the user to resolve.

A research report names many institutions. The issuer is the one printed in the
header, footer and disclaimer, so matches are weighted by where they appear
rather than by raw frequency.
"""

from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

ISSUER_DETECTOR_VERSION = "pe_issuer_rules_llm_v1"

ACCEPT_CONFIDENCE = 0.92
LEAD_MARGIN = 0.12
HEADER_CHARS = 1_800
MAX_PREVIEW_CHARS = 12_000

STATUS_RESOLVED = "resolved"
STATUS_NEEDS_REVIEW = "needs_review"

METHOD_RULES = "rules"
METHOD_LLM = "llm"
METHOD_NOT_DETECTED = "not_detected"
METHOD_AMBIGUOUS = "ambiguous"


class IssuerChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


# (key, canonical name, aliases). Keys are stable machine identifiers; renaming a
# broker changes the display name, never the key, so historical claims stay joinable.
KNOWN_ISSUERS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("cicc", "中金公司", ("中金公司", "中国国际金融", "中金", "CICC")),
    ("citic_sec", "中信证券", ("中信证券", "CITIC Securities")),
    ("csc", "中信建投", ("中信建投", "China Securities")),
    ("htsc", "华泰证券", ("华泰证券", "华泰研究", "HTSC", "Huatai")),
    ("gtja", "国泰海通", ("国泰海通", "国泰君安", "Guotai Junan")),
    ("haitong", "海通证券", ("海通证券", "Haitong")),
    ("cmschina", "招商证券", ("招商证券", "China Merchants Securities")),
    ("gf", "广发证券", ("广发证券", "GF Securities")),
    ("swhy", "申万宏源", ("申万宏源", "申万", "Shenwan Hongyuan")),
    ("xyzq", "兴业证券", ("兴业证券", "兴证", "Industrial Securities")),
    ("orient", "东方证券", ("东方证券", "东方研究", "Orient Securities")),
    ("ebscn", "光大证券", ("光大证券", "Everbright Securities")),
    ("minsheng", "民生证券", ("民生证券",)),
    ("tfzq", "天风证券", ("天风证券", "TF Securities")),
    ("cjsc", "长江证券", ("长江证券", "Changjiang Securities")),
    ("guosen", "国信证券", ("国信证券", "Guosen")),
    ("stocke", "浙商证券", ("浙商证券",)),
    ("dwzq", "东吴证券", ("东吴证券", "Soochow Securities")),
    ("hcyjs", "华创证券", ("华创证券", "华创",)),
    ("western", "西部证券", ("西部证券",)),
    ("pingan", "平安证券", ("平安证券", "Ping An Securities")),
    ("chinastock", "中国银河", ("中国银河", "银河证券", "China Galaxy")),
    ("founder", "方正证券", ("方正证券",)),
    ("sinolink", "国金证券", ("国金证券", "Sinolink")),
    ("essence", "国投证券", ("国投证券", "安信证券", "Essence Securities")),
    ("ctsec", "财通证券", ("财通证券",)),
    ("kysec", "开源证券", ("开源证券",)),
    ("tebon", "德邦证券", ("德邦证券", "Tebon")),
    ("zheshang", "浙商国际", ("浙商国际",)),
    ("gs", "高盛", ("高盛", "Goldman Sachs", "Goldman")),
    ("ms", "摩根士丹利", ("摩根士丹利", "大摩", "Morgan Stanley")),
    ("jpm", "摩根大通", ("摩根大通", "小摩", "J.P. Morgan", "JPMorgan")),
    ("ubs", "瑞银", ("瑞银", "UBS")),
    ("citi", "花旗", ("花旗", "Citigroup", "Citi Research")),
    ("bofa", "美银美林", ("美银美林", "美国银行", "BofA", "Merrill Lynch")),
    ("hsbc", "汇丰", ("汇丰", "HSBC")),
    ("nomura", "野村", ("野村", "Nomura")),
    ("daiwa", "大和", ("大和证券", "Daiwa")),
    ("clsa", "里昂证券", ("里昂证券", "CLSA")),
    ("macquarie", "麦格理", ("麦格理", "Macquarie")),
    ("jefferies", "杰富瑞", ("杰富瑞", "Jefferies")),
    ("bernstein", "伯恩斯坦", ("伯恩斯坦", "Bernstein")),
    ("barclays", "巴克莱", ("巴克莱", "Barclays")),
    ("db", "德意志银行", ("德意志银行", "Deutsche Bank")),
)

_ALIAS_INDEX: tuple[tuple[str, str, str], ...] = tuple(
    (key, name, alias)
    for key, name, aliases in KNOWN_ISSUERS
    for alias in aliases
)


@dataclass
class IssuerIdentification:
    issuer_key: str = ""
    issuer_name: str = ""
    confidence: float = 0.0
    method: str = METHOD_NOT_DETECTED
    status: str = STATUS_NEEDS_REVIEW
    candidates: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    llm_error: str = ""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).lower()


def _score_candidates(text: str, filename: str) -> list[dict[str, Any]]:
    """Weight header and filename hits above body mentions.

    A report published by 华泰 that discusses 高盛's forecast mentions both, but
    only 华泰 appears in the filename, the running header and the disclaimer.
    """

    body = _normalize(text)[:MAX_PREVIEW_CHARS]
    header = body[:HEADER_CHARS]
    tail = body[-HEADER_CHARS:] if len(body) > HEADER_CHARS else ""
    name = _normalize(filename)

    scores: dict[str, dict[str, Any]] = {}
    for key, canonical, alias in _ALIAS_INDEX:
        needle = _normalize(alias)
        if not needle:
            continue
        in_filename = needle in name
        header_hits = header.count(needle)
        tail_hits = tail.count(needle)
        body_hits = body.count(needle)
        if not (in_filename or body_hits):
            continue

        # A broker names its own report; a broker it merely quotes appears in
        # the body only. Filename plus a repeated header must be able to clear
        # ACCEPT_CONFIDENCE on its own, or the common case would always fall
        # through to the model.
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
    return ranked


_JSON_ISSUER_KEYS = {key for key, _name, _aliases in KNOWN_ISSUERS}


def _llm_messages(text: str, filename: str, candidates: list[dict[str, Any]]) -> list[dict[str, str]]:
    catalog = "\n".join(f"- {key}: {name}" for key, name, _aliases in KNOWN_ISSUERS)
    shortlist = ", ".join(f"{item['issuer_name']}({item['score']})" for item in candidates[:5]) or "无"
    excerpt = text[:6000]
    return [
        {
            "role": "system",
            "content": (
                "你判断一份金融研究文档的发布机构。发布机构是撰写并署名这份文档的券商或投行，"
                "不是文档中被讨论、被引用或被比较的其他机构，也不是研究标的公司。"
                "只输出一个 JSON 对象，不要输出其他文字。"
                "字段：issuer_key（下列目录中的键，无法确定时为空字符串）、"
                "issuer_name、confidence（0 到 1）、requires_review（布尔）、evidence（字符串数组，最多 4 条）。"
                "文档由标的公司自己发布（如年报、公告、业绩说明）时，issuer_key 返回空字符串并将 requires_review 设为 true。"
                "证据不足时返回空 issuer_key，不要猜测。"
            ),
        },
        {
            "role": "user",
            "content": (
                f"机构目录：\n{catalog}\n\n"
                f"文件名：{filename}\n"
                f"规则候选：{shortlist}\n\n"
                f"文档节选：\n{excerpt}"
            ),
        },
    ]


def identify_issuer(
    *,
    text: str,
    filename: str,
    llm_client: IssuerChatClient | None = None,
) -> IssuerIdentification:
    candidates = _score_candidates(text, filename)
    result = IssuerIdentification(candidates=candidates[:5])

    if candidates:
        top = candidates[0]
        runner_up = candidates[1]["score"] if len(candidates) > 1 else 0.0
        result.issuer_key = str(top["issuer_key"])
        result.issuer_name = str(top["issuer_name"])
        result.confidence = float(top["score"])
        result.evidence = list(top["evidence"])
        result.method = METHOD_RULES
        if result.confidence >= ACCEPT_CONFIDENCE and (result.confidence - runner_up) >= LEAD_MARGIN:
            result.status = STATUS_RESOLVED
        else:
            result.status = STATUS_NEEDS_REVIEW
            result.method = METHOD_AMBIGUOUS if len(candidates) > 1 else METHOD_RULES

    if result.status == STATUS_RESOLVED or llm_client is None:
        return result

    try:
        raw = llm_client.chat(
            _llm_messages(text, filename, candidates), max_tokens=400, temperature=0.0
        )
        value = _extract_json(raw)
    except Exception as exc:  # noqa: BLE001 - a model failure must not fail ingest
        result.llm_error = f"{type(exc).__name__}: {exc}"[:300]
        return result

    issuer_key = str(value.get("issuer_key") or "").strip()
    if issuer_key and issuer_key in _JSON_ISSUER_KEYS:
        canonical = next(name for key, name, _a in KNOWN_ISSUERS if key == issuer_key)
        confidence = _clamp(value.get("confidence"), result.confidence)
        evidence = value.get("evidence")
        result.issuer_key = issuer_key
        result.issuer_name = canonical
        result.confidence = confidence
        result.method = METHOD_LLM
        if isinstance(evidence, list):
            result.evidence = [str(item)[:200] for item in evidence[:4] if str(item).strip()]
        requires_review = bool(value.get("requires_review", False))
        result.status = (
            STATUS_RESOLVED if confidence >= ACCEPT_CONFIDENCE and not requires_review else STATUS_NEEDS_REVIEW
        )
    else:
        result.issuer_key = ""
        result.issuer_name = ""
        result.confidence = 0.0
        result.method = METHOD_NOT_DETECTED
        result.status = STATUS_NEEDS_REVIEW

    return result


def _clamp(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(1.0, number))


def _extract_json(text: str) -> dict[str, Any]:
    try:
        from .llm_client import extract_json_object  # type: ignore
    except ImportError:  # pragma: no cover - flat sys.path import
        from llm_client import extract_json_object  # type: ignore
    return extract_json_object(text)


_DATE_PATTERNS = (
    re.compile(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})"),
    re.compile(r"(20\d{2})(\d{2})(\d{2})"),
)


def published_date_from(text: str, filename: str) -> str:
    """Best-effort publication date, used to age-weight claims later.

    An undated claim cannot join a revision series, so callers persist an empty
    string rather than substituting the ingest time.
    """

    for source in (filename, text[:HEADER_CHARS]):
        for pattern in _DATE_PATTERNS:
            match = pattern.search(source or "")
            if not match:
                continue
            year, month, day = (int(part) for part in match.groups())
            if 1 <= month <= 12 and 1 <= day <= 31:
                return f"{year:04d}-{month:02d}-{day:02d}"
    return ""


def ensure_issuer_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS document_issuers (
            doc_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            issuer_key TEXT,
            issuer_name TEXT,
            confidence REAL NOT NULL DEFAULT 0,
            method TEXT NOT NULL DEFAULT 'not_detected',
            status TEXT NOT NULL DEFAULT 'needs_review',
            candidates_json TEXT,
            evidence_json TEXT,
            published_date TEXT,
            detector_version TEXT NOT NULL,
            llm_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_document_issuers_dataset
            ON document_issuers(dataset_id, status, issuer_key);
        """
    )


def store_issuer(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    doc_id: str,
    identification: IssuerIdentification,
    published_date: str = "",
) -> None:
    ensure_issuer_schema(conn)
    conn.execute(
        """
        INSERT INTO document_issuers (
            doc_id, dataset_id, issuer_key, issuer_name, confidence, method, status,
            candidates_json, evidence_json, published_date, detector_version,
            llm_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
            issuer_key = excluded.issuer_key,
            issuer_name = excluded.issuer_name,
            confidence = excluded.confidence,
            method = excluded.method,
            status = excluded.status,
            candidates_json = excluded.candidates_json,
            evidence_json = excluded.evidence_json,
            published_date = excluded.published_date,
            detector_version = excluded.detector_version,
            llm_error = excluded.llm_error,
            updated_at = excluded.updated_at
        """,
        (
            doc_id,
            dataset_id,
            identification.issuer_key or None,
            identification.issuer_name or None,
            identification.confidence,
            identification.method,
            identification.status,
            json.dumps(identification.candidates, ensure_ascii=False),
            json.dumps(identification.evidence, ensure_ascii=False),
            published_date or None,
            ISSUER_DETECTOR_VERSION,
            identification.llm_error or None,
            now_iso(),
        ),
    )


def issuer_for_document(conn: sqlite3.Connection, doc_id: str) -> sqlite3.Row | None:
    ensure_issuer_schema(conn)
    return conn.execute(
        "SELECT * FROM document_issuers WHERE doc_id = ?", (doc_id,)
    ).fetchone()


__all__ = [
    "ACCEPT_CONFIDENCE",
    "ISSUER_DETECTOR_VERSION",
    "IssuerIdentification",
    "KNOWN_ISSUERS",
    "LEAD_MARGIN",
    "STATUS_NEEDS_REVIEW",
    "STATUS_RESOLVED",
    "ensure_issuer_schema",
    "identify_issuer",
    "issuer_for_document",
    "published_date_from",
    "store_issuer",
]
