"""Preserve the main workbook regressions through the pure parser transport.

SQLite cache publication/rollback is covered by test/excel-processing.test.ts,
because the Node service now owns those transactions.
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook
from openpyxl.utils.datetime import CALENDAR_MAC_1904
from openpyxl.workbook.defined_name import DefinedName

import workbook as workbook_parser


class DocumentCacheTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pe-reader-cache-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'model_2025_Jun_30.xlsx'
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

    def parse(self, revision='r1'):
        output = self.root / (revision + '.json')
        output.unlink(missing_ok=True)
        subprocess.run([sys.executable, str(Path(__file__).with_name('parse_workbook.py')),
                        '--input', str(self.source), '--output', str(output),
                        '--doc-id', 'a' * 40, '--dataset-id', 'dataset-1', '--revision', revision,
                        '--sha256', hashlib.sha256(self.source.read_bytes()).hexdigest(),
                        '--filename', self.source.name], check=True)
        return json.loads(output.read_text())

    def test_keeps_1904_dates_named_ranges_and_forecasts_separate(self):
        result = self.parse()
        candidates = result['tables']['valuation_date_candidates']
        rows = sorted((row['role'], row['normalized_date'], row['cell_ref'])
                      for row in candidates if row['source_type'] == 'workbook_cell')
        self.assertEqual(sorted(rows, key=lambda row: row[2]), [
            ('valuation_date', '2025-06-30', 'B1'), ('forecast_period', None, 'B2'),
            ('target_horizon_end', '2026-06-30', 'B3')])
        self.assertEqual([row['normalized_date'] for row in candidates if row['source_type'] == 'defined_name'], ['2025-06-30'])
        metadata = json.loads(result['tables']['excel_workbooks'][0]['metadata_json'])
        self.assertTrue(metadata['date_epoch'].startswith('1904-01-01'))
        self.assertEqual(result['document_date'], '2025-06-30')

    def test_refresh_preserves_cell_ids_and_original_even_after_a_parser_failure(self):
        first = self.parse()
        checksum = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with patch.object(workbook_parser, '_parse_loaded_workbook', side_effect=RuntimeError('refresh failed')):
            with self.assertRaisesRegex(RuntimeError, 'refresh failed'):
                workbook_parser.parse_workbook(dataset_id='dataset-1', doc_id='a' * 40, path=self.source)
        second = self.parse('r2')
        self.assertEqual(first['tables'], second['tables'])
        self.assertEqual(first['doc_id'], second['doc_id'])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), checksum)

    def test_defined_name_preserves_qualification_on_its_target(self):
        workbook = load_workbook(self.source)
        workbook['Model']['A1'] = 'Valuation Date not confirmed'
        workbook.save(self.source)
        workbook.close()
        result = self.parse()
        rows = sorted((row for row in result['tables']['valuation_date_candidates'] if row['cell_ref'] == 'B1'), key=lambda row: row['source_type'])
        self.assertEqual([row['source_type'] for row in rows], ['defined_name', 'workbook_cell'])
        for row in rows:
            self.assertEqual(row['rejection_reason'], 'date_assertion_unconfirmed')
            self.assertEqual(json.loads(row['metadata_json'])['assertion_status'], 'unconfirmed')


if __name__ == '__main__':
    unittest.main()
