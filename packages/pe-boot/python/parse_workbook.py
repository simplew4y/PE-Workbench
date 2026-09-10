#!/usr/bin/env python3
"""Parse a workbook into a JSON artifact; never open the project database."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from excel_date_candidates import extract_filename_date
from validate_workbook import validate_workbook
from workbook import parse_workbook


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--doc-id", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--modified-at")
    args = parser.parse_args()
    if not re.fullmatch(r"(?:[a-f0-9]{40}|doc_[a-f0-9]{24})", args.doc_id):
        raise ValueError("Invalid document ID")
    original = args.input.resolve(strict=True)
    data = original.read_bytes()
    if hashlib.sha256(data).hexdigest() != args.sha256:
        raise ValueError("Original workbook does not match its registered checksum")
    validate_workbook(data, Path(args.filename).suffix.lower().lstrip("."))
    del data
    result = parse_workbook(dataset_id=args.dataset_id, doc_id=args.doc_id, path=original, source_modified_at=args.modified_at)
    if hashlib.sha256(original.read_bytes()).hexdigest() != args.sha256:
        raise ValueError("Original workbook changed while it was being parsed")
    filename_date = extract_filename_date(args.filename)
    result.update({
        "schema_version": 1,
        "doc_id": args.doc_id,
        "dataset_id": args.dataset_id,
        "revision": args.revision,
        "source_sha256": args.sha256,
        "document_date": filename_date.normalized_date if filename_date else "",
    })
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
