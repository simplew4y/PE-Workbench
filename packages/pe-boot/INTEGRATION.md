# PDF and Excel integration

This branch combines the PDF pipeline from `rebuild_pipeline/search` with the
Excel parser, financial tools, and valuation skill from main. It does not replace
PDF.js with a Python PDF reader.

## Install

Use Node.js 22.19 or later and Python 3.9 or later. In the Core repository:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run setup:python --workspace=@earendil-works/pe-boot
```

The setup command creates `packages/pe-boot/python/.venv` and installs the pinned
Excel dependencies. Alternatively set `PE_EXCEL_PYTHON` to the Python executable
of a managed environment before setup and runtime. `PE_DOCUMENT_PYTHON` remains
an accepted fallback. Python is required for Excel; the PDF pipeline remains
independent of it. No Excel macros or formula recalculation engine are run.

Deploy the matching Web main revision beside this repository as `PE-Workbench-pi-web`.
Its existing `file:../PE-Workbench-pi/...` dependencies then resolve the same
schema, parser service, and evidence resolver used by the Agent.

## Processing

- PDF: upload → original → Node worker → PDF.js text/layout/images → SQLite
  pages and FTS → `pe_pdf_search` / `pe_pdf_read` → `page:` citations.
- Excel: upload → immutable document version → background preparation → Python
  openpyxl → staged parsing output → Node transaction publishes Excel tables and
  cache pointers → six financial tools → versioned `source:` citations.
- An Agent opening a queued workbook waits for the same preparation service.
  Missing caches are rebuilt through that service. Parsing never holds a SQLite
  write transaction. A persisted lease coordinates separate worker processes.
- Main's text, CSV, DOCX, and PPTX reader remains available through
  `pe_document_open`. It uses the same version catalog, preparation lease, and
  immutable cache publication; Python returns parsed data without writing SQLite.

The financial tools are `pe_workbook_inspect`, `pe_excel_range`,
`pe_formula_trace`, `pe_valuation_output_locate`, `pe_valuation_date_resolve`, and
`pe_model_validate`. `pe_document_open` provides readable Excel text for native
read/grep fallback. The complete `valuation-model-explainer` skill is included.
Formula cached values, missing/error statuses, ambiguous outputs, and unresolved
dates retain their meaning from main; cached results are not recalculated values.

## Schema and versions

`src/collection-schema.ts` owns schema version 4 for both applications. Opening an
existing PDF v2 project migrates its documents table transactionally, retaining
PDF document/page IDs, artifacts, FTS entries, and foreign-key relationships.
The integration branch's v3 databases also upgrade explicitly. The prior main's
versioned original-file catalog is recognized separately and preserves document
IDs, versions, and original paths. Unrelated chunk-ingestion databases are not
treated as this catalog.

PDF filename/hash constraints apply to pipeline registrations. Migrated catalog
PDFs retain main's distinct historical versions, including repeated filenames or
content. Excel uses logical document identity, version number, and a single
current version instead.

Old main PDFs with only a Python reading cache require one Node reprocessing pass.
They are marked failed with an explanatory message until retried from the project
document list. Retry retains their document IDs and writes separate version
artifacts, so historical `source:` citations resume at the same original. PDF
parsing remains in the Node pipeline.

PDF discovery selects only current, active, undeleted documents. Search results
include the immutable `doc_id`; pass it to `pe_pdf_read` to pin a version. A
filename matching multiple current PDFs is rejected as ambiguous. Historical
page/source citations and explicit document-ID reads remain available.

Before upgrading a deployed project, stop its writers and take a SQLite backup
of `meta/collection.sqlite3` together with `raw/` and `meta/`. Keep the backup
until validation succeeds. Rollback requires restoring that backup and both old
application versions; old applications cannot write schema v4.
Unrelated legacy ingestion schemas are rejected rather than silently rewritten.

Excel identity uses the exact original filename as on main. Uploading the same
current bytes reuses that version. Changed bytes create a version immediately,
including A → B → A as three versions. A queued or failed newest version stays
current; tools do not silently substitute the preceding workbook. Historic
citations may still resolve superseded versions and repair their caches.

New Excel evidence encodes document version, sheet, and range. Durable locator
records preserve legacy `cell:` / `fact:` references across cache deletion.
Memo, Research Note, Agent verification, and Web preview share this resolution.
Missing or modified originals cannot silently resolve to a different version.

## Validation

Run the focused `packages/pe-boot/test/` tests with the repository Vitest CLI,
Python parser tests with `npm run test:python --workspace=@earendil-works/pe-boot`,
and the repository-wide `npm run check`. The paired Web repository additionally
checks mixed ingestion, PDF regression, historical evidence, and worker retry.
Real research workbooks used for local comparison are not included in commits.

### Integration branch verification, 2026-09-07

Reference commits are Core PDF `b489d5e2bd533c117e119f62adaa1fefbeb4b85c`,
Web PDF `79b8b244ea8f7cb63c4f967fce11a8a254f15909`, and Core Excel main
`a2870ae2902e1cc52343b9e94e227601839f7fa6`. The six financial-tool implementations
and their shared cell helper are unchanged from that Excel reference.

- Core: 95 focused tests across 12 files and 37 Python tests passed.
- Web: 95 related tests passed; worker build, TypeScript, and lint passed.
- Core build and package-content checks passed, including the Python runtime
  files, exported schema/evidence modules, and complete valuation skill.
- A running Next development server accepted a mixed PDF/Excel upload, completed
  both documents, returned both source previews, and served PDF byte ranges with
  HTTP 206. Browser screenshot inspection was unavailable in this environment.

Differential runs compared every column and row in all eight Excel tables,
complete outputs for all six tools, and the full readable-text SHA-256:

| Workbook | Sheets | Cells | Formula references | Result |
| --- | ---: | ---: | ---: | --- |
| Generated compatibility fixture | 7 | 64 | 23 | Equal to main |
| Horizon Robotics XLSX | 8 | 8,318 | 10,973 | Equal to main |
| NVIDIA XLSM | 12 | 72,438 | 151,335 | Equal to main |
| HERMES XLSM | 36 | 78,597 | 122,783 | Equal to main |

The generated fixture and pinned-main golden output are committed under
`test/fixtures/`; see `excel-parity.md` for reproducible coverage. Equality includes
existing errors: main's range tool trims a trailing space in HERMES's `Stores `
sheet name and cannot select that sheet. This integration preserves that behavior.
These comparisons establish parser/tool equivalence for the tested workbooks;
they do not assert identical wording from nondeterministic model responses.

Initial integration-branch validation used hash-verified local model catalog
snapshots (2026-09-06 providers and 2026-08-31 GitHub Copilot). The main merge
preserves main's existing Gateway catalog and Copilot test fixes, so the final
repository-wide check passes with freshly hydrated online model data. No further
AI source or test changes were needed for this merge.

The PDF baseline also omitted `pe-generative-ui/references/evaluation-cases.json`
while its existing skill and tests referenced it. That file is restored unchanged
from the pinned main commit, and the existing three evaluation tests pass.

### Main merge verification, 2026-09-07

The merge starts from Core main `a2870ae2902e1cc52343b9e94e227601839f7fa6`
and Web main `0c2b9dd1371de0716794b5d9a2b69d0f50575fc9`, integrating
`8f809c725b05e4a0a096979984c0fe15e6284ce8` and
`f5c2ccb326933339f5fac0066d45bb518bc8abae`, respectively.

Core's 14 focused suites (120 tests), 40 Python tests, the complete repository
check, and the full offline build passed. The paired Web's 119 related tests,
worker build, TypeScript, and lint passed. A fresh isolated Next server again
completed mixed PDF/Excel ingestion and returned both source previews and PDF
byte-range responses.

Merge-specific regressions cover exact prior-main and v3 schema upgrades,
first-access citation migration, historical PDF reprocessing and failed
publication rollback, current-version PDF discovery, ambiguous filenames,
modified/deleted originals in both source routes, old project registry layouts,
and main's text/Office, Memo, and Note behavior. The six Excel tools and their
cell helper remain unchanged from pinned main, and the committed main-output
golden comparison passes after the merge.
