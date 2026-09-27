"""Validate an OOXML workbook container without parsing worksheets or writing files."""
from __future__ import annotations

import io
import sys
import zipfile
from xml.etree import ElementTree


def validate_workbook(data: bytes, suffix: str) -> None:
    expected_type = {
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    }.get(suffix)
    if expected_type is None:
        raise ValueError("Only .xlsx and .xlsm workbooks are supported")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 100_000 or sum(entry.file_size for entry in entries) > 1_500_000_000:
                raise ValueError("Workbook archive exceeds extraction limits")
            if any(entry.flag_bits & 1 for entry in entries):
                raise ValueError("Encrypted workbooks are not supported")
            names = [entry.filename for entry in entries]
            if len(set(names)) != len(names):
                raise ValueError("Workbook archive contains duplicate entries")
            for name in ("[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"):
                if name not in names or archive.getinfo(name).file_size > 16_000_000:
                    raise ValueError(f"Invalid OOXML workbook: missing or oversized {name}")
            types = ElementTree.fromstring(archive.read("[Content_Types].xml"))
            if not any(item.get("PartName") == "/xl/workbook.xml" and item.get("ContentType") == expected_type for item in types):
                raise ValueError("Workbook content type does not match its filename extension")
            relationships = ElementTree.fromstring(archive.read("_rels/.rels"))
            if not any(item.get("Type", "").endswith("/officeDocument") and item.get("Target", "").lstrip("/") == "xl/workbook.xml" and item.get("TargetMode") != "External" for item in relationships):
                raise ValueError("Invalid OOXML workbook relationship")
            workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            if workbook.tag.split("}")[-1] != "workbook":
                raise ValueError("Invalid workbook XML root")
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as error:
        raise ValueError("File is not a valid OOXML workbook") from error


if __name__ == "__main__":
    try:
        validate_workbook(sys.stdin.buffer.read(), sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
