#!/usr/bin/env python3
"""Apply approved literal-cell changes and inspect a recalculated workbook."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_from_string


CELL_RE = re.compile(r"^[A-Z]{1,3}[1-9][0-9]{0,6}$")


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("Model update plan must be a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def workbook_options(path: Path, *, data_only: bool, read_only: bool) -> dict[str, Any]:
    return {
        "data_only": data_only,
        "keep_links": True,
        "keep_vba": path.suffix.lower() == ".xlsm",
        "read_only": read_only,
    }


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def same_value(left: Any, right: Any) -> bool:
    if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
        return math.isclose(float(left), float(right), rel_tol=1e-12, abs_tol=1e-12)
    return left == right


def validate_cell_ref(cell_ref: str) -> str:
    normalized = cell_ref.strip().upper().replace("$", "")
    if not CELL_RE.fullmatch(normalized):
        raise ValueError(f"Invalid A1 cell reference: {cell_ref}")
    coordinate_from_string(normalized)
    return normalized


def formula_token(value: Any) -> str:
    if isinstance(value, str):
        return value
    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        return f"{type(value).__name__}:{json.dumps(attributes, sort_keys=True, separators=(',', ':'))}"
    return f"{type(value).__name__}:{value!s}"


def formula_fingerprint(workbook: Any) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                if cell.data_type != "f":
                    continue
                count += 1
                digest.update(
                    f"{worksheet.title}\0{cell.coordinate}\0{formula_token(cell.value)}\n".encode("utf-8")
                )
    return digest.hexdigest(), count


def formula_map(workbook: Any) -> dict[str, str]:
    formulas: dict[str, str] = {}
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    formulas[f"{worksheet.title}!{cell.coordinate}"] = formula_token(cell.value)
    return formulas


def error_cells(workbook: Any) -> list[str]:
    errors: list[str] = []
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                value = cell.value
                if cell.data_type == "e" or (isinstance(value, str) and value.startswith("#")):
                    errors.append(f"{worksheet.title}!{cell.coordinate}:{value}")
    return sorted(errors)


def apply_changes(source: Path, plan_path: Path, destination: Path, result_path: Path) -> None:
    if source.suffix.lower() != ".xlsx" or destination.suffix.lower() != ".xlsx":
        raise ValueError("Controlled model updates currently support .xlsx workbooks only")
    plan = load_json(plan_path)
    changes = plan.get("changes")
    if not isinstance(changes, list) or not changes:
        raise ValueError("Model update plan must contain changes")
    destination.parent.mkdir(parents=True, exist_ok=True)
    workbook = load_workbook(source, **workbook_options(source, data_only=False, read_only=False))
    try:
        before_fingerprint, formula_count = formula_fingerprint(workbook)
        seen: set[tuple[str, str]] = set()
        applied: list[dict[str, Any]] = []
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError("Model update change must be an object")
            sheet_name = str(change.get("sheet", ""))
            cell_ref = validate_cell_ref(str(change.get("cell", "")))
            key = (sheet_name, cell_ref)
            if key in seen:
                raise ValueError(f"Duplicate model update cell: {sheet_name}!{cell_ref}")
            seen.add(key)
            if sheet_name not in workbook.sheetnames:
                raise ValueError(f"Worksheet not found: {sheet_name}")
            cell = workbook[sheet_name][cell_ref]
            if cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("=")):
                raise ValueError(f"Refusing to overwrite formula cell {sheet_name}!{cell_ref}")
            expected = change.get("expected_value")
            before = json_value(cell.value)
            if not same_value(before, expected):
                raise ValueError(
                    f"Expected value mismatch at {sheet_name}!{cell_ref}: expected {expected!r}, found {before!r}"
                )
            new_value = change.get("new_value")
            if not (new_value is None or isinstance(new_value, (str, int, float, bool))):
                raise ValueError(f"Unsupported value at {sheet_name}!{cell_ref}")
            cell.value = new_value
            applied.append(
                {
                    "sheet": sheet_name,
                    "cell": cell_ref,
                    "before": before,
                    "after": new_value,
                    "kind": str(change.get("kind", "")),
                    "metric_id": change.get("metric_id"),
                    "evidence_ids": change.get("evidence_ids", []),
                    "reason": str(change.get("reason", "")),
                }
            )
        after_fingerprint, after_formula_count = formula_fingerprint(workbook)
        if before_fingerprint != after_fingerprint or formula_count != after_formula_count:
            raise ValueError("Formula cells changed while applying literal input updates")
        workbook.calculation.fullCalcOnLoad = True
        workbook.calculation.forceFullCalc = True
        workbook.calculation.calcMode = "auto"
        workbook.save(destination)
        write_json(
            result_path,
            {
                "applied_changes": applied,
                "formula_fingerprint": before_fingerprint,
                "formula_cell_count": formula_count,
                "source_error_cells": error_cells(workbook),
                "sheet_names": workbook.sheetnames,
            },
        )
    finally:
        workbook.close()


def inspect_workbooks(source: Path, updated: Path, plan_path: Path, result_path: Path) -> None:
    plan = load_json(plan_path)
    outputs = plan.get("outputs", [])
    checks = plan.get("checks", [])
    if not isinstance(outputs, list) or not isinstance(checks, list):
        raise ValueError("Outputs and checks must be arrays")
    source_formulas = load_workbook(source, **workbook_options(source, data_only=False, read_only=True))
    source_values = load_workbook(source, **workbook_options(source, data_only=True, read_only=True))
    updated_formulas = load_workbook(updated, **workbook_options(updated, data_only=False, read_only=True))
    updated_values = load_workbook(updated, **workbook_options(updated, data_only=True, read_only=True))
    try:
        source_errors = error_cells(source_values)
        updated_errors = error_cells(updated_values)
        observed_outputs: dict[str, Any] = {}
        for output in outputs:
            if not isinstance(output, dict):
                raise ValueError("Output observation must be an object")
            sheet_name = str(output.get("sheet", ""))
            cell_ref = validate_cell_ref(str(output.get("cell", "")))
            key = str(output.get("key", ""))
            if not key:
                raise ValueError("Output observation requires a key")
            if sheet_name not in updated_values.sheetnames:
                raise ValueError(f"Worksheet not found: {sheet_name}")
            observed_outputs[key] = json_value(updated_values[sheet_name][cell_ref].value)
        check_results: list[dict[str, Any]] = []
        for check in checks:
            if not isinstance(check, dict):
                raise ValueError("Validation check must be an object")
            sheet_name = str(check.get("sheet", ""))
            cell_ref = validate_cell_ref(str(check.get("cell", "")))
            key = str(check.get("key", ""))
            expected = check.get("expected_value")
            tolerance = float(check.get("tolerance", 0))
            actual = json_value(updated_values[sheet_name][cell_ref].value)
            if isinstance(actual, (int, float)) and not isinstance(actual, bool) and isinstance(expected, (int, float)) and not isinstance(expected, bool):
                passed = abs(float(actual) - float(expected)) <= tolerance
            else:
                passed = actual == expected
            check_results.append(
                {
                    "key": key,
                    "sheet": sheet_name,
                    "cell": cell_ref,
                    "actual": actual,
                    "expected": expected,
                    "tolerance": tolerance,
                    "passed": passed,
                }
            )
        source_fingerprint, source_formula_count = formula_fingerprint(source_formulas)
        fingerprint, formula_count = formula_fingerprint(updated_formulas)
        source_formula_map = formula_map(source_formulas)
        updated_formula_map = formula_map(updated_formulas)
        formula_changes = sorted(
            cell_ref
            for cell_ref in set(source_formula_map) | set(updated_formula_map)
            if source_formula_map.get(cell_ref) != updated_formula_map.get(cell_ref)
        )
        write_json(
            result_path,
            {
                "outputs": observed_outputs,
                "checks": check_results,
                "source_error_cells": source_errors,
                "updated_error_cells": updated_errors,
                "new_error_cells": sorted(set(updated_errors) - set(source_errors)),
                "source_formula_fingerprint": source_fingerprint,
                "source_formula_cell_count": source_formula_count,
                "formula_fingerprint": fingerprint,
                "formula_cell_count": formula_count,
                "formula_changed_cells": formula_changes,
                "sheet_names": updated_formulas.sheetnames,
            },
        )
    finally:
        source_formulas.close()
        source_values.close()
        updated_formulas.close()
        updated_values.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("--input", required=True, type=Path)
    apply_parser.add_argument("--plan", required=True, type=Path)
    apply_parser.add_argument("--output", required=True, type=Path)
    apply_parser.add_argument("--result", required=True, type=Path)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--source", required=True, type=Path)
    inspect_parser.add_argument("--updated", required=True, type=Path)
    inspect_parser.add_argument("--plan", required=True, type=Path)
    inspect_parser.add_argument("--result", required=True, type=Path)

    args = parser.parse_args()
    if args.command == "apply":
        apply_changes(args.input, args.plan, args.output, args.result)
    else:
        inspect_workbooks(args.source, args.updated, args.plan, args.result)


if __name__ == "__main__":
    main()
