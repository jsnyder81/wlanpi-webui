# Vendored Protocol Contract

This directory contains the vendored WebSocket protocol contract from `wlanpi-menud`.

- **Vendored Schema**: `protocol/frames.schema.json`
- **Source**: `wlanpi-menud` at commit `298b81f8ded39da62cf0b748e7209061950a4f3e`
- **Synced At**: 2026-11-09 04:44:36Z
- **Generated Types**: `wlanpi_webui/static/js/types/frames.d.ts`

## Synchronization

When the protocol contract changes in `wlanpi-menud`, re-sync by running:

```bash
./scripts/vendor-sync.sh [path-to-wlanpi-menud] [optional-commit-sha]
```

The script copies `frames.schema.json`, updates this README with the commit SHA,
and runs `scripts/generate-types.sh` to update the TypeScript definitions.
CI enforces that `wlanpi_webui/static/js/types/frames.d.ts` matches `protocol/frames.schema.json`.
