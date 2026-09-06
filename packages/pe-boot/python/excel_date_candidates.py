from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, Optional


DATE_EXTRACTION_RULES_VERSION = "3"

DateAssertionStatus = Literal["affirmed", "negated", "unconfirmed"]
ASSERTION_SEVERITY = {"affirmed": 0, "unconfirmed": 1, "negated": 2}
UNCONFIRMED_ASSERTION = (
    r"(?:unconfirmed|unverified|not\s+(?:yet\s+)?(?:confirmed|final(?:i[sz]ed)?|approved|determined|known)|"
    r"pending(?:\s+(?:confirmation|approval))?|tentative(?:ly)?|provisional(?:ly)?|tbc|tbd|"
    r"(?:尚未|未)(?:确认|最终确定|确定|批准)|待(?:确认|定|批准)|暂定|暂估|不确定|拟定)"
)

FORECAST_PERIOD_PATTERN = re.compile(
    r"^(?:FY\s*)?(?:19|20)\d{2}\s*(?:E|F|P|EST|FCST|FORECAST)$",
    flags=re.IGNORECASE,
)
FORECAST_CONTEXT_PATTERN = re.compile(
    r"(?:\b(?:FY\s*)?(?:19|20)\d{2}\s*(?:E|F|P|EST|FCST)\b|\bforecast\b|预测|预算)",
    flags=re.IGNORECASE,
)
YEAR_FIRST_PATTERN = re.compile(
    r"(?<!\d)((?:19|20)\d{2})\s*(年|[-/._])\s*(0?[1-9]|1[0-2])\s*(?:月|[-/._])\s*(0?[1-9]|[12]\d|3[01])\s*日?(?!\d)",
    flags=re.IGNORECASE,
)
NUMERIC_DATE_PATTERN = re.compile(
    r"(?<!\d)(0?[1-9]|[12]\d|3[01])([/.\-])(0?[1-9]|[12]\d|3[01])\2((?:19|20)\d{2})(?!\d)"
)
DAY_MONTH_NAME_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(0?[1-9]|[12]\d|3[01])[-\s]+"
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"[-,\s]+((?:19|20)\d{2})(?!\d)",
    flags=re.IGNORECASE,
)
MONTH_NAME_DAY_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?:,|\s)+((?:19|20)\d{2})(?!\d)",
    flags=re.IGNORECASE,
)
YEAR_MONTH_NAME_PATTERN = re.compile(
    r"(?<!\d)((?:19|20)\d{2})[-_\s]+"
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"[-_\s]+(0?[1-9]|[12]\d|3[01])(?!\d)",
    flags=re.IGNORECASE,
)
DATE_LIKE_PATTERN = re.compile(
    r"(?<!\d)\d{1,4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,4}\s*日?(?!\d)"
)
COMPACT_FILENAME_DATE_PATTERN = re.compile(r"(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)")
MONTH_NUMBERS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

ROLE_RULES: tuple[tuple[str, tuple[str, ...], float, float], ...] = (
    (
        "valuation_date",
        (
            "valuation date",
            "valuation as of",
            "date of valuation",
            "估值基准日",
            "估值日期",
            "估值日",
        ),
        0.98,
        0.98,
    ),
    (
        "market_price_date",
        (
            "share price as of",
            "current price as of",
            "market price date",
            "pricing date",
            "closing price date",
            "price date",
            "市场价格日",
            "当前股价日",
            "收盘价日期",
            "股价日期",
            "定价日",
        ),
        0.88,
        0.94,
    ),
    (
        "financial_data_as_of",
        (
            "financial data as of",
            "financials as of",
            "balance sheet date",
            "financial data date",
            "财务数据截止日",
            "财报截止日",
            "数据截止日",
            "报告期末",
        ),
        0.82,
        0.92,
    ),
    (
        "report_publication_date",
        (
            "report publication date",
            "publication date",
            "published on",
            "report date",
            "报告发布日期",
            "发布日期",
        ),
        0.58,
        0.86,
    ),
    (
        "model_updated_at",
        (
            "model updated",
            "last updated",
            "update date",
            "model date",
            "模型更新时间",
            "模型更新日",
            "更新日期",
        ),
        0.52,
        0.82,
    ),
    (
        "target_horizon_end",
        (
            "target price date",
            "target horizon",
            "horizon end",
            "目标价期限",
            "目标日期",
            "目标期限",
        ),
        0.25,
        0.85,
    ),
)


