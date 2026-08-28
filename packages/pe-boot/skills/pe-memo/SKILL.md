---
name: pe-memo
description: Create or revise an evidence-backed private-equity research Memo with Citation Gate, immutable versions, and section-level history comparison. Use for every request to generate, update, correct, extend, version, or compare a focused investment Memo in the current PE project.
---

# PE Memo

Produce a focused, client-facing Memo from evidence in the current project workspace.

## Managed directory

Memo artifacts use this fixed structure:

```text
generated/memo/
└── <memo_series_id>/
    ├── v1/
    │   ├── memo.md
    │   ├── memo.html
    │   ├── memo.pdf
    │   └── citation-gate.json
    └── v2/
        └── ...
```

- `memo_series_id` identifies one stable canonical topic.
- `vN` is an immutable snapshot. A revision creates the next directory and never overwrites an older version.
- `memo.md`, `memo.html`, and `memo.pdf` are user-visible outputs. `citation-gate.json` records evidence validation.
- Treat `generated/memo/` as tool-managed: do not rename, move, overwrite, or manually delete its series, version directories, or files.
- Do not create a parallel Memo directory. Use `pe_history_compare`, not filenames, as the authority for series and version identity.

## Create workflow

1. Identify one stable canonical topic, a client-facing title, the requested scope, and the questions the Memo must answer.
2. Use `pe_dataset_search` for each unresolved evidence area. Enable metric facts for financial or valuation claims.
3. Use `pe_source_detail` on decisive, numerical, conflicting, or source-sensitive evidence before treating it as verified.
4. Separate sourced facts, interpretations, counterevidence, risks, and open questions. Preserve exact dates, periods, currencies, units, and scenarios.
5. Build `memo_claims` as the complete desired Memo. Each item is one claim with a section, plain text, status, and exact evidence IDs. Do not put citation syntax in `text`.
6. Call `pe_dataset_memo` with `operation=create`.
7. Read `citation_gate`. Do not call a Memo fully verified when `needs_review` is true. Report the affected gaps with the returned Memo series ID, version ID, version number, and artifact paths.

Creating the same canonical topic again returns its current version. Use a revision when the user intends to update it.

## Revision workflow

You decide from the user's meaning whether the request is a revision. Updating, correcting, extending, or refreshing an existing Memo requires `operation=revise`.

1. Resolve the exact target `mv_...` ID. Use `pe_history_compare` with `operation=list` when it is not already explicit. If multiple Memos could be the target, ask instead of guessing.
2. Use `pe_history_compare` with `operation=get` to inspect the target version and its sections.
3. Keep the canonical topic unchanged. Put requested changes in `instructions`; do not append “revised”, a date, or a version number to the topic.
4. Retrieve and verify evidence needed for new or changed claims. Reuse an old evidence ID only when it still supports the retained claim.
5. Submit the full desired Memo snapshot, not a patch, to `pe_dataset_memo` with `operation=revise` and `revision_of=<exact mv_... ID>`.
6. Verify that `revision_of_version_id` matches the target and that the version number advanced.
7. Call `pe_history_compare` with `operation=compare`. Report `added`, `changed`, `unchanged`, and `not_mentioned` separately. `not_mentioned` means absent from the new Memo; it does not mean removed, invalidated, or withdrawn.

## Citation Gate

- `supported`: use only exact `chunk:`, `fact:`, or `cell:` IDs returned by PE retrieval tools. Every material fact, date, amount, ratio, valuation input, forecast, and management statement needs evidence.
- `not_covered`: use when the current project materials do not cover the claim. Pass no evidence IDs.
- `needs_review`: use for an interpretation or unresolved point that must not be presented as verified.
- The service validates every ID and owns citation rendering. Missing or invalid evidence on a `supported` claim is downgraded to `needs_review`; never invent or repair an ID yourself.
- Keep generation instructions, conversation context, key questions, version-control details, database paths, and filesystem paths out of client-facing Memo sections.

Stop when the requested Memo operation, Citation Gate review, and required version comparison are complete.
