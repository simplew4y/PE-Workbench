"""Synthetic evidence for issue #1; never evaluates an agent or recalculates user files."""
import argparse
from decimal import Decimal
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from workbook_reader import inspect_workbook, read_workbook

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def scenario(growth):
    """Exact oracle for this fixture's two-year chain, not a workbook engine."""
    growth = Decimal(str(growth))
    values = {}
    opening = Decimal(100)
    for col, cost in (("B", Decimal(60)), ("C", Decimal(66))):
        revenue = opening * (1 + growth)
        profit = (revenue - cost) * Decimal("0.75")
        rows = {
            2: growth, 3: opening, 4: revenue, 5: cost,
            6: (revenue - cost) / revenue, 7: Decimal("0.25"), 8: profit,
            9: Decimal(10), 10: profit / 10, 11: Decimal(20), 12: profit * 2,
            13: revenue / opening - 1, 14: Decimal(5), 15: Decimal(6),
            16: Decimal(2), 17: profit + 5 - 6 - 2,
        }
        values.update({f"{col}{row}": float(value) for row, value in rows.items()})
        opening = revenue
    return values


def write_model(path, growth):
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite {path}")
    values = scenario(growth)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Model"
    sheet.append(["Synthetic model: CNY million; shares million; price CNY/share", "2026E", "2027E"])
    labels = ["Growth input", "Opening revenue", "Revenue", "Cost input", "Derived gross margin",
              "Tax input", "Net profit", "Shares", "EPS", "PE input", "Target price",
              "Derived revenue growth", "Depreciation", "Capex", "Working capital increase", "FCF"]
    for row, label in enumerate(labels, 2):
        sheet.cell(row, 1, label)
    for cell, value in values.items():
        sheet[cell] = value
    formulas = {}
    for col in ("B", "C"):
        for row, formula in {
            4: f"={col}3*(1+{col}2)", 6: f"=({col}4-{col}5)/{col}4",
            8: f"=({col}4-{col}5)*(1-{col}7)", 10: f"={col}8/{col}9",
            12: f"={col}10*{col}11", 13: f"={col}4/{col}3-1",
            17: f"={col}8+{col}14-{col}15-{col}16",
        }.items():
            formulas[f"{col}{row}"] = formula
    formulas.update(C2="=B2", C3="=B4", C7="=B7", C9="=B9", C11="=B11")
    for cell, formula in formulas.items():
        sheet[cell] = formula
    memory = BytesIO()
    workbook.save(memory)
    workbook.close()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Supply known saved values because openpyxl does not calculate formulas.
    with ZipFile(memory) as source, ZipFile(path, "w", ZIP_DEFLATED) as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                for cell in root.iter(f"{NS}c"):
                    if cell.find(f"{NS}f") is not None:
                        cell.find(f"{NS}v").text = str(values[cell.attrib["r"]])
                data = ET.tostring(root, encoding="utf-8")
            target.writestr(item, data)


def check_model(path, growth):
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    response = read_workbook(path, {"action": "read", "sheet": "Model", "range": "A1:C17", "limit": 100},
                             navigation=inspect_workbook(path))
    assert response["complete"]
    cells = {cell["cell_ref"]: cell for cell in response["cells"]}
    for address, expected in scenario(growth).items():
        assert abs(cells[address]["numeric_value"] - expected) < 1e-9, address
    for address, formula in {"C2": "=B2", "C3": "=B4", "B6": "=(B4-B5)/B4", "B13": "=B4/B3-1"}.items():
        assert cells[address]["formula"] == formula, address
    assert not cells["B2"]["is_formula"] and not cells["B5"]["is_formula"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    return {"path": str(path), "sha256": before, "read_only": True, "cells_checked": len(scenario(growth))}


def generate(directory):
    results = []
    for version, growth in (("v1", "0.10"), ("v2", "0.12")):
        path = directory / version / "model.xlsx"
        write_model(path, growth)
        results.append(check_model(path, growth))
    assert results[0]["sha256"] != results[1]["sha256"]
    baseline, perturbed = scenario("0.10"), scenario("0.11")
    assert baseline["B12"] == 75 and baseline["C12"] == 82.5
    assert perturbed["B12"] == 76.5 and perturbed["C12"] == 85.815
    assert scenario("0.12")["C12"] == 89.16
    return {"source_checks": results,
            "one_percentage_point_input_change": {cell: perturbed[cell] for cell in ("B4", "C4", "B12", "C12")},
            "agent_evaluation": "NOT RUN: source checks do not certify skill behavior"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New fixture directory outside the repository")
    args = parser.parse_args()
    if args.output:
        print(json.dumps(generate(args.output.resolve()), ensure_ascii=False, indent=2))
    else:
        with tempfile.TemporaryDirectory(prefix="pe-shared-rules-") as temporary:
            print(json.dumps(generate(Path(temporary)), ensure_ascii=False, indent=2))
