"""Check this fixture's source anchors, not the quality of an agent's prose."""
import argparse
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from workbook_reader import inspect_workbook, read_workbook


def check(path):
    navigation = inspect_workbook(path)
    # Read only anchors used in the five questions, retaining formulas and saved values.
    ranges = {
        "Quarterly sales": ["A2", "HS18:HS19", "HZ18", "IB18", "IC18:IC21", "IK18:IK21", "IL21", "IN21", "IP21", "IR18:IR21", "IK42:IK45", "IR42:IR46", "IK1", "HS1"],
        "H1H2": ["A2", "FE10", "FE16", "FI16", "FM5", "FM10:FM16", "FN16", "FM29", "FN29", "FM74", "FN74"],
        "Consolidated": ["A3", "AU6", "AU22", "AU74"],
        "Multiples": ["J2:J3", "P38:Q38", "Q74", "V60", "W6:X13"],
    }
    cells = {}
    for sheet, areas in ranges.items():
        response = read_workbook(path, {"action": "read", "ranges": [{"sheet": sheet, "range": area} for area in areas], "limit": 500}, navigation=navigation)
        assert response["complete"], f"Incomplete evidence read: {sheet}"
        cells.update({(sheet, cell["cell_ref"]): cell for cell in response["cells"]})

    formulas = {
        ("Consolidated", "AU6"): "='Quarterly sales'!IR6",
        ("Quarterly sales", "IK18"): "=IB18*(1+IK19)",
        ("Quarterly sales", "IK19"): "=IK20+IK21",
        ("Quarterly sales", "IL21"): "=IK21",
        ("Quarterly sales", "IN21"): "=IL21",
        ("Quarterly sales", "IP21"): "=IN21",
        ("Quarterly sales", "IR19"): "=IR18/II18-1",
        ("Quarterly sales", "HS19"): "=HS18/HJ18-1",
        ("H1H2", "FI16"): "=FE16-0.3%",
        ("H1H2", "FM16"): "=FI16+0.2%",
        ("H1H2", "FN16"): "=FM16",
        ("H1H2", "FM14"): "=FM16*FM5",
        ("H1H2", "FM10"): "=-(FM5-FM14)",
        ("Multiples", "X6"): "=Q38",
        ("Multiples", "X8"): "=X7*X6",
        ("Multiples", "X10"): "=X8/X9-1",
    }
    inputs = {
        ("Quarterly sales", "HS18"): 312,
        ("Quarterly sales", "IK21"): 0.08,
        ("Quarterly sales", "IK20"): 0,
        ("Quarterly sales", "IK45"): 0.12,
        ("H1H2", "FE10"): -2206,
        ("Multiples", "X7"): 47,
        ("Multiples", "X9"): 2150,
        ("Multiples", "J3"): 2400,
    }
    for key, expected in formulas.items():
        assert cells[key]["formula"] == expected, (key, cells[key]["formula"], expected)
    for key, expected in inputs.items():
        assert not cells[key]["is_formula"] and cells[key]["numeric_value"] == expected, key
    assert "26E" in cells["Quarterly sales", "IK1"]["display_value"]
    assert "24" in cells["Quarterly sales", "HS1"]["display_value"]
    number = lambda sheet, cell: cells[sheet, cell]["numeric_value"]
    assert math.isclose(number("Quarterly sales", "IR18"), 1727.001, abs_tol=1e-6)
    target = number("Multiples", "X6") * number("Multiples", "X7")
    assert math.isclose(number("Multiples", "X8"), target, abs_tol=1e-8)
    assert math.isclose(number("Multiples", "X10"), target / 2150 - 1, abs_tol=1e-10)
    assert target / 2150 - 1 > 0 > target / 2400 - 1
    cost = -number("H1H2", "FM5") * (1 - number("H1H2", "FM16"))
    assert math.isclose(number("H1H2", "FM10"), cost, abs_tol=1e-7)
    print(f"PASS: {len(formulas)} formulas, {len(inputs)} hardcoded inputs, period labels and 5 arithmetic checks")
    print("Source assertions only. Score actual agent answers separately against cases.json.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", type=Path, required=True)
    args = parser.parse_args()
    check(args.workbook.resolve(strict=True))
