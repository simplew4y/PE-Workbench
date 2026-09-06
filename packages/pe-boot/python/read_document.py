#!/usr/bin/env python3
"""Parse one registered document version when an agent opens it."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

from office import read_office
from excel_date_candidates import extract_filename_date
from workbook import WORKBOOK_SCHEMA, WORKBOOK_TABLES, prepare_workbook


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as original:
        for block in iter(lambda: original.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def prepare_document(project: Path, doc_id: str, revision: str) -> None:
    project = project.resolve(strict=True)
    database_path = (project / 'meta/collection.sqlite3').resolve(strict=True)
    raw = (project / 'raw').resolve(strict=True)
    if database_path.parent != project / 'meta' or raw != project / 'raw':
        raise ValueError('Document storage resolves outside the project')
    cache = project / 'meta/read-cache'
    cache.mkdir(exist_ok=True)
    if cache.resolve() != cache:
        raise ValueError('Document cache must not be a symlink')
    target = cache / f'{doc_id}.json'
    with closing(sqlite3.connect(database_path, timeout=30)) as connection, connection:
        connection.row_factory = sqlite3.Row
        connection.execute('BEGIN IMMEDIATE')
        for statement in WORKBOOK_SCHEMA.split(';'):
            if statement.strip():
                connection.execute(statement)
        document = connection.execute('SELECT * FROM documents WHERE doc_id=?', (doc_id,)).fetchone()
        if document is None:
            raise ValueError('Document version not found')
        original = (project / document['stored_path']).resolve(strict=True)
        if not original.is_file() or raw not in original.parents:
            raise ValueError('Original file is outside raw/')
        if file_hash(original) != document['checksum']:
            raise ValueError('Original file changed; its citations no longer match this version')
        existing = connection.execute('SELECT revision FROM document_cache WHERE doc_id=?', (doc_id,)).fetchone()
        if existing and existing['revision'] == revision and target.is_file():
            try:
                cached = json.loads(target.read_text(encoding='utf-8'))
                if (cached['doc_id'] == doc_id and cached['revision'] == revision
                        and isinstance(cached['blocks'], list)
                        and all(isinstance(block['text'], str) for block in cached['blocks'])
                        and isinstance(cached['warnings'], list)
                        and all(isinstance(warning, str) for warning in cached['warnings'])
                        and ('text' not in cached or isinstance(cached['text'], str))):
                    return
            except (OSError, ValueError, TypeError, KeyError):
                pass
        for table in WORKBOOK_TABLES:
            connection.execute(f'DELETE FROM {table} WHERE doc_id=?', (doc_id,))
        suffix = document['file_type'].lower()
        result: dict[str, object] = {'doc_id': doc_id, 'revision': revision, 'blocks': [], 'warnings': []}
        if suffix in {'xlsx', 'xlsm'}:
            result.update(prepare_workbook(connection, dataset_id=document['dataset_id'], doc_id=doc_id, path=original))
        elif suffix == 'pdf':
            blocks = []
            empty_pages = []
            with pymupdf.open(original) as pdf:
                for index, page in enumerate(pdf, 1):
                    text = page.get_text('text', sort=True).strip()
                    blocks.append({'page_start': index, 'page_end': index, 'text': text})
                    if not re.search(r'[A-Za-z0-9\u3400-\u9fff]', text):
                        empty_pages.append(index)
            result.update({'parser_name': 'pymupdf', 'parser_version': pymupdf.VersionBind, 'blocks': blocks})
            if empty_pages:
                result['warnings'] = [f'Pages without extractable text (inspect visually or use OCR): {empty_pages}']
        elif suffix in {'docx', 'pptx'}:
            result.update({'parser_name': 'stdlib_ooxml', 'parser_version': '1', 'blocks': read_office(original)})
        elif suffix in {'txt', 'md', 'markdown', 'csv'}:
            content = original.read_bytes()
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
            raise ValueError(f'Unsupported document type: {suffix}')
        if file_hash(original) != document['checksum']:
            raise ValueError('Original file changed during reading')
        temporary = cache / f'.{doc_id}.{uuid.uuid4().hex}.tmp'
        try:
            temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            os.replace(temporary, target)
            now = datetime.now(timezone.utc).isoformat()
            connection.execute('INSERT OR REPLACE INTO document_cache VALUES (?,?,?)', (doc_id, revision, now))
            filename_date = extract_filename_date(document['original_filename'])
            connection.execute('UPDATE documents SET parser_name=?,parser_version=?,document_date=?,updated_at=? WHERE doc_id=?',
                               (result['parser_name'], result['parser_version'],
                                filename_date.normalized_date if filename_date else None, now, doc_id))
            connection.commit()
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--doc-id', required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', args.doc_id):
        parser.error('Invalid document ID')
    try:
        prepare_document(args.project, args.doc_id, args.revision)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
