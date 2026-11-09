#!/bin/sh
# Generate TypeScript definitions from wlanpi-menud protocol frames schema.
# Do not hand-maintain wlanpi_webui/static/js/types/frames.d.ts.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SCHEMA_PATH="${SCHEMA_PATH:-$REPO_DIR/../wlanpi-menud/protocol/frames.schema.json}"
OUTPUT_PATH="$REPO_DIR/wlanpi_webui/static/js/types/frames.d.ts"

if [ ! -f "$SCHEMA_PATH" ]; then
    echo "Error: Schema file not found at $SCHEMA_PATH" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
npx --yes json-schema-to-typescript@16 -i "$SCHEMA_PATH" -o "$OUTPUT_PATH" --unreachableDefinitions

echo "Generated TypeScript types at $OUTPUT_PATH"
