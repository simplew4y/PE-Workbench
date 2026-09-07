"""Infer financial units from supported formula relationships, without evaluating values."""
from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass, field
from typing import Any

from openpyxl.formula import Tokenizer
from openpyxl.utils.cell import range_boundaries, get_column_letter


@dataclass(frozen=True)
class Unit:
    money: int = 0
    shares: int = 0
    currency: str = ""
    scale: int | None = 0


def parse_unit(text: str) -> Unit | None:
    currency = re.fullmatch(r"(EUR|USD|CNY|RMB|HKD|GBP|JPY)(m|bn|_100m|/share)?", text)
    if currency:
        suffix = currency[2] or ""
        return Unit(1, -1 if suffix == "/share" else 0, currency[1], {"m": 6, "bn": 9, "_100m": 8}.get(suffix, 0))
    if text == "per_share":
        return Unit(1, -1)
    if text in {"shares", "shares_m", "share_count_unspecified_scale"}:
        return Unit(0, 1, scale={"shares": 0, "shares_m": 6}.get(text))
    if text in {"%", "x", "multiple", "times"}:
        return Unit()
    return None


def unit_text(unit: Unit) -> str:
    if (unit.money, unit.shares) == (0, 1):
        return {0: "shares", 6: "shares_m"}.get(unit.scale, "share_count_unspecified_scale")
    if (unit.money, unit.shares) == (1, -1):
        return unit.currency + "/share" if unit.currency and unit.scale == 0 else "per_share"
    if (unit.money, unit.shares) == (1, 0) and unit.currency:
        suffix = {0: "", 6: "m", 8: "_100m", 9: "bn"}.get(unit.scale)
        return unit.currency + suffix if suffix is not None else ""
    return ""


def merge(left: Unit, right: Unit) -> Unit:
    if (left.money, left.shares) != (right.money, right.shares):
        raise ValueError("incompatible_dimensions")
    if left.money and left.currency and right.currency and left.currency != right.currency:
        raise ValueError("conflicting_currencies")
    if left.scale is not None and right.scale is not None and left.scale != right.scale:
        raise ValueError("conflicting_unit_scales")
    return Unit(left.money, left.shares, left.currency or right.currency,
                left.scale if left.scale is not None else right.scale)


def product(left: Unit, right: Unit, divide: bool = False) -> Unit:
    if left.money and right.money and left.currency and right.currency and left.currency != right.currency:
        raise ValueError("currency_conversion_requires_explicit_units")
    sign = -1 if divide else 1
    money = left.money + sign * right.money
    return Unit(money, left.shares + sign * right.shares,
                (left.currency or right.currency) if money else "",
                left.scale + sign * right.scale if left.scale is not None and right.scale is not None else None)


@dataclass(eq=False)
class Node:
    unit: Unit | None = None
    blocked: bool = False
    zero: bool = False
    literal: bool = False
    cell: dict[str, Any] | None = None
    reason: str = ""
    evidence: list[dict[str, str]] = field(default_factory=list)