@dataclass(frozen=True)
class DateCandidateObservation:
    normalized_date: Optional[str]
    raw_text: str
    role: str
    parse_method: str
    date_precision: str
    is_forecast: bool
    priority_score: float
    confidence: float
    rejection_reason: Optional[str] = None
    ambiguity: Optional[str] = None
    role_method: str = "unclassified_date"
    matched_text: Optional[str] = None
    label_context: Optional[str] = None
    assertion_status: DateAssertionStatus = "affirmed"


@dataclass(frozen=True)
class ParsedDateText:
    normalized_date: Optional[str]
    parse_method: str
    ambiguity: Optional[str]
    start: int
    end: int


def _normalize_text(value: object) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def _valid_date(year: int, month: int, day: int) -> Optional[str]:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _text_dates(value: str, *, filename: bool = False) -> list[ParsedDateText]:
    patterns = [
        (YEAR_FIRST_PATTERN, "year_first_text"),
        (NUMERIC_DATE_PATTERN, "numeric_text"),
        (DAY_MONTH_NAME_PATTERN, "day_month_name_text"),
        (MONTH_NAME_DAY_PATTERN, "month_name_day_text"),
        (YEAR_MONTH_NAME_PATTERN, "year_month_name_text"),
    ]
    if filename:
        patterns.append((COMPACT_FILENAME_DATE_PATTERN, "compact_filename_date"))
    dates: list[ParsedDateText] = []
    for pattern, method in patterns:
        for match in pattern.finditer(value):
            if any(match.start() < item.end and match.end() > item.start for item in dates):
                continue
            ambiguity = None
            parse_method = method
            if method == "year_first_text":
                year, month, day = int(match[1]), int(match[3]), int(match[4])
            elif method == "numeric_text":
                first, second, year = int(match[1]), int(match[3]), int(match[4])
                if first <= 12 and second <= 12 and first != second:
                    ambiguity = "day_month_order"
                    parse_method = "ambiguous_numeric_text"
                month, day = (second, first) if first > 12 else (first, second)
            elif method == "day_month_name_text":
                year, month, day = int(match[3]), MONTH_NUMBERS[match[2][:3].casefold()], int(match[1])
            elif method == "month_name_day_text":
                year, month, day = int(match[3]), MONTH_NUMBERS[match[1][:3].casefold()], int(match[2])
            elif method == "year_month_name_text":
                year, month, day = int(match[1]), MONTH_NUMBERS[match[2][:3].casefold()], int(match[3])
            else:
                year, month, day = int(match[1]), int(match[2]), int(match[3])
            normalized = _valid_date(year, month, day)
            if normalized is None:
                ambiguity = "invalid_calendar_date"
            dates.append(ParsedDateText(
                None if ambiguity else normalized, parse_method, ambiguity, match.start(), match.end()
            ))
    for match in DATE_LIKE_PATTERN.finditer(value):
        if not any(match.start() < item.end and match.end() > item.start for item in dates):
            dates.append(ParsedDateText(
                None, "unparsed_text", "unrecognized_date_text", match.start(), match.end()
            ))
    return sorted(dates, key=lambda item: item.start)


def _label_assertion_status(context: str, start: int, end: int) -> DateAssertionStatus:
    # Only qualifications immediately attached to this label apply. For example,
    # "Valuation date: ... , WACC not confirmed" must not qualify the date.
    before = context[:start].replace("_", " ")
    after = context[end:].replace("_", " ")
    punctuation = r"[\s:：,，()\[\]/-]*"
    copula = r"(?:(?:is|was|remains)(?:\s+still)?\s+|still\s+)?"
    if re.search(
        rf"(?<![a-z]){UNCONFIRMED_ASSERTION}(?![a-z]){punctuation}(?:(?:a|an|the)\s+)?$",
        before, re.IGNORECASE,
    ) or re.search(
        rf"^{punctuation}{copula}{UNCONFIRMED_ASSERTION}(?![a-z])", after, re.IGNORECASE,
    ):
        return "unconfirmed"
    if re.search(
        rf"(?<![a-z])(?:not\s+(?:(?:used|intended)\s+as\s+)?(?:(?:a|an|the)\s+)?|"
        rf"no\s+|不是|并非|不作为|不适用(?:于)?|非){punctuation}$",
        before, re.IGNORECASE,
    ) or re.search(
        rf"^{punctuation}{copula}(?:not(?:\s+(?:applicable|valid|used|intended))?(?=$|[\s:：,，()\[\]/-]*$)|"
        r"不是|并非|不适用)", after, re.IGNORECASE,
    ):
        return "negated"
    return "affirmed"


