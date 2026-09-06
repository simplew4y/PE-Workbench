"""On-demand workbook cache, extracted from the former upload pipeline.

Only the requested immutable document version is parsed. These tables support
financial calculations; no text chunks, retrieval index, or upload jobs exist.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import re
import sqlite3
import unicodedata
from dataclasses import replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import openpyxl
from openpyxl import load_workbook
from excel_date_candidates import (
    DATE_EXTRACTION_RULES_VERSION, DateCandidateObservation,
    extract_cell_date_candidate, workbook_property_date_candidate,
)
from excel_formula_parser import extract_formula_references

DEFAULT_MAX_REGION_LABELS = 30

WORKBOOK_SCHEMA = """
CREATE TABLE IF NOT EXISTS excel_workbooks (
            workbook_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            workbook_type TEXT NOT NULL,
            sheet_count INTEGER NOT NULL,
            visible_sheet_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS excel_sheets (
            sheet_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_index INTEGER NOT NULL,
            sheet_name TEXT NOT NULL,
            sheet_role TEXT NOT NULL,
            sheet_state TEXT,
            used_range TEXT,
            row_count INTEGER NOT NULL,
            col_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            summary TEXT,
            header_json TEXT,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS excel_regions (
            region_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL,
            region_index INTEGER NOT NULL,
            region_type TEXT NOT NULL,
            cell_range TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            col_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            summary TEXT,
            header_json TEXT,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS excel_cells (
            cell_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            value_type TEXT NOT NULL,
            display_value TEXT,
            raw_value TEXT,
            numeric_value REAL,
            formula TEXT,
            cached_value TEXT,
            number_format TEXT,
            row_label TEXT,
            col_label TEXT,
            period TEXT,
            unit TEXT,
            is_formula INTEGER NOT NULL DEFAULT 0,
            formula_type TEXT,
            formula_cache_status TEXT NOT NULL DEFAULT 'not_applicable',
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS excel_defined_names (
            defined_name_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            name TEXT NOT NULL,
            scope_sheet TEXT,
            name_type TEXT,
            attr_text TEXT,
            hidden INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS excel_formula_references (
            reference_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            source_cell_id TEXT NOT NULL,
            source_sheet TEXT NOT NULL,
            source_cell_ref TEXT NOT NULL,
            reference_index INTEGER NOT NULL,
            raw_reference TEXT NOT NULL,
            reference_kind TEXT NOT NULL,
            target_sheet TEXT,
            target_range TEXT,
            defined_name TEXT,
            external_workbook TEXT,
            parse_status TEXT NOT NULL,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS valuation_date_candidates (
            candidate_id TEXT PRIMARY KEY,
            schema_version TEXT NOT NULL DEFAULT '1.0',
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            normalized_date TEXT,
            raw_text TEXT NOT NULL,
            role TEXT NOT NULL,
            source_type TEXT NOT NULL,
            evidence_id TEXT,
            sheet_name TEXT,
            cell_ref TEXT,
            row_index INTEGER,
            col_index INTEGER,
            nearby_label TEXT,
            parse_method TEXT NOT NULL,
            date_precision TEXT NOT NULL,
            is_forecast INTEGER NOT NULL DEFAULT 0,
            priority_score REAL NOT NULL,
            confidence REAL NOT NULL,
            rejection_reason TEXT,
            metadata_json TEXT
        );
CREATE TABLE IF NOT EXISTS metric_facts (
            fact_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            metric_alias TEXT,
            period TEXT,
            value_text TEXT,
            value_numeric REAL,
            unit TEXT,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            source_range TEXT,
            formula TEXT,
            confidence REAL NOT NULL DEFAULT 0.5,
            fact_status TEXT NOT NULL DEFAULT 'candidate',
            quality_status TEXT NOT NULL DEFAULT 'review_required',
            quality_issues_json TEXT,
            metadata_json TEXT
        );
CREATE INDEX IF NOT EXISTS idx_excel_sheets_doc ON excel_sheets(doc_id, sheet_name);
CREATE INDEX IF NOT EXISTS idx_excel_regions_doc ON excel_regions(doc_id, sheet_name, cell_range);
CREATE INDEX IF NOT EXISTS idx_excel_cells_doc_sheet ON excel_cells(doc_id, sheet_name, cell_ref);
CREATE INDEX IF NOT EXISTS idx_excel_cells_doc_sheet_position
            ON excel_cells(doc_id, sheet_name, row_index, col_index);
CREATE INDEX IF NOT EXISTS idx_excel_defined_names_doc_name
            ON excel_defined_names(doc_id, name, scope_sheet);
CREATE INDEX IF NOT EXISTS idx_excel_formula_references_source
            ON excel_formula_references(doc_id, source_sheet, source_cell_ref, reference_index);
CREATE INDEX IF NOT EXISTS idx_excel_formula_references_target
            ON excel_formula_references(doc_id, target_sheet, target_range);
CREATE INDEX IF NOT EXISTS idx_valuation_date_candidates_doc_role
            ON valuation_date_candidates(doc_id, role, normalized_date);
CREATE INDEX IF NOT EXISTS idx_metric_facts_metric ON metric_facts(doc_id, metric_name, period);
CREATE INDEX IF NOT EXISTS idx_metric_facts_source ON metric_facts(doc_id, sheet_name, cell_ref);
"""

WORKBOOK_TABLES = ('excel_cells', 'excel_defined_names', 'excel_formula_references', 'excel_regions', 'excel_sheets', 'excel_workbooks', 'metric_facts', 'valuation_date_candidates')

def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    # openpyxl's ArrayFormula/DataTableFormula (and a few other library
    # objects) use the default object repr, which embeds a process-specific
    # memory address.  Persist a deterministic structural description instead.
    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        return {
            "type": type(value).__name__,
            "attributes": {str(k): json_safe(v) for k, v in sorted(attributes.items())},
        }
    return {"type": type(value).__name__}


def dumps_json(value: Any) -> str:
    return json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True)


def normalize_text(value: Any) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value
    elif isinstance(value, (int, float, bool, datetime, date, Path)):
        text = str(json_safe(value))
    else:
        text = dumps_json(value)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def cell_display(value: Any, max_len: int = 160) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        text = value.isoformat()
    else:
        text = normalize_text(value)
    if len(text) > max_len:
        return text[: max_len - 1] + "..."
    return text


def _col_letter(index: int) -> str:
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _cell_ref(row: int, col: int) -> str:
    return f"{_col_letter(col)}{row}"


def _range_ref(min_row: int, min_col: int, max_row: int, max_col: int) -> str:
    return f"{_cell_ref(min_row, min_col)}:{_cell_ref(max_row, max_col)}"


def _is_formula(value: Any) -> bool:
    if isinstance(value, str):
        return value.startswith("=")
    return type(value).__name__ in {"ArrayFormula", "DataTableFormula"}


def _formula_details(value: Any) -> tuple[bool, Optional[str], Optional[str], dict[str, Any]]:
    if isinstance(value, str) and value.startswith("="):
        return True, "standard", value, {}
    formula_type = type(value).__name__
    if formula_type not in {"ArrayFormula", "DataTableFormula"}:
        return False, None, None, {}
    attributes = json_safe(getattr(value, "__dict__", {}))
    metadata = attributes if isinstance(attributes, dict) else {"attributes": attributes}
    expression = getattr(value, "text", None)
    if isinstance(expression, str) and expression:
        formula_text = expression
    else:
        formula_text = dumps_json({"formula_type": formula_type, **metadata})
    stable_type = "array" if formula_type == "ArrayFormula" else "data_table"
    return True, stable_type, formula_text, metadata


def _formula_cache_status(is_formula: bool, cached: Any) -> str:
    if not is_formula:
        return "not_applicable"
    if cached is None or cached == "":
        return "missing"
    if _is_formula(cached) or not isinstance(cached, (str, int, float, bool, datetime, date)):
        return "unavailable"
    if isinstance(cached, str) and cached.startswith("#"):
        return "error"
    return "present"


def _numeric_value(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    text = normalize_text(value).replace(",", "")
    if not text:
        return None
    percent = text.endswith("%")
    if percent:
        text = text[:-1]
    try:
        number = float(text)
        return number / 100.0 if percent else number
    except ValueError:
        return None


def _period_from_label(label: str) -> str:
    label = normalize_text(label)
    # A financial value such as ``12068.32666`` can contain a ``20xx``
    # substring after the decimal point.  Treat only standalone period tokens
    # as years; otherwise long statement rows inherit fictitious periods.
    patterns = [
        r"(?<![\d.])([1-4]Q\s*20\d{2})(?![\d.])",
        r"(?<![\d.])(20\d{2}\s*[1-4]Q)(?![\d.])",
        r"(?<![\d.])(Q[1-4]\s*[-/. ]?\s*20\d{2})(?![\d.])",
        r"(?<![\d.])(Q[1-4]\s*[-/. ]?\s*\d{2})(?![\d.])",
        r"(?<![\d.])(FY\s*20\d{2})(?![\d.])",
        r"(?<![\d.])([1-4]Q\s*\d{2})(?![\d.])",
        r"(?<![\d.])(FY\s*\d{2})(?![\d.])",
        r"(?<![\d.])(20\d{2}\s*[EQAF]?)(?![\d.])",
    ]
    for pattern in patterns:
        match = re.search(pattern, label, flags=re.IGNORECASE)
        if match:
            period = normalize_text(match.group(1))
            year_match = re.search(r"(?<!\d)(20\d{2}|\d{2})(?!\d)", period)
            if year_match:
                year = int(year_match.group(1))
                if year < 100:
                    year = 1900 + year if year >= 70 else 2000 + year
                if not 1990 <= year <= 2050:
                    continue
            return period
    return ""


def _looks_like_period_label(label: str) -> bool:
    return bool(_period_from_label(label))


def _unit_from_text(text: str) -> str:
    text = normalize_text(text)
    if "%" in text:
        return "%"
    for unit in (
        "CNYm",
        "RMBm",
        "USDm",
        "GWh",
        "MWh",
        "Wh",
        "MW",
        "GW",
        "元/Wh",
    ):
        if unit.lower() in text.lower():
            return unit
    compact = re.sub(r"\s+", "", text).lower()
    share_units = (
        (("港元/股", "hkd/share"), "HKD/share"),
        (("美元/股", "usd/share"), "USD/share"),
        (("人民币/股", "cny/share"), "CNY/share"),
        (("元/股",), "CNY/share"),
        (("rmb/share",), "RMB/share"),
    )
    for markers, unit in share_units:
        if any(marker in compact for marker in markers):
            return unit
    if re.search(r"(?:/|per)share\b", compact) or "/股" in compact or "每股" in compact:
        return "per_share"
    return ""


def _unit_from_number_format(number_format: str) -> str:
    return "%" if "%" in str(number_format or "") else ""


def _sheet_role(sheet_name: str, sample_text: str) -> str:
    normalized_name = normalize_text(sheet_name).lower()
    if any(
        marker in normalized_name
        for marker in ("upload", "download", "raw data", "raw_data", "bloomberg", "__fdscache__")
    ):
        return "raw_upload"
    text = f"{sheet_name} {sample_text}".lower()
    checks = [
        (
            "valuation_dcf",
            ("dcf", "wacc", "terminal value", "valuation", "估值"),
        ),
        ("sensitivity", ("sensitivity", "敏感")),
        ("driver_model", ("driver", "assumption", "asp", "shipment", "假设", "驱动")),
        (
            "financial_statement",
            (
                "pl_bs_cfs",
                "income statement",
                "balance sheet",
                "cash flow",
                "利润表",
                "资产负债表",
                "现金流量表",
            ),
        ),
        ("quarterly_results", ("qoq", "results", "quarter", "季报", "季度")),
        ("output_table", ("table", "snapshot", "breakdown", "摘要", "概览", "输出")),
        ("chart_data", ("chart",)),
        ("raw_upload", ("upload", "bloomberg", "@")),
        ("resource_note", ("resource", "products", "产品")),
    ]
    for role, words in checks:
        if any(word in text for word in words):
            return role
    return "worksheet"


def _region_type(sheet_name: str, values: list[Any], formula_count: int) -> str:
    text = normalize_text(" ".join(cell_display(v, 80) for v in values)).lower()
    mapping = [
        (
            "valuation_dcf",
            (
                "dcf",
                "wacc",
                "terminal value",
                "valuation",
                "估值",
                "目标价",
                "企业价值",
                "股权价值",
            ),
        ),
        ("sensitivity", ("sensitivity", "敏感")),
        (
            "income_statement",
            (
                "revenue",
                "gross profit",
                "net profit",
                "eps",
                "income statement",
                "收入",
                "毛利",
                "净利润",
                "利润表",
            ),
        ),
        ("cash_flow", ("free cash flow", "cash flow", "fcf", "自由现金流", "现金流")),
        ("driver_assumption", ("driver", "asp", "shipment", "assumption", "orders", "假设", "驱动")),
        ("business_breakdown", ("breakdown", "segment", "contribution", "分部", "业务拆分")),
        ("note", ("note", "摘要", "q&a", "备注")),
    ]
    for region_type, words in mapping:
        if any(word in text for word in words):
            return region_type
    if formula_count / max(1, len(values)) >= 0.25:
        return "formula_block"
    if len(values) >= 6:
        return "table"
    return "text_block"


def _workbook_type(sheet_summaries: list[dict[str, Any]]) -> str:
    formulas = sum(int(s["formula_count"]) for s in sheet_summaries)
    non_empty = sum(int(s["non_empty_cell_count"]) for s in sheet_summaries)
    density = formulas / max(1, non_empty)
    role_text = " ".join(str(s.get("sheet_role") or "") for s in sheet_summaries)
    if density >= 0.15 or any(role in role_text for role in ("valuation_dcf", "driver_model", "sensitivity")):
        return "valuation_model"
    if len(sheet_summaries) <= 3 and density < 0.1:
        return "simple_table"
    return "financial_workbook"


def _nonempty_cells(ws) -> dict[tuple[int, int], Any]:
    cells: dict[tuple[int, int], Any] = {}
    for key, cell in getattr(ws, "_cells", {}).items():
        value = cell.value
        if value is not None and cell_display(value):
            cells[(cell.row, cell.column)] = value
    return cells


def _sheet_bounds(cells: dict[tuple[int, int], Any]) -> Optional[tuple[int, int, int, int]]:
    if not cells:
        return None
    rows = [row for row, _ in cells]
    cols = [col for _, col in cells]
    return min(rows), min(cols), max(rows), max(cols)


def _group_sorted(values: list[int], gap: int = 1) -> list[tuple[int, int]]:
    if not values:
        return []
    values = sorted(set(values))
    groups: list[tuple[int, int]] = []
    start = prev = values[0]
    for value in values[1:]:
        if value - prev <= gap + 1:
            prev = value
        else:
            groups.append((start, prev))
            start = prev = value
    groups.append((start, prev))
    return groups


def _detect_regions(cells: dict[tuple[int, int], Any]) -> list[tuple[int, int, int, int]]:
    row_groups = _group_sorted([row for row, _ in cells], gap=1)
    regions: list[tuple[int, int, int, int]] = []
    for row_start, row_end in row_groups:
        cols = [col for row, col in cells if row_start <= row <= row_end]
        for col_start, col_end in _group_sorted(cols, gap=1):
            region_cells = [
                (row, col)
                for row, col in cells
                if row_start <= row <= row_end and col_start <= col <= col_end
            ]
            if region_cells:
                rows = [row for row, _ in region_cells]
                cols_in_region = [col for _, col in region_cells]
                regions.append((min(rows), min(cols_in_region), max(rows), max(cols_in_region)))
    return regions


def _nearest_left_label(row_text_cols: dict[int, list[tuple[int, str]]], row: int, col: int) -> str:
    cols = row_text_cols.get(row) or []
    indexes = [item[0] for item in cols]
    pos = bisect.bisect_left(indexes, col) - 1
    while pos >= 0:
        label = cols[pos][1]
        if label:
            return label
        pos -= 1
    return ""


def _nearest_top_label(col_text_rows: dict[int, list[tuple[int, str]]], row: int, col: int) -> str:
    rows = col_text_rows.get(col) or []
    indexes = [item[0] for item in rows]
    pos = bisect.bisect_left(indexes, row) - 1
    while pos >= 0:
        label = rows[pos][1]
        if label:
            return label
        pos -= 1
    return ""


def _sample_labels(cells: dict[tuple[int, int], Any], max_items: int = DEFAULT_MAX_REGION_LABELS) -> list[str]:
    labels: list[str] = []
    for _, value in sorted(cells.items(), key=lambda item: item[0]):
        text = cell_display(value, 80)
        if text and not _is_formula(value) and not re.fullmatch(r"[-+]?\d+(\.\d+)?%?", text):
            labels.append(text)
        if len(labels) >= max_items:
            break
    return labels


def prepare_workbook(conn: sqlite3.Connection, *, dataset_id: str, doc_id: str, path: Path) -> dict[str, Any]:

    parser_name = "openpyxl"
    parser_version = str(getattr(openpyxl, "__version__", "unknown"))

    wb_formula = load_workbook(path, data_only=False, read_only=False, keep_links=True)
    wb_values = load_workbook(path, data_only=True, read_only=False, keep_links=True)

    sheet_rows: list[dict[str, Any]] = []
    region_rows: list[dict[str, Any]] = []
    cell_rows: list[dict[str, Any]] = []
    defined_name_rows: list[dict[str, Any]] = []
    formula_reference_rows: list[dict[str, Any]] = []
    date_candidate_rows: list[dict[str, Any]] = []
    cell_date_observations: dict[str, DateCandidateObservation] = {}
    fact_rows: list[dict[str, Any]] = []

    def append_date_candidate(
        observation: DateCandidateObservation,
        *,
        source_type: str,
        evidence_id: Optional[str] = None,
        sheet_name: Optional[str] = None,
        cell_ref: Optional[str] = None,
        row_index: Optional[int] = None,
        col_index: Optional[int] = None,
        nearby_label: str = "",
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        candidate_metadata = {
            "ambiguity": observation.ambiguity,
            "role_method": observation.role_method,
            "matched_text": observation.matched_text,
            "label_context": observation.label_context,
            "assertion_status": observation.assertion_status,
            "date_extraction_rules_version": DATE_EXTRACTION_RULES_VERSION,
            **(metadata or {}),
        }
        metadata_identity = str(candidate_metadata.get("property_name") or "")
        if candidate_metadata.get("defined_name"):
            metadata_identity = (
                f"{candidate_metadata.get('scope_sheet') or ''}\0"
                f"{candidate_metadata['defined_name']}"
            )
        identity = "\0".join(
            (
                doc_id,
                "date_candidate",
                source_type,
                sheet_name or "",
                cell_ref or "",
                metadata_identity,
                observation.role,
                observation.normalized_date or "",
                observation.raw_text,
            )
        )
        date_candidate_rows.append(
            {
                "candidate_id": sha256_text(identity)[:40],
                "schema_version": "1.0",
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "normalized_date": observation.normalized_date,
                "raw_text": observation.raw_text,
                "role": observation.role,
                "source_type": source_type,
                "evidence_id": evidence_id,
                "sheet_name": sheet_name,
                "cell_ref": cell_ref,
                "row_index": row_index,
                "col_index": col_index,
                "nearby_label": nearby_label or None,
                "parse_method": observation.parse_method,
                "date_precision": observation.date_precision,
                "is_forecast": 1 if observation.is_forecast else 0,
                "priority_score": observation.priority_score,
                "confidence": observation.confidence,
                "rejection_reason": observation.rejection_reason,
                "metadata_json": dumps_json(candidate_metadata),
            }
        )

    for property_name, role in (
        ("created", "file_created_at"),
        ("modified", "file_modified_at"),
    ):
        property_observation = workbook_property_date_candidate(
            getattr(wb_formula.properties, property_name, None),
            role=role,
        )
        if property_observation:
            append_date_candidate(
                property_observation,
                source_type="workbook_property",
                metadata={"property_name": property_name},
            )
    file_modified_observation = workbook_property_date_candidate(
        datetime.fromtimestamp(path.stat().st_mtime, timezone.utc),
        role="file_modified_at",
    )
    if file_modified_observation:
        append_date_candidate(
            file_modified_observation,
            source_type="file_metadata",
            metadata={"property_name": "filesystem_modified_at"},
        )

    defined_name_lookup: set[str] = set()
    defined_name_target_lookup: dict[tuple[Optional[str], str], tuple[str, str]] = {}
    for defined_name_index, defined_name in enumerate(wb_formula.defined_names.values()):
        name = normalize_text(getattr(defined_name, "name", ""))
        if not name:
            continue
        defined_name_lookup.add(name)
        local_sheet_id = getattr(defined_name, "localSheetId", None)
        scope_sheet = None
        if isinstance(local_sheet_id, int) and 0 <= local_sheet_id < len(wb_formula.sheetnames):
            scope_sheet = wb_formula.sheetnames[local_sheet_id]
        try:
            destinations = list(defined_name.destinations)
        except (AttributeError, TypeError, ValueError):
            destinations = []
        if len(destinations) == 1:
            target_sheet, target_range = destinations[0]
            defined_name_target_lookup[
                (scope_sheet.casefold() if scope_sheet else None, name.casefold())
            ] = (target_sheet, target_range)
        defined_name_rows.append(
            {
                "defined_name_id": sha256_text(
                    f"{doc_id}\0defined_name\0{scope_sheet or ''}\0{name}\0{defined_name_index}"
                )[:40],
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "name": name,
                "scope_sheet": scope_sheet,
                "name_type": normalize_text(getattr(defined_name, "type", "")) or None,
                "attr_text": normalize_text(getattr(defined_name, "attr_text", "")) or None,
                "hidden": 1 if bool(getattr(defined_name, "hidden", False)) else 0,
                "metadata_json": dumps_json(
                    {
                        "attributes": getattr(defined_name, "__dict__", {}),
                        "destinations": destinations,
                    }
                ),
            }
        )

    for sheet_index, ws in enumerate(wb_formula.worksheets, start=1):
        values_ws = wb_values[ws.title] if ws.title in wb_values.sheetnames else None
        cells = _nonempty_cells(ws)
        bounds = _sheet_bounds(cells)
        formula_count = sum(1 for value in cells.values() if _is_formula(value))
        non_empty = len(cells)
        if bounds:
            min_row, min_col, max_row, max_col = bounds
            used_range = _range_ref(min_row, min_col, max_row, max_col)
            row_count = max_row - min_row + 1
            col_count = max_col - min_col + 1
        else:
            min_row = min_col = max_row = max_col = 0
            used_range = ""
            row_count = col_count = 0
        labels = _sample_labels(cells)
        role = _sheet_role(ws.title, " ".join(labels))
        sheet_unit = ""
        for label in labels[:10]:
            sheet_unit = _unit_from_text(label)
            if sheet_unit:
                break
        formula_density = formula_count / max(1, non_empty)
        sheet_summary = (
            f"Excel sheet: {ws.title}\n"
            f"Role: {role}\n"
            f"Used range: {used_range or 'empty'}\n"
            f"Non-empty cells: {non_empty}; formulas: {formula_count}; formula density: {formula_density:.2%}\n"
            f"Key labels: {', '.join(labels[:20])}"
        )
        sheet_id = sha256_text(f"{doc_id}\0sheet\0{ws.title}")[:40]
        sheet_rows.append(
            {
                "sheet_id": sheet_id,
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "sheet_index": sheet_index,
                "sheet_name": ws.title,
                "sheet_role": role,
                "sheet_state": ws.sheet_state,
                "used_range": used_range,
                "row_count": row_count,
                "col_count": col_count,
                "non_empty_cell_count": non_empty,
                "formula_count": formula_count,
                "formula_density": formula_density,
                "summary": sheet_summary,
                "header_json": dumps_json(labels),
                "metadata_json": dumps_json(
                    {
                        "freeze_panes": str(ws.freeze_panes or ""),
                        "merged_ranges": [str(rng) for rng in ws.merged_cells.ranges],
                        "hidden_rows": [index for index, dimension in ws.row_dimensions.items() if dimension.hidden],
                        "hidden_columns": [
                            index for index, dimension in ws.column_dimensions.items() if dimension.hidden
                        ],
                        "table_names": list(ws.tables.keys()),
                    }
                ),
            }
        )

        row_text_cols: dict[int, list[tuple[int, str]]] = {}
        col_text_rows: dict[int, list[tuple[int, str]]] = {}
        col_period_rows: dict[int, list[tuple[int, str]]] = {}
        for (row, col), value in cells.items():
            is_formula, _, _, _ = _formula_details(value)
            cached_for_label = values_ws.cell(row, col).value if is_formula and values_ws is not None else None
            cache_status = _formula_cache_status(is_formula, cached_for_label)
            label_value = cached_for_label if cache_status in {"present", "error"} else None
            text = cell_display(label_value if is_formula else value, 120)
            raw_text = cell_display(value, 120)
            if text and not is_formula and _numeric_value(value) is None:
                row_text_cols.setdefault(row, []).append((col, text))
            if text and _looks_like_period_label(text):
                col_period_rows.setdefault(col, []).append((row, text))
            if text and (_numeric_value(text) is None or _looks_like_period_label(text) or row <= max(5, min_row + 4)):
                col_text_rows.setdefault(col, []).append((row, text))
            elif raw_text and not is_formula and _numeric_value(raw_text) is None:
                col_text_rows.setdefault(col, []).append((row, raw_text))
        for items in row_text_cols.values():
            items.sort(key=lambda x: x[0])
        for items in col_text_rows.values():
            items.sort(key=lambda x: x[0])
        for items in col_period_rows.values():
            items.sort(key=lambda x: x[0])

        for (row, col), value in sorted(cells.items(), key=lambda item: item[0]):
            cached = values_ws.cell(row, col).value if values_ws is not None else None
            is_formula, formula_type, formula, formula_metadata = _formula_details(value)
            cache_status = _formula_cache_status(is_formula, cached)
            display_source = cached if is_formula and cache_status in {"present", "error"} else value
            display = cell_display(display_source, 200)
            row_label = _nearest_left_label(row_text_cols, row, col)
            col_label = _nearest_top_label(col_text_rows, row, col)
            period_label = _nearest_top_label(col_period_rows, row, col)
            period = (
                _period_from_label(period_label)
                or _period_from_label(col_label)
                or _period_from_label(display)
            )
            number_format = str(ws.cell(row, col).number_format or "")
            unit = (
                _unit_from_text(row_label)
                or _unit_from_text(col_label)
                or _unit_from_text(display)
                or _unit_from_number_format(number_format)
                or sheet_unit
            )
            numeric = _numeric_value(cached if is_formula else value)
            cell_ref = _cell_ref(row, col)
            value_type = f"formula_{formula_type}" if is_formula else type(value).__name__
            cell_id = sha256_text(f"{doc_id}\0{ws.title}\0{cell_ref}")[:40]
            date_row_label = ""
            date_row_label_ref: Optional[str] = None
            for nearby_col in range(col - 1, max(0, col - 9), -1):
                nearby_value = cells.get((row, nearby_col))
                if nearby_value is None:
                    continue
                if isinstance(nearby_value, str) and not _is_formula(nearby_value):
                    date_row_label = cell_display(nearby_value, 120)
                    if date_row_label:
                        date_row_label_ref = _cell_ref(row, nearby_col)
                break
            date_col_label = ""
            date_col_label_ref: Optional[str] = None
            for nearby_row in range(row - 1, max(0, row - 6), -1):
                nearby_value = cells.get((nearby_row, col))
                if nearby_value is None:
                    continue
                if isinstance(nearby_value, str) and not _is_formula(nearby_value):
                    date_col_label = cell_display(nearby_value, 120)
                    if date_col_label:
                        date_col_label_ref = _cell_ref(nearby_row, col)
                break
            date_value = cached if is_formula and cache_status == "present" else value
            date_observation = extract_cell_date_candidate(
                date_value,
                row_label=date_row_label,
                col_label=date_col_label,
            )
            if date_observation:
                cell_date_observations[cell_id] = date_observation
                nearby_labels = list(
                    dict.fromkeys(label for label in (date_row_label, date_col_label) if label)
                )
                append_date_candidate(
                    date_observation,
                    source_type="workbook_cell",
                    evidence_id=f"cell:{cell_id}",
                    sheet_name=ws.title,
                    cell_ref=cell_ref,
                    row_index=row,
                    col_index=col,
                    nearby_label=" | ".join(nearby_labels),
                    metadata={
                        "number_format": number_format,
                        "formula_cache_status": cache_status,
                        "workbook_date_epoch": json_safe(getattr(wb_formula, "epoch", None)),
                        "label_cell_refs": [
                            label_ref
                            for label_ref in (date_row_label_ref, date_col_label_ref)
                            if label_ref
                        ],
                    },
                )
            if is_formula and formula:
                for reference in extract_formula_references(
                    formula,
                    source_sheet=ws.title,
                    defined_names=defined_name_lookup,
                ):
                    target_sheet = reference.target_sheet
                    target_range = reference.target_range
                    parse_status = reference.parse_status
                    if reference.reference_kind == "defined_name" and reference.defined_name:
                        defined_name_key = reference.defined_name.casefold()
                        defined_name_target = defined_name_target_lookup.get(
                            (ws.title.casefold(), defined_name_key)
                        ) or defined_name_target_lookup.get((None, defined_name_key))
                        if defined_name_target:
                            target_sheet, target_range = defined_name_target
                            parse_status = "resolved"
                    formula_reference_rows.append(
                        {
                            "reference_id": sha256_text(
                                f"{cell_id}\0{reference.reference_index}\0{reference.raw_reference}"
                            )[:40],
                            "dataset_id": dataset_id,
                            "doc_id": doc_id,
                            "source_cell_id": cell_id,
                            "source_sheet": ws.title,
                            "source_cell_ref": cell_ref,
                            "reference_index": reference.reference_index,
                            "raw_reference": reference.raw_reference,
                            "reference_kind": reference.reference_kind,
                            "target_sheet": target_sheet,
                            "target_range": target_range,
                            "defined_name": reference.defined_name,
                            "external_workbook": reference.external_workbook,
                            "parse_status": parse_status,
                            "metadata_json": dumps_json({}),
                        }
                    )
            cell_rows.append(
                {
                    "cell_id": cell_id,
                    "dataset_id": dataset_id,
                    "doc_id": doc_id,
                    "sheet_name": ws.title,
                    "cell_ref": cell_ref,
                    "row_index": row,
                    "col_index": col,
                    "value_type": value_type,
                    "display_value": display,
                    "raw_value": value if isinstance(value, str) else dumps_json(value),
                    "numeric_value": numeric,
                    "formula": formula,
                    "cached_value": (cached if isinstance(cached, str) else dumps_json(cached)) if is_formula and cached is not None else None,
                    "number_format": number_format,
                    "row_label": row_label,
                    "col_label": col_label,
                    "period": period,
                    "unit": unit,
                    "is_formula": 1 if is_formula else 0,
                    "formula_type": formula_type,
                    "formula_cache_status": cache_status,
                    "metadata_json": dumps_json(
                        {
                            "sheet_role": role,
                            "formula_type": formula_type,
                            "formula_cache_status": cache_status,
                            "formula_metadata": formula_metadata,
                        }
                    ),
                }
            )
            if numeric is not None and row_label:
                fact_id = sha256_text(f"{doc_id}\0{ws.title}\0{cell_ref}\0{row_label}\0{period}")[:40]
                quality_issues = ["metric_name_inferred_from_nearest_left_label"]
                if not period:
                    quality_issues.append("period_missing")
                if not unit:
                    quality_issues.append("unit_missing")
                if is_formula and cache_status != "present":
                    quality_issues.append(f"formula_cache_{cache_status}")
                quality_status = (
                    "candidate_complete"
                    if period and unit and (not is_formula or cache_status == "present")
                    else "review_required"
                )
                confidence = 0.75 if quality_status == "candidate_complete" else (0.65 if period else 0.55)
                fact_rows.append(
                    {
                        "fact_id": fact_id,
                        "dataset_id": dataset_id,
                        "doc_id": doc_id,
                        "metric_name": row_label,
                        "metric_alias": normalize_text(row_label).lower(),
                        "period": period,
                        "value_text": display,
                        "value_numeric": numeric,
                        "unit": unit,
                        "sheet_name": ws.title,
                        "cell_ref": cell_ref,
                        "source_range": f"{ws.title}!{cell_ref}",
                        "formula": formula,
                        "confidence": confidence,
                        "fact_status": "candidate",
                        "quality_status": quality_status,
                        "quality_issues_json": dumps_json(quality_issues),
                        "metadata_json": dumps_json(
                            {
                                "col_label": col_label,
                                "sheet_role": role,
                                "extraction_method": "nearest_left_metric_and_nearest_top_period",
                                "fact_status": "candidate",
                                "quality_status": quality_status,
                                "quality_issues": quality_issues,
                                "formula_type": formula_type,
                                "formula_cache_status": cache_status,
                            }
                        ),
                    }
                )

        for region_index, (r1, c1, r2, c2) in enumerate(_detect_regions(cells), start=1):
            region_values = [
                cells[(row, col)]
                for row in range(r1, r2 + 1)
                for col in range(c1, c2 + 1)
                if (row, col) in cells
            ]
            region_formula_count = sum(1 for value in region_values if _is_formula(value))
            region_range = _range_ref(r1, c1, r2, c2)
            region_type = _region_type(ws.title, region_values, region_formula_count)
            region_labels = _sample_labels({(idx, 1): v for idx, v in enumerate(region_values, start=1)})
            region_summary = (
                f"Excel region: {ws.title}!{region_range}\n"
                f"Sheet role: {role}\n"
                f"Region type: {region_type}\n"
                f"Rows: {r2 - r1 + 1}; columns: {c2 - c1 + 1}; non-empty cells: {len(region_values)}; "
                f"formulas: {region_formula_count}\n"
                f"Key labels: {', '.join(region_labels[:20])}"
            )
            region_id = sha256_text(f"{doc_id}\0region\0{ws.title}\0{region_range}\0{region_index}")[:40]
            region_rows.append(
                {
                    "region_id": region_id,
                    "dataset_id": dataset_id,
                    "doc_id": doc_id,
                    "sheet_name": ws.title,
                    "region_index": region_index,
                    "region_type": region_type,
                    "cell_range": region_range,
                    "row_count": r2 - r1 + 1,
                    "col_count": c2 - c1 + 1,
                    "non_empty_cell_count": len(region_values),
                    "formula_count": region_formula_count,
                    "formula_density": region_formula_count / max(1, len(region_values)),
                    "summary": region_summary,
                    "header_json": dumps_json(region_labels),
                    "metadata_json": dumps_json({"sheet_role": role}),
                }
            )

    cell_rows_by_location = {
        (str(row["sheet_name"]).casefold(), str(row["cell_ref"]).replace("$", "").upper()): row
        for row in cell_rows
    }
    for defined_name_row in defined_name_rows:
        defined_name = str(defined_name_row["name"])
        scope_sheet = defined_name_row["scope_sheet"]
        target = defined_name_target_lookup.get(
            (str(scope_sheet).casefold() if scope_sheet else None, defined_name.casefold())
        )
        if not target:
            continue
        target_sheet, target_range = target
        normalized_target_ref = str(target_range).replace("$", "").upper()
        if not re.fullmatch(r"[A-Z]{1,3}[1-9]\d*", normalized_target_ref):
            continue
        target_cell = cell_rows_by_location.get(
            (str(target_sheet).casefold(), normalized_target_ref)
        )
        if not target_cell:
            continue
        target_value = (
            target_cell["cached_value"]
            if target_cell["formula_cache_status"] == "present"
            else target_cell["raw_value"]
        )
        defined_name_observation = extract_cell_date_candidate(
            target_value,
            row_label=defined_name,
        )
        if not defined_name_observation or defined_name_observation.role == "unknown":
            continue
        cell_observation = cell_date_observations.get(str(target_cell["cell_id"]))
        # A neutral name must not erase a qualification on the same date cell.
        if (
            cell_observation
            and cell_observation.role == defined_name_observation.role
            and cell_observation.assertion_status != "affirmed"
            and defined_name_observation.assertion_status != "negated"
        ):
            defined_name_observation = replace(
                defined_name_observation,
                assertion_status=cell_observation.assertion_status,
                rejection_reason=cell_observation.rejection_reason,
                priority_score=0.0,
                confidence=min(defined_name_observation.confidence, cell_observation.confidence),
                label_context=cell_observation.label_context,
            )
        append_date_candidate(
            defined_name_observation,
            source_type="defined_name",
            evidence_id=f"cell:{target_cell['cell_id']}",
            sheet_name=str(target_cell["sheet_name"]),
            cell_ref=str(target_cell["cell_ref"]),
            row_index=int(target_cell["row_index"]),
            col_index=int(target_cell["col_index"]),
            nearby_label=defined_name,
            metadata={
                "defined_name": defined_name,
                "scope_sheet": scope_sheet,
                "target_range": f"{target_sheet}!{target_range}",
            },
        )

    workbook_type = _workbook_type(sheet_rows)
    total_formulas = sum(int(row["formula_count"]) for row in sheet_rows)
    total_cells = sum(int(row["non_empty_cell_count"]) for row in sheet_rows)
    formula_cache_counts: dict[str, int] = {}
    for row in cell_rows:
        if row["is_formula"]:
            status = str(row["formula_cache_status"])
            formula_cache_counts[status] = formula_cache_counts.get(status, 0) + 1
    formula_reference_status_counts: dict[str, int] = {}
    for row in formula_reference_rows:
        status = str(row["parse_status"])
        formula_reference_status_counts[status] = (
            formula_reference_status_counts.get(status, 0) + 1
        )
    date_candidate_role_counts: dict[str, int] = {}
    for row in date_candidate_rows:
        role = str(row["role"])
        date_candidate_role_counts[role] = date_candidate_role_counts.get(role, 0) + 1
    fact_quality_counts: dict[str, int] = {}
    for row in fact_rows:
        status = str(row["quality_status"])
        fact_quality_counts[status] = fact_quality_counts.get(status, 0) + 1

    conn.execute(
        """
        INSERT INTO excel_workbooks (
            workbook_id, dataset_id, doc_id, workbook_type, sheet_count,
            visible_sheet_count, formula_count, non_empty_cell_count,
            formula_density, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sha256_text(f"{doc_id}\0workbook")[:40],
            dataset_id,
            doc_id,
            workbook_type,
            len(sheet_rows),
            sum(1 for ws in wb_formula.worksheets if ws.sheet_state == "visible"),
            total_formulas,
            total_cells,
            total_formulas / max(1, total_cells),
            dumps_json(
                {
                    "source": "on_demand_workbook",
                    "parser_name": parser_name,
                    "parser_version": parser_version,
                    "formula_cache_status_counts": formula_cache_counts,
                    "formula_reference_count": len(formula_reference_rows),
                    "formula_reference_status_counts": formula_reference_status_counts,
                    "defined_name_count": len(defined_name_rows),
                    "valuation_date_candidate_count": len(date_candidate_rows),
                    "valuation_date_candidate_role_counts": date_candidate_role_counts,
                    "date_epoch": json_safe(getattr(wb_formula, "epoch", None)),
                    "calculation": json_safe(getattr(wb_formula, "calculation", None)),
                    "external_link_count": len(getattr(wb_formula, "_external_links", ())),
                    "fact_status": "candidate",
                    "fact_quality_status_counts": fact_quality_counts,
                }
            ),
        ),
    )
    if sheet_rows:
        conn.executemany(
            """
            INSERT INTO excel_sheets (
                sheet_id, dataset_id, doc_id, sheet_index, sheet_name, sheet_role,
                sheet_state, used_range, row_count, col_count, non_empty_cell_count,
                formula_count, formula_density, summary, header_json, metadata_json
            ) VALUES (
                :sheet_id, :dataset_id, :doc_id, :sheet_index, :sheet_name, :sheet_role,
                :sheet_state, :used_range, :row_count, :col_count, :non_empty_cell_count,
                :formula_count, :formula_density, :summary, :header_json, :metadata_json
            )
            """,
            sheet_rows,
        )
    if region_rows:
        conn.executemany(
            """
            INSERT INTO excel_regions (
                region_id, dataset_id, doc_id, sheet_name, region_index, region_type,
                cell_range, row_count, col_count, non_empty_cell_count, formula_count,
                formula_density, summary, header_json, metadata_json
            ) VALUES (
                :region_id, :dataset_id, :doc_id, :sheet_name, :region_index, :region_type,
                :cell_range, :row_count, :col_count, :non_empty_cell_count, :formula_count,
                :formula_density, :summary, :header_json, :metadata_json
            )
            """,
            region_rows,
        )
    if cell_rows:
        conn.executemany(
            """
            INSERT INTO excel_cells (
                cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
                value_type, display_value, raw_value, numeric_value, formula, cached_value,
                number_format, row_label, col_label, period, unit, is_formula,
                formula_type, formula_cache_status, metadata_json
            ) VALUES (
                :cell_id, :dataset_id, :doc_id, :sheet_name, :cell_ref, :row_index, :col_index,
                :value_type, :display_value, :raw_value, :numeric_value, :formula, :cached_value,
                :number_format, :row_label, :col_label, :period, :unit, :is_formula,
                :formula_type, :formula_cache_status, :metadata_json
            )
            """,
            cell_rows,
        )
    if defined_name_rows:
        conn.executemany(
            """
            INSERT INTO excel_defined_names (
                defined_name_id, dataset_id, doc_id, name, scope_sheet,
                name_type, attr_text, hidden, metadata_json
            ) VALUES (
                :defined_name_id, :dataset_id, :doc_id, :name, :scope_sheet,
                :name_type, :attr_text, :hidden, :metadata_json
            )
            """,
            defined_name_rows,
        )
    if formula_reference_rows:
        conn.executemany(
            """
            INSERT INTO excel_formula_references (
                reference_id, dataset_id, doc_id, source_cell_id, source_sheet,
                source_cell_ref, reference_index, raw_reference, reference_kind,
                target_sheet, target_range, defined_name, external_workbook,
                parse_status, metadata_json
            ) VALUES (
                :reference_id, :dataset_id, :doc_id, :source_cell_id, :source_sheet,
                :source_cell_ref, :reference_index, :raw_reference, :reference_kind,
                :target_sheet, :target_range, :defined_name, :external_workbook,
                :parse_status, :metadata_json
            )
            """,
            formula_reference_rows,
        )
    if date_candidate_rows:
        conn.executemany(
            """
            INSERT INTO valuation_date_candidates (
                candidate_id, schema_version, dataset_id, doc_id, normalized_date, raw_text,
                role, source_type, evidence_id, sheet_name, cell_ref,
                row_index, col_index, nearby_label, parse_method, date_precision,
                is_forecast, priority_score, confidence, rejection_reason, metadata_json
            ) VALUES (
                :candidate_id, :schema_version, :dataset_id, :doc_id, :normalized_date, :raw_text,
                :role, :source_type, :evidence_id, :sheet_name, :cell_ref,
                :row_index, :col_index, :nearby_label, :parse_method, :date_precision,
                :is_forecast, :priority_score, :confidence, :rejection_reason, :metadata_json
            )
            """,
            date_candidate_rows,
        )
    if fact_rows:
        conn.executemany(
            """
            INSERT INTO metric_facts (
                fact_id, dataset_id, doc_id, metric_name, metric_alias, period,
                value_text, value_numeric, unit, sheet_name, cell_ref, source_range,
                formula, confidence, fact_status, quality_status, quality_issues_json,
                metadata_json
            ) VALUES (
                :fact_id, :dataset_id, :doc_id, :metric_name, :metric_alias, :period,
                :value_text, :value_numeric, :unit, :sheet_name, :cell_ref, :source_range,
                :formula, :confidence, :fact_status, :quality_status, :quality_issues_json,
                :metadata_json
            )
            """,
            fact_rows,
        )

    wb_formula.close()
    wb_values.close()
    return {
        "parser_name": parser_name,
        "parser_version": parser_version,
        "sheet_count": len(sheet_rows),
        "cell_count": len(cell_rows),
        "formula_count": total_formulas,
    }
