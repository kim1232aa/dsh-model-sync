# dsh-model-sync

DeepSeek Harness (DSH) plugin: automatically discover online models from custom and relay gateways, align capabilities against [models.dev](https://models.dev), and provide an interactive one-click refresh button in the Models settings page.

---

## Features

- **Models Page Refresh Button**: Injects an interactive refresh button directly into the DSH Models settings panel and capability headers. Features hover animation, loading state, and toast notification summaries.
- **Context Truncation Protection**: Prevents relay pricing cutoff ceilings (e.g. 272k or 128k) from shrinking true model context windows (e.g., restoring `gpt-6-astra` to its official 1,050,000 window).
- **Fuzzy Gateway Label Stripping**: Normalizes bracket tags (`[1m]`), routing suffixes (`-review`, `-sol`, `-luna`), and tier variants (`-high`, `-low`, `-tiered`) to match official specifications reliably.
- **DSH-Valid Output Only (v1.1.0)**: Writes only fields the DSH model profile accepts (`id`, `name`, `contextWindow`, `maxTokens`, `input` = `text`/`image`, `reasoningEfforts`). Non-reasoning models get `reasoningEfforts: false`; reasoning models get only real DSH levels (`off`..`max`) from models.dev, never an `off`-only dict and never invented levels.
- **Write Safety (v1.1.0)**: Every row is validated against DSH's own rules before writing; invalid rows and non-chat ids (embedding/TTS/image/moderation) are skipped and reported. Nothing is written when nothing changed, a failed gateway fetch is reported as an error instead of rewriting the catalog, and each provider is written independently.
- **Legacy Repair**: Rows written by 1.0.x (`reasoning`, `thinkingLevelMap`, `thinkingFormat`, `compat.thinkingFormat: "effort"`, which DSH rejects) are healed on the next sync; user-set wire values and custom fields are kept.
- **Credentials**: The gateway key is resolved the way DSH does (`apiKeyEnv` through the credentials service, then the environment variable).
- **Native Cordis Architecture**: Built on Cordis lifecycle, dependency injection, and bundle patches. Supports background scheduled updates and clean unloading.

---

## Installation

Install using the DSH CLI:

```bash
# From npm
dsh plugin --profile web add dsh-model-sync

# From GitHub
dsh plugin --profile web add github:kim1232aa/dsh-model-sync
```

Restart DSH or reload the web interface after installation.

---

## Usage

1. Navigate to **Settings → Models** in the DSH Web UI.
2. The refresh icon will appear in the provider and capability headers.
3. Click the icon to trigger synchronization.
4. A toast shows added / updated / removed counts per provider, "already up to date", skipped models, and per-provider errors.

Dry run (no write): `POST /api/dsh-model-sync/refresh` with body `{"dryRun": true}` from loopback returns the same result list with `wrote: false`.

---

## Uninstallation

```bash
dsh plugin --profile web remove dsh-model-sync
```

---

## License

MIT License