def _role_from_context(
    raw_text: str, row_label: str, col_label: str,
) -> tuple[str, float, float, str, DateAssertionStatus]:
    # Do not assemble a marker from unrelated cells or inherit a neighbor's own date.
    contexts = [raw_text] + [
        label for label in (row_label, col_label) if len(label) <= 120 and not _text_dates(label)
    ]
    explicit: list[tuple[str, float, float, str, DateAssertionStatus]] = []
    for index, context in enumerate(contexts):
        matches: list[tuple[int, int, str, float, float, str]] = []
        for role, markers, priority, confidence in ROLE_RULES:
            for marker in markers:
                marker_pattern = r"[\s_./:-]*".join(re.escape(word) for word in marker.split())
                for match in re.finditer(r"(?<![a-z])" + marker_pattern + r"(?![a-z])", context, re.IGNORECASE):
                    matches.append((match.start(), match.end(), role, priority, confidence, f"explicit_label:{marker}"))
        if matches:
            # Remove contained generic markers, not independent conflicting roles.
            specific = [item for item in matches if not any(
                other[0] <= item[0] and other[1] >= item[1]
                and other[1] - other[0] > item[1] - item[0]
                for other in matches
            )]
            if len({item[2] for item in specific}) > 1:
                return "unknown", 0.0, 0.4, "conflicting_date_labels", "affirmed"
            _, _, role, priority, confidence, method = max(specific, key=lambda item: item[1] - item[0])
            assertion = max(
                (_label_assertion_status(context, item[0], item[1]) for item in specific),
                key=lambda status: ASSERTION_SEVERITY[status],
            )
            if index == 0:
                return role, priority, confidence, method, assertion
            explicit.append((role, priority, confidence, method, assertion))
    if len({item[0] for item in explicit}) > 1:
        return "unknown", 0.0, 0.4, "conflicting_neighbor_labels", "affirmed"
    if explicit:
        role, priority, confidence, method, assertion = max(explicit, key=lambda item: ASSERTION_SEVERITY[item[4]])
        # A bare date can carry its own qualification while its role comes from
        # a neighboring label, e.g. A1="Valuation Date", B1="... (tentative)".
        assertion = max(
            (assertion, _label_assertion_status(raw_text, 0, 0)),
            key=lambda status: ASSERTION_SEVERITY[status],
        )
        return role, priority, confidence, method, assertion
    for pattern, role, priority, confidence, method in (
        (r"(?<![a-z])as[\s_]*of(?![a-z])|基准日", "valuation_date", 0.66, 0.68, "generic_as_of_label"),
        (r"截至", "financial_data_as_of", 0.35, 0.58, "generic_cutoff_label"),
    ):
        for context in contexts:
            match = re.search(pattern, context, re.IGNORECASE)
            if match:
                assertion = max(
                    (_label_assertion_status(context, match.start(), match.end()), _label_assertion_status(raw_text, 0, 0)),
                    key=lambda status: ASSERTION_SEVERITY[status],
                )
                return role, priority, confidence, method, assertion
    return "unknown", 0.12, 0.35, "unclassified_date", "affirmed"


