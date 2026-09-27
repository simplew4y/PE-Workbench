from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Optional

from openpyxl.formula import Tokenizer
from openpyxl.formula.tokenizer import TokenizerError


CELL_OR_RANGE_PATTERN = re.compile(
    r"^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$",
    flags=re.IGNORECASE,
)
WHOLE_COLUMN_PATTERN = re.compile(
    r"^\$?[A-Z]{1,3}:\$?[A-Z]{1,3}$",
    flags=re.IGNORECASE,
)
WHOLE_ROW_PATTERN = re.compile(r"^\$?\d+:\$?\d+$")
EXTERNAL_SHEET_PATTERN = re.compile(r"^\[([^\]]+)\](.*)$")


@dataclass(frozen=True)
class FormulaReference:
    reference_index: int
    raw_reference: str
    reference_kind: str
    target_sheet: Optional[str] = None
    target_range: Optional[str] = None
    defined_name: Optional[str] = None
    external_workbook: Optional[str] = None
    parse_status: str = "resolved"


def _unquote_sheet_name(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def _range_reference(
    raw_reference: str,
    reference_index: int,
    source_sheet: str,
    defined_names: set[str],
) -> FormulaReference:
    target_sheet = source_sheet
    target_range = raw_reference
    external_workbook: Optional[str] = None

    if "!" in raw_reference:
        sheet_part, target_range = raw_reference.rsplit("!", 1)
        sheet_part = _unquote_sheet_name(sheet_part)
        external_match = EXTERNAL_SHEET_PATTERN.match(sheet_part)
        if external_match:
            external_workbook = external_match.group(1)
            target_sheet = external_match.group(2)
        else:
            target_sheet = sheet_part
        if ":" in target_sheet:
            return FormulaReference(
                reference_index=reference_index,
                raw_reference=raw_reference,
                reference_kind="three_dimensional_reference",
                target_sheet=target_sheet,
                target_range=target_range,
                external_workbook=external_workbook,
                parse_status="unsupported",
            )

    if target_range.upper() == "#REF!":
        return FormulaReference(
            reference_index=reference_index,
            raw_reference=raw_reference,
            reference_kind="error_reference",
            target_sheet=target_sheet,
            target_range=target_range,
            external_workbook=external_workbook,
            parse_status="error",
        )

    if CELL_OR_RANGE_PATTERN.fullmatch(target_range):
        reference_kind = "range" if ":" in target_range else "cell"
        if external_workbook:
            reference_kind = f"external_{reference_kind}"
        return FormulaReference(
            reference_index=reference_index,
            raw_reference=raw_reference,
            reference_kind=reference_kind,
            target_sheet=target_sheet,
            target_range=target_range,
            external_workbook=external_workbook,
            parse_status="external" if external_workbook else "resolved",
        )

    if WHOLE_COLUMN_PATTERN.fullmatch(target_range) or WHOLE_ROW_PATTERN.fullmatch(target_range):
        return FormulaReference(
            reference_index=reference_index,
            raw_reference=raw_reference,
            reference_kind="whole_range",
            target_sheet=target_sheet,
            target_range=target_range,
            external_workbook=external_workbook,
            parse_status="external" if external_workbook else "resolved",
        )

    if "[" in target_range and "]" in target_range:
        return FormulaReference(
            reference_index=reference_index,
            raw_reference=raw_reference,
            reference_kind="structured_reference",
            target_sheet=target_sheet,
            target_range=target_range,
            external_workbook=external_workbook,
            parse_status="deferred",
        )

    if raw_reference.casefold() in defined_names:
        return FormulaReference(
            reference_index=reference_index,
            raw_reference=raw_reference,
            reference_kind="defined_name",
            defined_name=raw_reference,
            parse_status="deferred",
        )

    return FormulaReference(
        reference_index=reference_index,
        raw_reference=raw_reference,
        reference_kind="unresolved_name",
        defined_name=raw_reference,
        parse_status="unresolved",
    )


def extract_formula_references(
    formula: str,
    *,
    source_sheet: str,
    defined_names: Iterable[str] = (),
) -> list[FormulaReference]:
    normalized_names = {name.casefold() for name in defined_names}
    try:
        tokens = Tokenizer(formula).items
    except (IndexError, TokenizerError, TypeError, ValueError):
        return [
            FormulaReference(
                reference_index=0,
                raw_reference=formula,
                reference_kind="parse_error",
                parse_status="error",
            )
        ]

    references: list[FormulaReference] = []
    for token in tokens:
        if token.type == "OPERAND" and token.subtype == "ERROR":
            references.append(
                FormulaReference(
                    reference_index=len(references),
                    raw_reference=token.value,
                    reference_kind="error_reference" if token.value.upper() == "#REF!" else "formula_error",
                    parse_status="error",
                )
            )
            continue
        if token.type != "OPERAND" or token.subtype != "RANGE":
            continue
        raw_reference = token.value.strip()
        if not raw_reference:
            continue
        references.append(
            _range_reference(
                raw_reference,
                len(references),
                source_sheet,
                normalized_names,
            )
        )
    return references
