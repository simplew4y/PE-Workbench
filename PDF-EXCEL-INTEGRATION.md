# Combined PDF and Excel pipeline

Use the merged `main` together with the matching PDF/Excel merge on `main` of the
sibling `PE-Workbench-pi` repository. The implementation originated on the paired
`integration/pdf-excel-python` branches. Install/build Core and its Python Excel
environment first; see `packages/pe-boot/INTEGRATION.md` there for setup and
migration details.

```sh
npm ci --ignore-scripts
npm run build:pe-boot
npm run build:pe-ingest
npm run dev
```

Project upload accepts PDF, XLSX, and XLSM, including mixed batches. PDF keeps the
existing page parsing, rendering, search, and `page:` source preview. Excel
registers immutable originals and prepares them in the background with the same
Core service used by Agent tools. The project list shows processing state and
versions, allows viewing historical versions, and can retry failed Excel jobs.

Excel evidence previews understand main's versioned `source:` references and
existing `cell:` references. They preserve exact historical originals, formulas,
cached values, number formats, and range locations. Missing caches are rebuilt;
a modified original produces an error instead of showing the current workbook.

Schema initialization is shared with Core through `@earendil-works/pe-boot/schema`.
Existing PDF v2/v3 projects migrate to v4 without changing page IDs or FTS content.
Main's older project registry upgrades in place, preserving duplicate display
names, registered workspace paths, and existing originals. Empty older projects
initialize the new collection when opened. Recognized main document catalogs keep
their original document IDs, version history, and current selection. Older PDFs
without Node page artifacts appear as failed and can be retried from the document
list, including historical versions. Their artifacts publish under
`meta/pdf-catalog/<docId>/<generation>/` without changing existing source links.
Unrecognized legacy chunk databases are not converted automatically.

The former automatic-identification
research upload and its legacy ingest entry are replaced by this shared worker;
chat attachment extraction and general workspace file upload remain available.
Back up deployed project data before upgrading both repositories together.

For development verification, run `node_modules/.bin/tsc --noEmit`, `npm run lint`,
`npm run build:pe-ingest`, and the PE tests under `lib/` and `app/api/pe/`.
Use the normal development server for UI checks; do not run `next build` in an
active development workspace.

Integration branch verified on 2026-09-07: 95 related Web tests, worker build,
TypeScript, and lint passed. A running Next server completed a mixed PDF/Excel upload and returned
both evidence previews and PDF byte ranges. Core's integration document records
the pinned reference commits, real-workbook parity results, and validation limits.

The main merge passed 119 related Web tests (6 suites, no failures or skips),
worker build, TypeScript, and lint on 2026-09-07. Added checks cover older registries
and workspace paths, catalog PDF retries and publication rollback, historical
source identity, and both preview and original-file routes rejecting changed or
deleted PDF originals. Managed `page:` references use Core's shared original
validation before the Web preview adds adjacent page context.