def extract_cell_date_candidate(
    value: object,
    *,
    row_label: str = "",
    col_label: str = "",
) -> Optional[DateCandidateObservation]:
    raw_text = _normalize_text(value)
    row_label = _normalize_text(row_label)
    col_label = _normalize_text(col_label)
    if not raw_text or raw_text.startswith("="):
        return None

    if FORECAST_PERIOD_PATTERN.fullmatch(raw_text):
        return DateCandidateObservation(
            normalized_date=None,
            raw_text=raw_text,
            role="forecast_period",
            parse_method="forecast_period_token",
            date_precision="period",
            is_forecast=True,
            priority_score=0.0,
            confidence=0.99,
            rejection_reason="forecast_period_is_not_valuation_date",
            role_method="forecast_suffix",
        )

    label_context = ""
    matched_text = raw_text
    if isinstance(value, datetime):
        normalized_date = value.date().isoformat()
        parse_method = "excel_datetime"
        ambiguity = None
    elif isinstance(value, date):
        normalized_date = value.isoformat()
        parse_method = "excel_date"
        ambiguity = None
    elif isinstance(value, str):
        dates = _text_dates(raw_text)
        if not dates:
            return None
        if len(dates) > 1:
            return DateCandidateObservation(
                normalized_date=None,
                raw_text=raw_text,
                role="unknown",
                parse_method="multiple_date_text",
                date_precision="day",
                is_forecast=False,
                priority_score=0.0,
                confidence=0.0,
                rejection_reason="multiple_dates_require_review",
                ambiguity="multiple_date_spans",
            )
        parsed = dates[0]
        normalized_date, parse_method, ambiguity = parsed.normalized_date, parsed.parse_method, parsed.ambiguity
        matched_text = raw_text[parsed.start:parsed.end]
        # Scope labels to the date's clause instead of the full disclaimer/narrative.
        before = re.split(r"[;。!?；！？]|\.\s+", raw_text[max(0, parsed.start - 80):parsed.start])[-1]
        after = re.split(r"[;。!?；！？]|\.\s+", raw_text[parsed.end:parsed.end + 40])[0]
        label_context = f"{before} {after}".strip()
        if parse_method == "unparsed_text":
            role, _, confidence, role_method, assertion_status = _role_from_context(
                label_context,
                row_label,
                col_label,
            )
            if role == "unknown":
                return None
            return DateCandidateObservation(
                normalized_date=None,
                raw_text=raw_text,
                role=role,
                parse_method=parse_method,
                date_precision="unknown",
                is_forecast=False,
                priority_score=0.0,
                confidence=min(confidence, 0.5),
                rejection_reason="date_text_could_not_be_normalized",
                ambiguity=ambiguity,
                role_method=role_method,
                matched_text=matched_text,
                label_context=label_context,
                assertion_status=assertion_status,
            )
    else:
        return None

    role, priority, confidence, role_method, assertion_status = _role_from_context(label_context, row_label, col_label)
    rejection_reason: Optional[str] = None
    forecast_context = bool(
        FORECAST_CONTEXT_PATTERN.search(_normalize_text(" ".join((label_context, row_label, col_label))))
    )
    is_forecast = forecast_context and role == "unknown"
    if is_forecast:
        role = "forecast_period"
        priority = 0.0
        confidence = max(confidence, 0.9)
        role_method = "forecast_context"
        rejection_reason = "forecast_period_is_not_valuation_date"
    if ambiguity:
        rejection_reason = "ambiguous_date_text_requires_review"
        priority = 0.0
        confidence = min(confidence, 0.4)
    elif role == "unknown":
        rejection_reason = "date_role_not_identified"
    elif assertion_status != "affirmed":
        rejection_reason = f"date_assertion_{assertion_status}"
        priority = 0.0
        confidence = 0.0 if assertion_status == "negated" else min(confidence, 0.5)
        if not label_context:
            label_context = " | ".join(label for label in (row_label, col_label) if label)
    return DateCandidateObservation(
        normalized_date=normalized_date,
        raw_text=raw_text,
        role=role,
        parse_method=parse_method,
        date_precision="day",
        is_forecast=is_forecast,
        priority_score=priority,
        confidence=confidence,
        rejection_reason=rejection_reason,
        ambiguity=ambiguity,
        role_method=role_method,
        matched_text=matched_text,
        label_context=label_context,
        assertion_status=assertion_status,
    )


def extract_filename_date(name: str) -> Optional[DateCandidateObservation]:
    text = _normalize_text(name)
    dates = _text_dates(text, filename=True)
    years = set(re.findall(r"(?<!\d)((?:19|20)\d{2})(?!\d)", text))
    if dates:
        if len(dates) != 1 or dates[0].normalized_date is None:
            return None
        parsed = dates[0]
        normalized = parsed.normalized_date
        precision = "day"
        method = parsed.parse_method
        matched_text = text[parsed.start:parsed.end]
    elif len(years) == 1:
        normalized = next(iter(years))
        precision = "year"
        method = "filename_year"
        matched_text = normalized
    else:
        return None
    return DateCandidateObservation(
        normalized_date=normalized,
        raw_text=text,
        role="filename_date",
        parse_method=method,
        date_precision=precision,
        is_forecast=False,
        priority_score=0.02,
        confidence=0.5,
        rejection_reason="filename_cannot_verify_valuation_date",
        role_method="filename_metadata",
        matched_text=matched_text,
    )


def workbook_property_date_candidate(
    value: object,
    *,
    role: str,
) -> Optional[DateCandidateObservation]:
    if not isinstance(value, (date, datetime)):
        return None
    normalized_date = value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    return DateCandidateObservation(
        normalized_date=normalized_date,
        raw_text=value.isoformat(),
        role=role,
        parse_method="workbook_property",
        date_precision="day",
        is_forecast=False,
        priority_score=0.02,
        confidence=0.5,
        rejection_reason="workbook_property_cannot_verify_valuation_date",
        role_method="workbook_property",
    )
