# Session attachment extractor

This helper preserves the multi-format chat attachment behavior. Project PDF
ingestion remains a separate TypeScript pipeline under `lib/pe-ingest/`.
Chat attachments and PE workbook tools use the same Python interpreter and pinned
dependencies maintained in `packages/pe-boot/python/requirements.txt`.

From the repository root, install and verify the shared environment:

```bash
npm run setup:python
```

The installer creates `packages/pe-boot/python/.venv` in the current checkout.
`PE_EXCEL_PYTHON`, then `PE_DOCUMENT_PYTHON`, can select an existing interpreter;
both installation and runtime use this precedence. Configure the same value for
both processes. Do not point a release at another release's environment.

Setup verifies pinned package versions and reads generated PDF and Excel fixtures.
In the monorepo it also runs this attachment extractor against both files, including
an Excel formula. A failed check exits nonzero before the deployment build starts.
Each new release must run setup; dependency changes are applied from that release's
requirements, rather than tracking the latest packages automatically.

`setup.sh` delegates to the shared installer and no longer creates a service-local
`.venv`. Such an environment is not used by the updated application.