def infer_formula_units(cells: list[dict[str, Any]], references: list[dict[str, Any]],
                        facts: list[dict[str, Any]]) -> None:
    """Unify units across references, sums, scalar products and per-share bridges.

    A labelled per-share output constrains the denominator's share scale when
    the numerator's monetary scale is known. No value matching, company names,
    file names, or assumed workbook-wide currency participates in inference.
    """
    nodes: dict[tuple[str, str], Node] = {}
    by_id: dict[str, Node] = {}
    contexts: dict[str, dict[str, Any]] = {}
    for cell in cells:
        metadata = json.loads(cell["metadata_json"])
        context = metadata["unit_context"]
        contexts[cell["cell_id"]] = context
        unit = parse_unit(cell["unit"])
        node = Node(unit, context["status"] == "ambiguous" or bool(cell["unit"] and unit is None), cell=cell)
        if cell["formula_cache_status"] == "error":
            node.blocked = True
        nodes[(cell["sheet_name"].casefold(), cell["cell_ref"].upper())] = node
        by_id[cell["cell_id"]] = node
    refs: dict[str, dict[str, dict[str, Any]]] = {}
    for ref in references:
        refs.setdefault(ref["source_cell_id"], {})[ref["raw_reference"].replace("$", "").casefold()] = ref
    # Each constraint names its source formula for auditable cross-sheet evidence.
    constraints: list[tuple[str, Node, list[Node], dict[str, Any]]] = []

    def reference(cell: dict[str, Any], token: str) -> list[Node]:
        ref = refs.get(cell["cell_id"], {}).get(token.replace("$", "").casefold())
        if not ref or ref["parse_status"] != "resolved" or ref["external_workbook"]:
            raise ValueError("unsupported_reference")
        if not re.fullmatch(r"\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?", ref["target_range"] or "", re.IGNORECASE):
            raise ValueError("unbounded_reference")
        c1, r1, c2, r2 = range_boundaries(ref["target_range"])
        if (c2 - c1 + 1) * (r2 - r1 + 1) > 2048:
            raise ValueError("range_limit")
        return [nodes.get((ref["target_sheet"].casefold(), f"{get_column_letter(col)}{row}"), Node(Unit(), zero=True))
                for row in range(r1, r2 + 1) for col in range(c1, c2 + 1)]

    def build(tree: ast.AST, operands: dict[str, list[Node]], owner: dict[str, Any]) -> Node:
        if isinstance(tree, ast.Name):
            items = operands[tree.id]
            if len(items) != 1:
                raise ValueError("range_outside_aggregate")
            return items[0]
        if isinstance(tree, ast.Constant) and isinstance(tree.value, (int, float)):
            return Node(Unit(), zero=tree.value == 0, literal=True)
        if isinstance(tree, ast.UnaryOp) and isinstance(tree.op, (ast.UAdd, ast.USub)):
            return build(tree.operand, operands, owner)
        if isinstance(tree, ast.BinOp) and isinstance(tree.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            inputs = [build(tree.left, operands, owner), build(tree.right, operands, owner)]
            operation = "equal" if isinstance(tree.op, (ast.Add, ast.Sub)) else "divide" if isinstance(tree.op, ast.Div) else "multiply"
        elif isinstance(tree, ast.Call) and isinstance(tree.func, ast.Name):
            name = tree.func.id.upper()
            if name in {"ROUND", "ROUNDUP", "ROUNDDOWN", "ABS"} and tree.args:
                return build(tree.args[0], operands, owner)
            if name not in {"SUM", "AVERAGE", "MEDIAN", "MIN", "MAX"}:
                raise ValueError("unsupported_function")
            inputs = []
            for arg in tree.args:
                inputs.extend(operands[arg.id] if isinstance(arg, ast.Name) else [build(arg, operands, owner)])
            operation = "equal"
        else:
            raise ValueError("unsupported_expression")
        if operation == "equal":
            inputs = [node for node in inputs if not node.zero and not node.literal]
        node = Node()
        constraints.append((operation, node, inputs, owner))
        return node

    for cell in cells:
        if not cell["is_formula"] or cell["formula_type"] != "standard" or by_id[cell["cell_id"]].blocked:
            continue
        start = len(constraints)
        try:
            operands: dict[str, list[Node]] = {}
            parts: list[str] = []
            for token in Tokenizer(cell["formula"]).items:
                if token.type == "OPERAND" and token.subtype == "RANGE":
                    key = f"r{len(operands)}"
                    operands[key] = reference(cell, token.value)
                    parts.append(key)
                elif token.type == "OPERATOR-POSTFIX" and token.value == "%":
                    parts.append("/100")
                else:
                    parts.append(token.value)
            tree = ast.parse("".join(parts).strip(), mode="eval")
            expression = build(tree.body, operands, cell)
            # An unlabelled constant formula supplies no monetary evidence.
            if not operands:
                del constraints[start:]
                continue
            constraints.append(("equal", by_id[cell["cell_id"]], [expression], cell))
        except (ValueError, SyntaxError, KeyError, TypeError, RecursionError):
            del constraints[start:]

    def assign(node: Node, unit: Unit, owner: dict[str, Any]) -> bool:
        if node.blocked:
            return False
        combined = merge(node.unit, unit) if node.unit else unit
        if node.unit == combined:
            return False
        node.unit = combined
        node.evidence.append({"sheet_name": owner["sheet_name"], "cell_ref": owner["cell_ref"], "text": owner["formula"]})
        return True

    # Bounded, monotone propagation also handles chains whose sheets appear in
    # reverse order. Unanchored cycles never create a currency or share scale.
    disabled: set[int] = set()
    for _ in range(32):
        changed = False
        for index, (operation, output, inputs, owner) in enumerate(constraints):
            if output.blocked or index in disabled:
                continue
            try:
                if any(node.blocked for node in inputs):
                    if any(node.reason == "conflicting_currencies" for node in inputs):
                        raise ValueError("conflicting_currencies")
                    disabled.add(index)
                    continue
                if operation == "equal":
                    units = [node.unit for node in [output, *inputs] if node.unit is not None]
                    if not units:
                        continue
                    unit = units[0]
                    for other in units[1:]:
                        unit = merge(unit, other)
                    for node in [output, *inputs]:
                        changed = assign(node, unit, owner) or changed
                elif len(inputs) == 2:
                    left, right = inputs
                    divide = operation == "divide"
                    proposed = output.unit
                    if left.unit and right.unit:
                        derived = product(left.unit, right.unit, divide)
                        proposed = merge(proposed, derived) if proposed else derived
                    proposals = [(output, proposed)] if proposed else []
                    if proposed and right.unit:
                        proposals.append((left, product(proposed, right.unit, not divide)))
                    if proposed and left.unit:
                        proposals.append((right, product(left.unit, proposed, True) if divide else product(proposed, left.unit, True)))
                    for node, unit in proposals:
                        if node.unit:
                            merge(node.unit, unit)
                    for node, unit in proposals:
                        changed = assign(node, unit, owner) or changed
            except ValueError as error:
                # An unsupported dimensional operation is not proof that the
                # source's own label is wrong (e.g. explicit scale conversion).
                # Retain local evidence and stop this inference path.
                disabled.add(index)
                if str(error) == "conflicting_currencies":
                    output.blocked = True
                    output.reason = str(error)
                    output.evidence.append({"sheet_name": owner["sheet_name"], "cell_ref": owner["cell_ref"], "text": owner["formula"]})
                    changed = True
        if not changed:
            break

    for node in by_id.values():
        if not node.evidence or node.cell is None:
            continue
        cell = node.cell
        local = contexts[cell["cell_id"]]
        inferred = unit_text(node.unit) if node.unit else ""
        if not node.blocked and (not inferred or inferred == cell["unit"]):
            continue
        sources = [{"sheet_name": cell["sheet_name"], **source} for source in local["sources"]]
        sources.extend(node.evidence)
        sources = list({(s["sheet_name"], s["cell_ref"], s["text"]): s for s in sources}.values())
        context = {"status": "ambiguous" if node.blocked else "inferred", "method": "formula_lineage", "sources": sources}
        if node.blocked:
            context["reason"] = node.reason
        cell["unit"] = "" if node.blocked else inferred
        metadata = json.loads(cell["metadata_json"])
        metadata["unit_context"] = context
        metadata["local_unit_context"] = local
        cell["metadata_json"] = json.dumps(metadata, ensure_ascii=False, sort_keys=True)

    locations = {(cell["sheet_name"], cell["cell_ref"]): cell for cell in cells}
    for fact in facts:
        cell = locations[(fact["sheet_name"], fact["cell_ref"])]
        context = json.loads(cell["metadata_json"])["unit_context"]
        if context["method"] != "formula_lineage":
            continue
        issues = [issue for issue in json.loads(fact["quality_issues_json"])
                  if issue not in {"unit_missing", "unit_ambiguous", "share_count_scale_not_explicit"}]
        if not cell["unit"]:
            issues.append("unit_missing")
        if context["status"] == "ambiguous":
            issues.append("unit_ambiguous")
        if cell["unit"] == "share_count_unspecified_scale":
            issues.append("share_count_scale_not_explicit")
        complete = (bool(fact["period"] and cell["unit"]) and context["status"] == "inferred"
                    and not any(issue in issues for issue in ("formula_cache_missing", "formula_cache_error", "formula_cache_unavailable")))
        status = "candidate_complete" if complete else "review_required"
        fact.update(unit=cell["unit"], quality_status=status, confidence=0.75 if complete else 0.65 if fact["period"] else 0.55,
                    quality_issues_json=json.dumps(issues, ensure_ascii=False))
        metadata = json.loads(fact["metadata_json"])
        metadata.update(unit_context=context, quality_status=status, quality_issues=issues)
        fact["metadata_json"] = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
