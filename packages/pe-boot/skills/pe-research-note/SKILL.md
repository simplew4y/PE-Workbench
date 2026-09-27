---
name: pe-research-note
description: Create a persistent, evidence-backed PE Research Note as HTML. Use only for an explicit Research Note request or an unambiguous request to save research as a project asset; not for ordinary QA, retrieval, summaries, or analysis.
---

# PE Research Note

Create one focused Research Note from evidence in the current project workspace.

## Invocation gate

Load and use this Skill only when the current user request provides one of these signals:

- Explicit: the user asks to create, generate, produce, or save a Research Note, or invokes `/skill:pe-research-note`.
- Implicit but unambiguous: the user asks to generate, save, archive, or write a persistent research artifact in the project, even without using the term Research Note.

Do not use this Skill for an ordinary question, data lookup, source search, conversational summary, or analysis request. A topic being suitable for metrics, a table, or a chart is not authorization to create a persistent asset.

If the persistence intent is unclear, answer in the conversation. Do not proactively create an asset.

## Managed directory

Every note is a separate immutable asset:

```text
generated/research-notes/<research_note_id>.html
```

- `pe_research_note_save` generates the ID and path. Never choose a path or overwrite an earlier note.
- Treat `generated/research-notes/` as tool-managed. Do not rename, move, overwrite, or manually delete its files.
- This workflow has no revision, version, history, selection, or deletion operation. A later request creates another Research Note.

## Presentation mode

Follow an explicit user choice. Otherwise choose the single form that communicates the result most clearly:

- `text`: evidence-led narrative when structure or interpretation matters most.
- `metrics`: a small set of verified key indicators with periods, units, and interpretation.
- `table`: exact comparisons across periods, scenarios, companies, or categories.
- `chart`: a verified comparable numeric series where shape or change is the main insight.

Do not add a chart or table when it does not improve comprehension.

## Workflow

1. Define the question, scope, periods, units, and appropriate presentation mode.
2. Discover PDF filenames with `pe_pdf_list`; use `pe_pdf_search` with literal term variants and follow `next_page_offset` when more matches are needed. For Excel, select one active workbook with `pe_workbook_inspect` and use `pe_excel_range` for exact financial cells. Use `pe_document_open` and native `read`/`grep` for the selected workbook text view or supported Office/text documents.
3. Verify decisive, numerical, conflicting, table, metric, and chart evidence before using it. Use `pe_pdf_read` for PDF pages, including neighboring pages when a statement crosses a boundary; use `pe_source_detail` for exact Excel ranges or Office/text locations. Follow the pe-valuation-model-explainer Skill for valuation outputs, dates, formula traces, and model validation.
4. Separate sourced facts from interpretation. Mark missing coverage, ambiguous units, conflicting figures, and unverified statements visibly as `资料未覆盖` or `待复核`.
5. Generate one complete Simplified Chinese HTML document. Keep CSS, data, and scripts inline. Use native SVG or Canvas for charts and include a readable textual or data-table fallback.
6. Do not use CDNs, external resources, network requests, forms, navigation, downloads, local or session storage, or access to `parent` or `top`.
7. Show a human-readable source marker for every material fact and every value in metrics, tables, and charts. Retain the exact `page:` and `source:` IDs used, or previously returned `cell:` and `fact:` IDs. Preserve the document version; never replace a historical citation with a newer version.
8. Call `pe_research_note_save` exactly once with the complete HTML and all evidence IDs.
9. Report the returned ID, mode, path, and every unresolved evidence ID. Do not describe a note with unresolved evidence as fully verified.

Stop after the Research Note is saved and its evidence warnings are reported.
