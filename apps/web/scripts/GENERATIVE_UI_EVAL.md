# Generative UI evaluation runner

The runner scores captured model outputs without making paid model calls. This keeps regression runs deterministic and lets the same output be compared after protocol, prompt, or renderer changes.

## Result format

Use a JSON array or JSONL file. Each record maps one evaluation case to the structured surface emitted by `pe_render_ui`. Include non-empty `text` and omit `surface` for prose-only responses or a safe refusal. Empty responses fail.

```json
[
  { "caseId": "simple-definition", "text": "归母净利润是归属于母公司股东的净利润。" },
  {
    "caseId": "valuation-scenarios",
    "surface": {
      "version": 1,
      "component": {
        "kind": "valuation_range",
        "title": "基准情景存在上行空间",
        "unit": "HKD/share",
        "scenarios": [
          { "label": "悲观", "low": 60, "high": 75 },
          { "label": "基准", "low": 95, "high": 110 }
        ]
      }
    }
  }
]
```

## Run

```bash
npm run eval:generative-ui -- --results ./captured-results.json --threshold 80
```

Optional flags:

- `--cases <path>` selects another case catalog.
- `--threshold <0-100>` sets the required average score.

The command fails when a result is missing, violates the protocol, uses a forbidden component, misses a required component, chooses the wrong composition mode, or repeats a component kind inside a research brief. CI can use its exit code as a regression gate.

`adaptive` accepts prose or a leaf visual, but not an unsolicited research brief. It does not reward using more components. `prose` rejects every UI type. Interaction defaults to static; `explore` fails unless the case explicitly sets `allowInteraction: true`. Specific component requirements are reserved for explicit format requests.

This is a structural regression check, not a factuality or design-quality score. Human review must still assess whether the chosen visual reduces reading effort, whether prose duplicates it, whether evidence is sound, whether essential information is visible without clicking, and whether desktop/mobile and light/dark presentation are readable. Adaptive acceptance does not prove that UI was necessary. No live model calls are made by this runner.
