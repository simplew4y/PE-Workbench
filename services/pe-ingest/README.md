# PE ingest runtime

This directory contains the optional Python analysis sidecar used by Pi Web's
Node ingestion worker, plus the legacy standalone private-fund ingester.
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

Pi Web resolves `dataset_id` through the root registry and writes uploaded files
to the registered project's canonical `raw/` directory. The production path is
`lib/pe-ingest/worker.mts`: PDFs become `pdf_pages` plus layout artifacts, while
Excel files are prepared through `@earendil-works/pe-boot`. Once those
deterministic writes commit, the worker invokes `analyze_collection.py` against
the same `meta/collection.sqlite3`. Analysis is additive and warning-only: a
missing model, unavailable Python runtime, or model failure cannot roll back a
searchable document.

The legacy `run_job.py` / `pipeline/private_fund_directory_ingest.py` entry
point remains available for standalone directory ingestion. Set it up once in
WSL with:

```bash
bash services/pe-ingest/setup.sh
```

The vendored `pipeline/` modules originate from
`pravite_fund_ai_research/FinSagent/data_pipeline` and should be updated
together so their schema and classifier contracts remain aligned.

## Model-backed analysis

Issuer attribution, atomic claim extraction, question discovery and card
narratives share one OpenAI-compatible endpoint, configured entirely through
the environment:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PE_INGEST_LLM_BASE_URL` | OpenAI-compatible base URL, e.g. `https://<host>/private_fund/backend/v1` | unset |
| `PE_INGEST_LLM_API_KEY` | Bearer token for that endpoint | unset |
| `PE_INGEST_LLM_MODEL` | Model or alias to request | `private-fund-default` |
| `PE_INGEST_LLM_TIMEOUT_SECONDS` | Per-request timeout; a 20k-character window on a reasoning model takes minutes | `600` |
| `PE_INGEST_LLM_MAX_ATTEMPTS` | Attempts per request, retrying 429 and 5xx | `3` |
| `PE_INGEST_LLM_EXTRA_BODY` | JSON object merged into every request, for vendor fields such as `{"enable_thinking": false}` on DashScope Qwen models (reasoning makes a 20k-character window take 10+ minutes) | unset |
| `PE_INGEST_ANALYSIS_PYTHON` | Python executable for `analyze_collection.py`; otherwise the document/Excel Python setting and then the platform default are tried | unset |
| `PE_INGEST_ANALYSIS_DISABLED` | Set to `1` to skip the analysis sidecar entirely | unset |

Leaving the URL or key unset keeps the whole worker deterministic: documents are
still parsed and indexed, the checklist is still seeded, and every
model-backed step reports `skipped_no_model` instead of failing the job. Prefer
the platform gateway over a vendor endpoint so upstream keys stay server-side.

### Atomic claims

Every newly indexed PDF is read once after its page index commits. Its
`pdf_pages` are packed, in order, into windows of
`PE_INGEST_SCAN_WINDOW_CHARS` characters (default 20000, at
most `PE_INGEST_SCAN_MAX_WINDOWS` = 12 windows) and each window goes to the
model with the project's whole analysis checklist. The model returns the
document's issuer and cover date (first window only), the atomic claims it
found, and any question the checklist lacks. This is one model scan, not a
second question-extraction pass. One claim is one institution's
judgment on one question, stored with the evidence that supports it:

```text
analysis_checklist_items   通用预设 22 条 + 发掘出的公司/行业特有问题
checklist_proposals        文档提出的新问题，每次 ingest 结束时归并一次
issuers                    项目内机构注册表：内置券商别名表 + 首次出现即登记
document_issuers           文档归属：机构、发布日期、as_of 日期及各自来源
atomic_claims              原子观点：原文数值 + 归一数值、期间、证据、状态、修订链
document_scans             扫描台账，键为 (doc_id, extractor_version, 扫描时间)
```

