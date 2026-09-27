#!/usr/bin/env python3
"""Build source navigation and an optional text index; never infer business meaning."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from validate_workbook import validate_workbook
from workbook_reader import build_text_index, navigation_artifact


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--text-index-output", type=Path)
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
    result = navigation_artifact(original, args.dataset_id, args.doc_id)
    if args.text_index_output:
        text_index = build_text_index(original, args.sha256, result["navigation"])
        with args.text_index_output.open("x", encoding="utf-8") as output:
            json.dump(text_index, output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if hashlib.sha256(original.read_bytes()).hexdigest() != args.sha256:
        raise ValueError("Original workbook changed while it was being parsed")
    result.update({
        "schema_version": 1,
        "doc_id": args.doc_id,
        "dataset_id": args.dataset_id,
        "revision": args.revision,
        "source_sha256": args.sha256,
        "document_date": "",
    })
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
