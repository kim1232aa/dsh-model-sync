# dsh-model-sync

DeepSeek Harness (DSH) plugin: automatically discover online models from custom and relay gateways, align capabilities against [models.dev](https://models.dev), and provide an interactive one-click refresh button in the Models settings page.

---

## Features

- **Models Page Refresh Button**: Injects an interactive refresh button directly into the DSH Models settings panel and capability headers. Features hover animation, loading state, and toast notification summaries.
- **Context Truncation Protection**: Prevents relay pricing cutoff ceilings (e.g. 272k or 128k) from shrinking true model context windows (e.g., restoring `gpt-6-astra` to its official 1,050,000 window).
- **Fuzzy Gateway Label Stripping**: Normalizes bracket tags (`[1m]`), routing suffixes (`-review`, `-sol`, `-luna`), and tier variants (`-high`, `-low`, `-tiered`) to match official specifications reliably.
- **UI Consistency Invariant**: Ensures `reasoning: true` whenever thinking options exist, and completely strips thinking maps when reasoning is disabled, preventing UI rendering mismatches.
- **Native Cordis Architecture**: Built on Cordis lifecycle, dependency injection, and bundle patches. Supports background scheduled updates and clean unloading.

---

## Installation

Install using the DSH CLI:

```bash
# From npm
dsh plugin --profile web add dsh-model-sync

# From GitHub
dsh plugin --profile web add github:your-username/dsh-model-sync
```

Restart DSH or reload the web interface after installation.

---

## Usage

1. Navigate to **Settings → Models** in the DSH Web UI.
2. The refresh icon will appear in the provider and capability headers.
3. Click the icon to trigger synchronization.
4. A notification toast will display the number of added and updated models.

---

## Uninstallation

```bash
dsh plugin --profile web remove dsh-model-sync
```

---

## License

MIT License
