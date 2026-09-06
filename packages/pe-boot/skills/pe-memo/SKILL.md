---
name: pe-memo
description: Create, revise, version, or compare a persistent, evidence-backed PE Memo. Use only for an explicit or unambiguous Memo request; not for ordinary QA, retrieval, summaries, or analysis.
---

# PE Memo

Produce a focused, client-facing Memo from evidence in the current project workspace.

## Invocation gate

Load and use this Skill only when the current user request provides one of these signals:

- Explicit: the user asks to create, generate, produce, save, revise, update, correct, extend, version, or compare a Memo, or invokes `/skill:pe-memo`.
- Implicit but unambiguous: the user asks to generate, save, revise, version, or compare a persistent investment-research document whose requested form and lifecycle clearly match a Memo, even without using the term Memo.

Do not use this Skill for an ordinary question, data lookup, source search, conversational summary, or analysis request. A topic being suitable for a formal report or having enough evidence is not authorization to create a persistent asset.

If the persistence or Memo intent is unclear, answer in the conversation. Do not proactively create, revise, or version an asset.

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
2. Discover sources with native `ls`/`find`, open selected files with `pe_document_open`, then use native `read`/`grep` on the returned text view. Use `pe_excel_range` for exact financial cells.
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

- `supported`: use only exact `source:` IDs returned by PE retrieval tools. Every material fact, date, amount, ratio, valuation input, forecast, and management statement needs evidence.
- `not_covered`: use when the current project materials do not cover the claim. Pass no evidence IDs.
- `needs_review`: use for an interpretation or unresolved point that must not be presented as verified.
- The service validates every ID and owns citation rendering. Missing or invalid evidence on a `supported` claim is downgraded to `needs_review`; never invent or repair an ID yourself.
- Evidence IDs are internal validation keys only. Never place `source:...` in `text`, section titles, or other client-facing prose.
- User-visible Memo artifacts must show a human-readable source location and the corresponding claim `text`, never the internal evidence ID. Keep IDs only in `evidence_ids` so the service can validate provenance and retain it in Citation Gate metadata.
- Keep generation instructions, conversation context, key questions, version-control details, database paths, and filesystem paths out of client-facing Memo sections.

Stop when the requested Memo operation, Citation Gate review, and required version comparison are complete.