**Discovery.** A claim the checklist does not cover is tagged with a proposed
question instead of being forced into the nearest preset. After all documents
of an ingest are scanned, one model call folds the pending proposals into the
checklist: a rewording of an existing item is merged, duplicates get one key,
a genuine new dimension becomes an item. Claims extracted under a proposal are
re-keyed to the canonical item; no document is read a second time. Without a
model, proposals with the same normalized key become one item each.

**Attribution.** The issuer is whatever institution signed the document. The
deterministic PDF metadata (especially a filename-prefixed brokerage) takes
precedence, then the model's cover/header/disclaimer reading is used. `issuers` maps known
spellings of one house to one key and registers unknown houses on first
sight; nothing is skipped for being unfamiliar. Documents the company wrote
(annual reports, announcements, earnings calls, by document subtype) are
attributed to the fixed key `company` so guidance and sell-side views can be
compared or separated later. A reviewer's manual attribution
(`set_issuer_manually`) is never overwritten by a rescan.

**Dates.** `published_date` comes from a labeled date line (报告日期 …), then
deterministic PDF metadata, the cover date the model read, and finally a full date in the filename; bare dates in
the header are ignored because the first date on a cover is as often the fiscal
period as the publication date. `as_of_date` is the published date when known
and otherwise the ingest day, with `as_of_source` saying which.

**Numbers.** The model copies `value_numeric` and `unit` as printed. The
pipeline canonicalizes deterministically: currency amounts to `元` with the
currency kept separately, percentages to `%` on the 0-100 scale, percentage
points to `pp`, multiples to `x`; periods to `FY2026`, `2026H2`, `2026Q3` or
`FY2026-FY2028`. Prices and volumes keep their printed unit.

**Grounding.** An evidence ID that was not in the window is fabricated and the
claim is dropped, as is a claim tagged with a question that is neither on the
checklist nor proposed in that window. A quotation absent from its cited page
leaves the claim `quote_unverified` or `review_required` with confidence
capped at 0.4. A number without a unit, or a forecast without a period, is
flagged.

**History.** Claims carry a `status`: `active`, `replaced` (a later scan of
the same document), `superseded` (a newer document version), `withdrawn` (the
document was removed). Within a series of `(issuer, item, period, measure)`,
each active claim links to the same institution's latest earlier claim from a
different document through `supersedes_claim_id`, with
`revision_direction` (`new`, `up`, `down`, `unchanged`, `changed`) and the
canonical `revision_delta`. Chains are rebuilt from as-of dates, so documents
ingested out of order still link correctly.

A document with a completed scan for the current `extractor_version` is not
read again, so re-ingesting an unchanged project makes no model calls. A
failed scan is retried on the next ingest.

### Consensus and divergence cards

After the scan, `consensus_cards.py` rebuilds one card per checklist question
(and per period for quantitative questions) into `consensus_cards`:

```text
card_type        consensus | divergence | single_view
stats            median / mean / range / spread over the latest view of each institution
bull, bear       the two highest and two lowest forecasts (or the bullish/bearish sides) with reasons
stance_counts    bullish / bearish / neutral among the latest views
recent_changes   upward and downward revisions inside the last 30 days
company_view     the company's own guidance, kept out of the sample
narrative        title, consensus line, root cause, financial impact, evidence to verify
sources          every claim on the card with evidence IDs (normally page:<page_id>) and quotes
```

Only the latest active claim per institution enters the sample; claims flagged
`review_required` are counted but excluded; values in a different unit or
currency from the majority are excluded and counted. A numeric sample is
divergent when its range exceeds 15% of the median (3pp for percentages);
a stance-only sample is divergent when both sides are present. The model writes
the prose from the computed numbers in one call per 12 cards; without a model
a template renders the same fields. Cards are served by
`GET /api/pe/consensus?datasetId=...` and by the `pe_consensus_cards` agent
tool in pe-boot.
