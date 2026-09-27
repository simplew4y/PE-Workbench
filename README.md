# PE Workbench

Unified Pi workspace and PE Web application. All Pi packages, SDKs, TUI,
extensions, examples and PE business capabilities are retained.

## Development

Use Node 24 LTS for the full workspace (the optional Gondolin example requires
Node >=23.6). Core Pi/Web still declare Node >=22.19.0.

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm run setup:python
npm run dev
```

Web: http://127.0.0.1:30141. Configuration belongs in `apps/web/.env.local`;
start from its `.env.example`, never copy credentials into tracked files.
Python setup is needed for the existing document-analysis features, not native Pi.

Model hydration supports the renamed models.dev Kimi Coding catalog
(`kimi-code-plan-cn`). Run `hydrate:model-data` on a fresh clone before offline
builds; it requires network access. See integration notes for remaining baseline
check failures and verification limits.

For a parallel test server use:
```sh
npm run dev -- --port 30142
```

- `npm run dev:webpack`: alternate development compiler.
- `npm run build:pi`: original Pi online build; `build:offline`: prepared model data.
- `npm run build:web`: production Web build; `build`: Pi then Web.
- `npm run check:pi`, `check:web`, `check:workspace`, `check`: validation.
- `npm run research:doctor`, `research:worker`: existing research services.
- `./pi-test.sh` or `./pi-test.ps1`: PE TUI, preserves caller cwd.
- `node /absolute/path/PE-Workbench/scripts/pi-native.mjs`: native Pi from any cwd.
  Also available as `npm run pi:native -- --help`.

User data remains in the existing Pi agent directory; respect
`PI_CODING_AGENT_DIR`. This is not a data migration or new isolation boundary.

## History and licensing

Web history is the first-parent product lineage. Pi history is merged intact.
See [integration notes](docs/monorepo-integration.md) for pinned commits,
boundaries and validation. Original documentation: [Pi](docs/pi-upstream-README.md)
and [Web](apps/web/README.md). The archived Pi README uses paths relative to the
repository root.

Keep the [Pi license](LICENSE) and [Web license](apps/web/LICENSE).
No npm publishing or former upstream automation is enabled by this integration.
