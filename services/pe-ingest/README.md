# PE ingest runtime

This local worker vendors the deterministic private-fund ingestion pipeline.
The PE project registry is the authority for every upload; browser-supplied
paths never select a dataset. The fixed layout is:

```text
~/.pi/agent/pe-workbench/  # or $PI_CODING_AGENT_DIR/pe-workbench
  datasets.sqlite3
  projects/<dataset_id>/
    generated/
    meta/collection.sqlite3
    raw/
```

Pi Web resolves `dataset_id` through the root registry, writes uploaded files
directly to the registered project's canonical `raw/` directory, and passes the
registered project root and registry path to `run_job.py`. The worker classifies
each document against the project's company identity, writes classifications,
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

## Model-backed analysis

Document classification, issuer attribution and atomic claim extraction share
one OpenAI-compatible endpoint, configured entirely through the environment:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PE_INGEST_LLM_BASE_URL` | OpenAI-compatible base URL, e.g. `https://<host>/private_fund/backend/v1` | unset |
| `PE_INGEST_LLM_API_KEY` | Bearer token for that endpoint | unset |
| `PE_INGEST_LLM_MODEL` | Model or alias to request | `private-fund-default` |
| `PE_INGEST_LLM_TIMEOUT_SECONDS` | Per-request timeout | `90` |
| `PE_INGEST_LLM_MAX_ATTEMPTS` | Attempts per request, retrying 429 and 5xx | `3` |

Leaving the URL or key unset keeps the whole worker deterministic: documents are
still parsed, chunked and indexed, the checklist is still seeded, and every
model-backed step reports `skipped_no_model` instead of failing the job. Prefer
the platform gateway over a vendor endpoint so upstream keys stay server-side.

### Atomic claims

Each document is attributed to an issuing institution and then read once per
analysis question. One claim is one institution's position on one question,
stored with the evidence that supports it:

```text
analysis_checklist_items   通用预设 + ingest 时发掘的公司/行业特有问题
document_issuers           发布机构，未达门限时留在 needs_review
atomic_claims              原子观点，带 evidence_ids 与逐字引文
claim_extraction_runs      幂等台账，键为 (doc_id, item_key, extractor_version)
```

Three rules decide what is stored. An evidence ID that was not supplied to the
model is fabricated and the claim is dropped. A quotation that does not appear
in its cited evidence leaves the claim flagged `review_required` and capped at
low confidence. A number without a unit cannot be aggregated and is flagged.

The run ledger makes re-ingesting free and makes backfill cheap: appending a
newly discovered question leaves every earlier document pending for that one
question, and a failed run stays pending so the next ingest retries it.
Documents whose issuer cannot be resolved are skipped rather than read, because
an unattributed claim cannot enter consensus.
