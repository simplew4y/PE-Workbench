# PE ingest runtime

This local worker vendors the deterministic private-fund ingestion pipeline.
The PE project registry is the authority for every upload; browser-supplied
paths never select a dataset. The fixed layout is:

```text
~/.pi/agent/pe-workbench/  # or $PI_CODING_AGENT_DIR/pe-workbench
  datasets.sqlite3
  _uploads/<dataset_id>/
  projects/<dataset_id>/
    generated/
    meta/collection.sqlite3
    raw/
```

Pi Web resolves `dataset_id` through the root registry, stages files under
`_uploads`, and passes the registered project root and registry path to
`run_job.py`. The worker classifies each document against the project's company
identity, copies accepted source versions into `raw/`, writes classifications,
chunks, evidence and structured facts into `meta/collection.sqlite3`, and
leaves derived artifacts under `generated/`. Company conflicts retain their
`company_conflict` classification metadata and warning, but are still parsed
and added to searchable chunks in the selected project.

Set up once in WSL:

```bash
bash services/pe-ingest/setup.sh
```

The vendored `pipeline/` modules originate from
`pravite_fund_ai_research/FinSagent/data_pipeline` and should be updated
together so their schema and classifier contracts remain aligned.
