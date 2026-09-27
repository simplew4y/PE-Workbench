#!/usr/bin/env python3
"""Read an Office or text original into JSON; Node owns all database transactions."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

from excel_date_candidates import extract_filename_date
from office import read_office


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as original:
        for block in iter(lambda: original.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_document(path: Path, suffix: str) -> dict[str, object]:
    result: dict[str, object] = {'blocks': [], 'warnings': []}
    if suffix in {'docx', 'pptx'}:
        result.update({'parser_name': 'stdlib_ooxml', 'parser_version': '1', 'blocks': read_office(path)})
    elif suffix in {'txt', 'md', 'markdown', 'csv'}:
        content = path.read_bytes()
        encodings = ('utf-16',) if content.startswith((b'\xff\xfe', b'\xfe\xff')) else ('utf-8-sig', 'gb18030')
        for encoding in encodings:
            try:
                text = content.decode(encoding)
                break
            except UnicodeError:
                continue
        else:
            raise ValueError('Unsupported text encoding')
        result.update({'parser_name': 'text', 'parser_version': '1', 'text': text.replace('\r\n', '\n').replace('\r', '\n')})
    else:
        raise ValueError('Use the Node PDF pipeline or the dedicated workbook parser for this document type')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--doc-id', required=True)
    parser.add_argument('--dataset-id', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--filename', required=True)
    parser.add_argument('--modified-at')
    args = parser.parse_args()
    if file_hash(args.input) != args.sha256:
        raise ValueError('Original file changed before reading')
    result = read_document(args.input, Path(args.filename).suffix.lower().lstrip('.'))
    if file_hash(args.input) != args.sha256:
        raise ValueError('Original file changed during reading')
    filename_date = extract_filename_date(args.filename)
    result.update({'schema_version': 1, 'doc_id': args.doc_id, 'dataset_id': args.dataset_id,
                   'revision': args.revision, 'source_sha256': args.sha256,
                   'document_date': filename_date.normalized_date if filename_date else ''})
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, allow_nan=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
