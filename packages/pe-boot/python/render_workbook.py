"""Render a bounded source range with LibreOffice; never save over the original."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from openpyxl.utils.cell import range_boundaries, absolute_coordinate, quote_sheetname

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def render(path: Path, sheet: str, area: str) -> dict:
    left, top, right, bottom = range_boundaries(area)
    if not all((left, top, right, bottom)) or left < 1 or top < 1 or right < left or bottom < top or right > 16384 or bottom > 1048576:
        raise ValueError("Invalid bounded A1 range")
    if right - left >= 30 or bottom - top >= 100:
        raise ValueError("Select at most 30 columns and 100 rows per image")
    office = shutil.which(os.environ.get("PE_WORKBOOK_OFFICE", "soffice"))
    raster = shutil.which(os.environ.get("PE_WORKBOOK_PDFTOPPM", "pdftoppm"))
    if not office or not raster:
        raise RuntimeError("Workbook images require LibreOffice (soffice) and Poppler (pdftoppm)")
    with tempfile.TemporaryDirectory(prefix="pe-workbook-render-") as directory:
        root = Path(directory)
        copy = root / "source.xlsx"
        with ZipFile(path) as source:
            workbook = ET.fromstring(source.read("xl/workbook.xml"))
            sheets = list(workbook.find(f"{{{NS}}}sheets"))
            selected = next((item for item in sheets if item.get("name") == sheet), None)
            if selected is None:
                raise ValueError("Worksheet not found")
            relationships = ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))
            target = next(item.get("Target") for item in relationships if item.get("Id") == selected.get(f"{{{REL}}}id"))
            sheet_path = target.lstrip("/") if target.startswith("/") else "xl/" + target
            for item in sheets:
                item.set("state", "visible" if item is selected else "hidden")
            # A hidden but still active/selected sheet can be printed by Calc.
            for view in workbook.findall(f"{{{NS}}}bookViews/{{{NS}}}workbookView"):
                view.set("activeTab", str(sheets.index(selected)))
                view.set("firstSheet", str(sheets.index(selected)))
            properties = workbook.find(f"{{{NS}}}workbookPr")
            if properties is not None:
                properties.set("updateLinks", "never")
            calculation = workbook.find(f"{{{NS}}}calcPr")
            if calculation is not None:
                calculation.set("calcMode", "manual")
                calculation.set("fullCalcOnLoad", "0")
                calculation.set("forceFullCalc", "0")
            names = workbook.find(f"{{{NS}}}definedNames")
            if names is None:
                names = ET.SubElement(workbook, f"{{{NS}}}definedNames")
            for name in list(names):
                if name.get("name") in {"_xlnm.Print_Area", "_xlnm.Print_Titles"}:
                    names.remove(name)
            name = ET.SubElement(names, f"{{{NS}}}definedName", {"name": "_xlnm.Print_Area", "localSheetId": str(sheets.index(selected))})
            name.text = quote_sheetname(sheet) + "!" + absolute_coordinate(area)
            worksheet = ET.fromstring(source.read(sheet_path))
            sheet_properties = worksheet.find(f"{{{NS}}}sheetPr")
            if sheet_properties is None:
                sheet_properties = ET.Element(f"{{{NS}}}sheetPr")
                worksheet.insert(0, sheet_properties)
            fit = sheet_properties.find(f"{{{NS}}}pageSetUpPr")
            if fit is None:
                fit = ET.SubElement(sheet_properties, f"{{{NS}}}pageSetUpPr")
            fit.set("fitToPage", "1")
            setup = worksheet.find(f"{{{NS}}}pageSetup")
            if setup is None:
                setup = ET.SubElement(worksheet, f"{{{NS}}}pageSetup")
            setup.attrib.update({"fitToWidth": "1", "fitToHeight": "1", "orientation": "landscape", "paperSize": "9"})
            with ZipFile(copy, "w") as output:
                for info in source.infolist():
                    data = source.read(info.filename)
                    if info.filename == "xl/workbook.xml":
                        data = ET.tostring(workbook, encoding="utf-8", xml_declaration=True)
                    elif info.filename == sheet_path:
                        data = ET.tostring(worksheet, encoding="utf-8", xml_declaration=True)
                    if info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml"):
                        tree = ET.fromstring(data)
                        for view in tree.findall(f"{{{NS}}}sheetViews/{{{NS}}}sheetView"):
                            view.set("tabSelected", "1" if info.filename == sheet_path else "0")
                        data = ET.tostring(tree, encoding="utf-8", xml_declaration=True)
                    output.writestr(info, data)
        profile = root / "profile" / "user"
        profile.mkdir(parents=True)
        (profile / "registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>''')
        subprocess.run([office, "-env:UserInstallation=" + profile.parent.as_uri(), "--headless", "--convert-to", "pdf:calc_pdf_Export", "--outdir", str(root), str(copy)], capture_output=True, check=True, timeout=60)
        pdf = root / "source.pdf"
        if not pdf.exists():
            raise RuntimeError("LibreOffice did not produce a range preview")
        subprocess.run([raster, "-f", "1", "-singlefile", "-scale-to", "2400", "-png", str(pdf), str(root / "range")], capture_output=True, check=True, timeout=30)
        return {"sheet": sheet, "range": area, "renderer": "LibreOffice", "image": {"type": "image", "mimeType": "image/png", "data": base64.b64encode((root / "range.png").read_bytes()).decode()}, "instruction": "Layout preview of a working copy. Use read for original saved values and formulas; this image does not establish recalculation freshness."}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        json.dump(render(Path(sys.argv[1]).resolve(strict=True), request["sheet"], request["range"]), sys.stdout)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
