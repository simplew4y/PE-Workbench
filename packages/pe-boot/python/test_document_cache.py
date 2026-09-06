"""Regressions for the workbook cache extracted from the upload pipeline."""
import hashlib
import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook
from openpyxl.utils.datetime import CALENDAR_MAC_1904
from openpyxl.workbook.defined_name import DefinedName

import read_document


class DocumentCacheTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pe-reader-cache-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'raw').mkdir()
        (self.root / 'meta').mkdir()
        self.source = self.root / 'raw/model_2025_Jun_30.xlsx'
        workbook = Workbook()
        workbook.epoch = CALENDAR_MAC_1904
        sheet = workbook.active
        sheet.title = 'Model'
        sheet.append(['Valuation Date', date(2025, 6, 30)])
        sheet.append(['Forecast', '2030E'])
        sheet.append(['Target price date', date(2026, 6, 30)])
        sheet.append(['Valuation Date', '=DATE(2025,6,30)'])
        workbook.defined_names.add(DefinedName('Valuation_Date', attr_text="'Model'!$B$1"))
        workbook.save(self.source)
        workbook.close()
        self.database = sqlite3.connect(self.root / 'meta/collection.sqlite3')
        self.addCleanup(self.database.close)
        self.database.executescript('''
            CREATE TABLE documents (doc_id TEXT PRIMARY KEY, dataset_id TEXT, stored_path TEXT,
                original_filename TEXT, checksum TEXT, file_type TEXT, parser_name TEXT,
                parser_version TEXT, document_date TEXT, updated_at TEXT);
            CREATE TABLE document_cache (doc_id TEXT PRIMARY KEY, revision TEXT, prepared_at TEXT);
        ''')
        self.database.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL)',
                              ('doc-1', 'dataset-1', 'raw/' + self.source.name, self.source.name,
                               read_document.file_hash(self.source), 'xlsx'))
        self.database.commit()

    def test_keeps_1904_dates_named_ranges_and_forecasts_separate(self):
        read_document.prepare_document(self.root, 'doc-1', 'r1')
        rows = self.database.execute('''SELECT role, normalized_date, cell_ref FROM valuation_date_candidates
            WHERE source_type='workbook_cell' ORDER BY cell_ref''').fetchall()
        self.assertEqual(rows, [('valuation_date', '2025-06-30', 'B1'),
                                ('forecast_period', None, 'B2'), ('target_horizon_end', '2026-06-30', 'B3')])
        self.assertEqual(self.database.execute("SELECT normalized_date FROM valuation_date_candidates WHERE source_type='defined_name'").fetchone(), ('2025-06-30',))
        metadata = json.loads(self.database.execute('SELECT metadata_json FROM excel_workbooks').fetchone()[0])
        self.assertTrue(metadata['date_epoch'].startswith('1904-01-01'))
        self.assertEqual(self.database.execute('SELECT document_date FROM documents').fetchone(), ('2025-06-30',))

    def test_refresh_changes_only_cache_and_rolls_back_on_failure(self):
        read_document.prepare_document(self.root, 'doc-1', 'r1')
        cells = self.database.execute('SELECT cell_id FROM excel_cells ORDER BY cell_id').fetchall()
        checksum = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with patch.object(read_document, 'prepare_workbook', side_effect=RuntimeError('refresh failed')):
            with self.assertRaisesRegex(RuntimeError, 'refresh failed'):
                read_document.prepare_document(self.root, 'doc-1', 'r2')
        self.assertEqual(self.database.execute('SELECT revision FROM document_cache').fetchone(), ('r1',))
        self.assertEqual(self.database.execute('SELECT cell_id FROM excel_cells ORDER BY cell_id').fetchall(), cells)
        read_document.prepare_document(self.root, 'doc-1', 'r2')
        self.assertEqual(self.database.execute('SELECT revision FROM document_cache').fetchone(), ('r2',))
        self.assertEqual(self.database.execute('SELECT doc_id FROM documents').fetchall(), [('doc-1',)])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), checksum)
        with patch.object(read_document, 'prepare_workbook', side_effect=AssertionError('cache was rebuilt')):
            read_document.prepare_document(self.root, 'doc-1', 'r2')

    def test_defined_name_preserves_qualification_on_its_target(self):
        workbook = load_workbook(self.source)
        workbook['Model']['A1'] = 'Valuation Date not confirmed'
        workbook.save(self.source)
        workbook.close()
        self.database.execute('UPDATE documents SET checksum=?', (read_document.file_hash(self.source),))
        self.database.commit()
        read_document.prepare_document(self.root, 'doc-1', 'r1')
        rows = self.database.execute("SELECT source_type,rejection_reason,metadata_json FROM valuation_date_candidates WHERE cell_ref='B1' ORDER BY source_type").fetchall()
        self.assertEqual([row[0] for row in rows], ['defined_name', 'workbook_cell'])
        for _, reason, metadata in rows:
            self.assertEqual(reason, 'date_assertion_unconfirmed')
            self.assertEqual(json.loads(metadata)['assertion_status'], 'unconfirmed')


if __name__ == '__main__':
    unittest.main()
