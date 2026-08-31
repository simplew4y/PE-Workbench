# PE ingest runtime

This local worker vendors the deterministic private-fund ingestion pipeline.
Pi Web writes uploads to the workspace-level `_uploads/<dataset_id>` directory,
starts `run_job.py`, and polls the durable job JSON under the project `meta/`
directory. The generated project root is directly consumable by `pe-boot`.

Set up once in WSL:

```bash
bash services/pe-ingest/setup.sh
```

The vendored `pipeline/` modules originate from
`pravite_fund_ai_research/FinSagent/data_pipeline` and should be updated
together so their schema and classifier contracts remain aligned.
