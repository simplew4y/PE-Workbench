"""The export copy must select only the requested sheet, including hidden sheets."""
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from render_workbook import NS, REL, render


class RenderSelectionTest(unittest.TestCase):
    def test_export_copy_replaces_active_and_selected_sheets(self):
        source = Path(__file__).resolve().parents[1] / "test/fixtures/excel-parity.xlsx"
        original = source.read_bytes()
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if "--convert-to" in args:
                copy = Path(args[-1])
                with ZipFile(copy) as archive:
                    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
                    sheets = list(workbook.find(f"{{{NS}}}sheets"))
                    index = next(i for i, sheet in enumerate(sheets) if sheet.get("name") == "Hidden assumptions")
                    self.assertEqual([sheet.get("state") for sheet in sheets], ["visible" if i == index else "hidden" for i in range(len(sheets))])
                    for view in workbook.findall(f"{{{NS}}}bookViews/{{{NS}}}workbookView"):
                        self.assertEqual(view.get("activeTab"), str(index))
                        self.assertEqual(view.get("firstSheet"), str(index))
                    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
                    target = next(item.get("Target") for item in relations if item.get("Id") == sheets[index].get(f"{{{REL}}}id"))
                    selected = target.lstrip("/") if target.startswith("/") else "xl/" + target
                    for name in archive.namelist():
                        if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                            tree = ET.fromstring(archive.read(name))
                            for view in tree.findall(f"{{{NS}}}sheetViews/{{{NS}}}sheetView"):
                                self.assertEqual(view.get("tabSelected"), "1" if name == selected else "0")
                    area = workbook.find(f"{{{NS}}}definedNames/{{{NS}}}definedName[@name='_xlnm.Print_Area']")
                    self.assertEqual(area.get("localSheetId"), str(index))
                    self.assertEqual(area.text, "'Hidden assumptions'!$A$1:$B$2")
                copy.with_suffix(".pdf").write_bytes(b"test pdf")
            else:
                Path(args[-1] + ".png").write_bytes(b"test raster")
            return subprocess.CompletedProcess(args, 0)

        with patch("render_workbook.shutil.which", side_effect=lambda value: value), patch("render_workbook.subprocess.run", side_effect=run):
            result = render(source, "Hidden assumptions", "A1:B2")
        self.assertEqual(result["sheet"], "Hidden assumptions")
        self.assertEqual(len(calls), 2)
        self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
