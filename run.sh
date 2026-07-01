#!/usr/bin/env bash
set -euo pipefail

# ── run.sh ────────────────────────────────────────────────────────────────
# The single command the judges run. It does two things in order:
#   1. generate_features.py — reads CSVs from DATA_DIR, cleans them
#   2. predict.py            — loads the trained model + features, writes
#                               probabilistic forecasts to OUTPUT_PATH
#
# Usage:   ./run.sh <DATA_DIR> <MODEL_PATH> <OUTPUT_PATH>
# Example: ./run.sh ./data ./pickle/model.pkl ./output/predictions.csv
# All three arguments are optional — sensible defaults are used if omitted,
# so this also works locally with just: ./run.sh
# ─────────────────────────────────────────────────────────────────────────

DATA_DIR="${1:-./data}"
MODEL_PATH="${2:-./pickle/model.pkl}"
OUTPUT_PATH="${3:-./output/predictions.csv}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEATURES_PATH="$(mktemp -t features.XXXXXX.parquet 2>/dev/null || echo "${SCRIPT_DIR}/features.parquet")"

mkdir -p "$(dirname "$OUTPUT_PATH")"

echo "── Step 1/2: generating features from ${DATA_DIR} ──"
python3 "${SCRIPT_DIR}/src/generate_features.py" --data-dir "$DATA_DIR" --out "$FEATURES_PATH"

echo "── Step 2/2: loading model + predicting ──"
python3 "${SCRIPT_DIR}/src/predict.py" \
  --features "$FEATURES_PATH" \
  --model "$MODEL_PATH" \
  --data-dir "$DATA_DIR" \
  --output "$OUTPUT_PATH"

rm -f "$FEATURES_PATH"

echo "Done. Predictions written to ${OUTPUT_PATH}"
