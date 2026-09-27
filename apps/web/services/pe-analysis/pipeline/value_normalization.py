"""Deterministic normalization of the numbers analysts write.

The model copies a value and its unit exactly as printed. Everything that makes
two brokers comparable happens here, in code that can be tested without a model:

* ``165 亿元`` and ``16,500 百万元`` both become ``1.65e10`` in canonical unit
  ``元``; the currency travels separately so ``亿美元`` is never mixed in.
* ``32.5%``, ``0.325`` written as a ratio, and ``3 个百分点`` are kept apart:
  percentages canonicalize to ``%`` on the 0-100 scale, percentage-point
  changes to ``pp``.
* ``2026E``, ``FY26``, ``2026 年`` and ``26E`` all become ``FY2026``; halves and
  quarters become ``2026H2`` / ``2026Q3``.

Units outside the tables (GW, 万台, 万吨) are kept verbatim after whitespace and
width normalization so identical spellings still group together.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

CANONICAL_AMOUNT_UNIT = "元"
CANONICAL_PERCENT_UNIT = "%"
CANONICAL_PP_UNIT = "pp"
CANONICAL_MULTIPLE_UNIT = "x"

# Scale words in the order they must be matched (longest first).
_SCALES: tuple[tuple[str, float], ...] = (
    ("万亿", 1e12),
    ("千亿", 1e11),
    ("百亿", 1e10),
    ("十亿", 1e9),
    ("亿", 1e8),
    ("千万", 1e7),
    ("百万", 1e6),
    ("十万", 1e5),
    ("万", 1e4),
    ("千", 1e3),
    ("trillion", 1e12),
    ("tn", 1e12),
    ("billion", 1e9),
    ("bn", 1e9),
    ("million", 1e6),
    ("mn", 1e6),
    ("mm", 1e6),
    ("thousand", 1e3),
    ("k", 1e3),
)

_CURRENCY_WORDS: tuple[tuple[str, str], ...] = (
    ("人民币", "CNY"),
    ("rmb", "CNY"),
    ("cny", "CNY"),
    ("美元", "USD"),
    ("美金", "USD"),
    ("usd", "USD"),
    ("us$", "USD"),
    ("港元", "HKD"),
    ("港币", "HKD"),
    ("hkd", "HKD"),
    ("hk$", "HKD"),
    ("欧元", "EUR"),
    ("eur", "EUR"),
    ("日元", "JPY"),
    ("jpy", "JPY"),
    ("新台币", "TWD"),
    ("台币", "TWD"),
    ("twd", "TWD"),
    ("元", "CNY"),
    ("$", "USD"),
    ("¥", "CNY"),
    ("€", "EUR"),
    ("£", "GBP"),
    ("gbp", "GBP"),
)

_PERCENT_TOKENS = ("%", "％", "pct", "percent", "百分比")
_PP_TOKENS = ("个百分点", "百分点", "pp", "ppt", "ppts", "bp", "bps")
_MULTIPLE_TOKENS = ("x", "×", "倍", "times")
_PER_SHARE_TOKENS = ("/股", "每股", "per share", "/share")


@dataclass(frozen=True)
class NormalizedValue:
    value_canonical: float | None
    canonical_unit: str
    currency: str
    unit_normalized: str


def _clean(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).strip().lower().replace(" ", "")


def normalize_currency(value: str) -> str:
    cleaned = _clean(value)
    if not cleaned:
        return ""
    for token, code in _CURRENCY_WORDS:
        if token in cleaned:
            return code
    return cleaned.upper()[:8]


def normalize_value(
    value: float | None,
    unit: str,
    currency: str = "",
) -> NormalizedValue:
    """Map a printed value and unit to a canonical scale.

    Returns the original value untouched (with the whitespace-normalized unit)
    when the unit is outside the known families, so volumes such as ``GW`` or
    ``万台`` still carry a unit but are never rescaled by guesswork.
    """

    unit_clean = _clean(unit)
    currency_code = normalize_currency(currency)

    if value is None:
        return NormalizedValue(None, unit_clean, currency_code, unit_clean)

    # Percentage points before percent: "个百分点" contains no "%" but "pp" must
    # not be confused with a currency scale.
    if any(unit_clean == token or unit_clean.endswith(token) for token in _PP_TOKENS):
        multiplier = 0.01 if unit_clean.endswith(("bp", "bps")) else 1.0
        return NormalizedValue(value * multiplier, CANONICAL_PP_UNIT, "", unit_clean)

    if any(token in unit_clean for token in _PERCENT_TOKENS):
        return NormalizedValue(value, CANONICAL_PERCENT_UNIT, "", unit_clean)

    if unit_clean in _MULTIPLE_TOKENS or unit_clean.endswith(("倍", "x")) and not _has_currency(unit_clean):
        return NormalizedValue(value, CANONICAL_MULTIPLE_UNIT, "", unit_clean)

    per_share = any(token in unit_clean for token in _PER_SHARE_TOKENS)
    scale, remainder = _split_scale(unit_clean)
    for token in _PER_SHARE_TOKENS:
        remainder = remainder.replace(token, "")
    unit_currency = _pure_currency(remainder)
    # A bare scale word ("亿") with a currency supplied separately is still an
    # amount. "元/Wh" or "美元/吨" are prices, not amounts, and stay verbatim.
    if unit_currency or (not remainder and currency_code):
        canonical = f"{CANONICAL_AMOUNT_UNIT}/股" if per_share else CANONICAL_AMOUNT_UNIT
        return NormalizedValue(
            value * scale,
            canonical,
            unit_currency or currency_code,
            unit_clean,
        )

    return NormalizedValue(value, unit_clean, currency_code, unit_clean)


def _has_currency(text: str) -> bool:
    return any(token in text for token, _code in _CURRENCY_WORDS)


def _pure_currency(text: str) -> str:
    for token, code in _CURRENCY_WORDS:
        if text == token:
            return code
    return ""


def _split_scale(unit_clean: str) -> tuple[float, str]:
    for word, multiplier in _SCALES:
        if unit_clean.startswith(word):
            return multiplier, unit_clean[len(word) :]
    # "USD mn" style: currency first, scale last.
    for word, multiplier in _SCALES:
        if unit_clean.endswith(word) and len(unit_clean) > len(word):
            return multiplier, unit_clean[: -len(word)]
    return 1.0, unit_clean


# ---------------------------------------------------------------- periods

_FULL_YEAR = re.compile(r"(20\d{2})(?!\d)")
_QUARTER = re.compile(r"(?:q([1-4])|([1-4])q|第?([一二三四1-4])季度?)")
_HALF = re.compile(r"(?:h([12])|([12])h|(上|下)半年)")
_RANGE = re.compile(r"(20\d{2})\s*(?:-|–|—|~|至|到)\s*(20\d{2}|\d{2})")
_CN_QUARTER = {"一": 1, "二": 2, "三": 3, "四": 4}


def normalize_period(text: str) -> str:
    """Return a canonical period token, or the cleaned input when unrecognized.

    Recognized forms: ``FY2026`` for a fiscal year, ``2026H1``/``2026H2`` for
    halves, ``2026Q3`` for quarters, ``FY2026-FY2028`` for ranges. Words such
    as ``未来三年`` are returned as written so they can still group by string.
    """

    raw = unicodedata.normalize("NFKC", str(text or "")).strip()
    lowered = raw.lower().replace(" ", "")
    if not lowered:
        return ""

    range_match = _RANGE.search(lowered)
    if range_match:
        start = int(range_match.group(1))
        end_raw = range_match.group(2)
        end = int(end_raw) if len(end_raw) == 4 else int(f"{str(start)[:2]}{end_raw}")
        if end >= start:
            return f"FY{start}-FY{end}"

    year = _year_from(lowered)
    if year is None:
        return raw

    quarter = _QUARTER.search(lowered)
    if quarter:
        number = next(group for group in quarter.groups() if group)
        index = _CN_QUARTER.get(number, None) or int(number)
        return f"{year}Q{index}"

    half = _HALF.search(lowered)
    if half:
        groups = half.groups()
        if groups[2]:
            index = 1 if groups[2] == "上" else 2
        else:
            index = int(groups[0] or groups[1])
        return f"{year}H{index}"

    return f"FY{year}"


def _year_from(lowered: str) -> int | None:
    full = _FULL_YEAR.search(lowered)
    if full:
        return int(full.group(1))
    # "26e", "fy26", "26年": a two-digit year is only accepted with a marker so
    # a bare "26" (which could be a value) is never promoted to a year.
    short = re.search(r"(?:fy|cy|q[1-4]|[1-4]q|h[12]|[12]h)(\d{2})(?!\d)", lowered) or re.search(
        r"(?<!\d)(\d{2})(?=e|a|f|年)", lowered
    )
    if short:
        return 2000 + int(short.group(1))
    return None


__all__ = [
    "CANONICAL_AMOUNT_UNIT",
    "CANONICAL_MULTIPLE_UNIT",
    "CANONICAL_PERCENT_UNIT",
    "CANONICAL_PP_UNIT",
    "NormalizedValue",
    "normalize_currency",
    "normalize_period",
    "normalize_value",
]
