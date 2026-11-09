#!/bin/sh
# Synchronize vendored wlanpi-menud frames.schema.json into wlanpi-webui
# and regenerate TypeScript definitions.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_ARG="${1:-$REPO_DIR/../wlanpi-menud}"
SHA_ARG="${2:-${MENUD_SHA:-}}"

if [ -f "$SOURCE_ARG" ]; then
    SRC_SCHEMA="$SOURCE_ARG"
    SRC_DIR="$(dirname "$SOURCE_ARG")"
elif [ -d "$SOURCE_ARG" ]; then
    if [ -f "$SOURCE_ARG/protocol/frames.schema.json" ]; then
        SRC_SCHEMA="$SOURCE_ARG/protocol/frames.schema.json"
        SRC_DIR="$SOURCE_ARG"
    elif [ -f "$SOURCE_ARG/frames.schema.json" ]; then
        SRC_SCHEMA="$SOURCE_ARG/frames.schema.json"
        SRC_DIR="$SOURCE_ARG"
    else
        echo "Error: frames.schema.json not found under $SOURCE_ARG" >&2
        exit 1
    fi
else
    echo "Error: Source path does not exist: $SOURCE_ARG" >&2
    exit 1
fi

COMMIT_SHA="$SHA_ARG"
if [ -z "$COMMIT_SHA" ]; then
    if git -C "$SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        COMMIT_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
    else
        COMMIT_SHA="unknown"
    fi
fi

DEST_DIR="$REPO_DIR/protocol"
DEST_SCHEMA="$DEST_DIR/frames.schema.json"
DEST_README="$DEST_DIR/README.md"

mkdir -p "$DEST_DIR"
cp "$SRC_SCHEMA" "$DEST_SCHEMA"

SYNC_DATE="$(date -u +"%Y-%m-%d %H:%M:%SZ")"

cat > "$DEST_README" <<EOF
# Vendored Protocol Contract

This directory contains the vendored WebSocket protocol contract from \`wlanpi-menud\`.

- **Vendored Schema**: \`protocol/frames.schema.json\`
- **Source**: \`wlanpi-menud\` at commit \`${COMMIT_SHA}\`
- **Synced At**: ${SYNC_DATE}
- **Generated Types**: \`wlanpi_webui/static/js/types/frames.d.ts\`

## Synchronization

When the protocol contract changes in \`wlanpi-menud\`, re-sync by running:

\`\`\`bash
./scripts/vendor-sync.sh [path-to-wlanpi-menud] [optional-commit-sha]
\`\`\`

The script copies \`frames.schema.json\`, updates this README with the commit SHA,
and runs \`scripts/generate-types.sh\` to update the TypeScript definitions.
CI enforces that \`wlanpi_webui/static/js/types/frames.d.ts\` matches \`protocol/frames.schema.json\`.
EOF

echo "Vendored frames.schema.json from menud commit ${COMMIT_SHA}"

# Regenerate TypeScript types from the updated vendored copy
"$REPO_DIR/scripts/generate-types.sh"
