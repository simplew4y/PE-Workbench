# Excel compatibility fixture

`excel-parity.xlsx` is a generated OOXML workbook, not research data. Its SHA-256 is
`1d61a2b2d43bb21caf2fbbfe0cb4fd03fce96470f2f50f9932eba7820e793d81`.
`create_excel_parity.py` documents its construction and generates changed versions
for citation tests. The committed binary fixes ZIP timestamps and workbook
properties for the golden comparison; regenerating it requires regenerating the
golden result against the reference implementation.

`excel-parity-main.json` was produced using the original Python workbook parser,
the original six financial tools, and the original readable-view writer from
Core commit `a2870ae2902e1cc52343b9e94e227601839f7fa6` (main). It was not generated
from the merged implementation. Both runs use the exact same bytes, original
filename, `parity-dataset`, immutable document ID, and original mtime
`2026-08-31T00:00:00Z`.

`financial-parity-support.ts` compares complete tool results and hashes every
column of every row in the eight workbook tables after sorting row keys and
rows. It also hashes the complete readable text, including ordering and citation
links. The research alignment normalizes only three additive changes before
comparison: the two exact parser-warning lines, workbook inspection's added
processing status, and date-candidate source IDs back to the legacy cell IDs for
the same locations. The test separately asserts the exact warnings and status,
and resolves every date-candidate source ID to its original document and cell.
Values, formulas, scores, all other fields and identifiers remain unchanged.
The main golden file is retained byte-for-byte. Range calls that fail are compared as errors;
this preserves visibility of pre-existing main limitations.

Coverage includes DCF, SOTP, price and upside, sensitivity outputs, hidden sheets,
defined names, merged cells, hidden rows/columns, frozen panes, cached and missing
formula values, array and data-table formulas, external and whole-column
references, cycles, blank targets, error values, conflicting and negated dates,
forecast periods, and text longer than a source preview.

Run the regression from `packages/pe-boot`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/excel-evidence-parity.test.ts
```

Python with the package's pinned requirements is required. The regression also
checks superseded versions, legacy cell IDs after cache deletion, blank-range
citations, original-file integrity, and preparation before Memo/Note write
transactions.
