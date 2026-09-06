# Combined PDF and Excel pipeline

Use this branch together with `integration/pdf-excel-python` of the sibling
`PE-Workbench-pi` repository. Install/build Core and its Python Excel environment
first; see `packages/pe-boot/INTEGRATION.md` there for setup and migration details.

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
Existing PDF v2 projects migrate to v3 without changing page IDs or FTS content.
Back up deployed project data before upgrading both repositories together.

For development verification, run `node_modules/.bin/tsc --noEmit`, `npm run lint`,
`npm run build:pe-ingest`, and the PE tests under `lib/` and `app/api/pe/`.
Use the normal development server for UI checks; do not run `next build` in an
active development workspace.

Verified on 2026-09-07: 95 related Web tests, worker build, TypeScript, and lint
passed. A running Next server completed a mixed PDF/Excel upload and returned
both evidence previews and PDF byte ranges. Core's integration document records
the pinned reference commits, real-workbook parity results, and validation limits.
