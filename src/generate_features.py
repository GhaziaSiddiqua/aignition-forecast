"""
generate_features.py — Stage 1 of the pipeline.

In plain terms: this script reads whatever CSV files are sitting in the
data folder (the judges will swap in their own test CSVs here), figures out
which ad platform each file came from, cleans up known data-quality issues
(incomplete trailing days, true zero-activity rows), checks the data makes
sense, and saves the result as a single tidy file (features.parquet) that
predict.py reads next.

A .parquet file is just a compact, structured file format for tables of
data — similar idea to a CSV, but smaller and faster for code to read back.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forecast_lib import clean_rows, load_and_normalize_data_dir, validate_campaign_consistency  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Normalize and clean raw channel CSVs into a features file.")
    parser.add_argument("--data-dir", required=True, help="Folder containing input CSV files")
    parser.add_argument("--out", required=True, help="Where to write the features file (parquet)")
    args = parser.parse_args()

    print(f"[generate_features] Reading CSVs from {args.data_dir} ...")
    raw = load_and_normalize_data_dir(args.data_dir)
    print(f"[generate_features] Normalized {len(raw)} rows from "
          f"{raw['channel'].nunique()} channel(s): {sorted(raw['channel'].unique())}")

    report = validate_campaign_consistency(raw)
    if report["issues"]:
        print("[generate_features] Data quality notes:")
        for issue in report["issues"]:
            print(f"  - {issue}")
    else:
        print("[generate_features] No data consistency issues found.")

    clean = clean_rows(raw)
    print(f"[generate_features] {len(clean)} rows remain after cleaning "
          f"(dropped {len(raw) - len(clean)} attribution-lag / zero-activity rows)")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    clean.to_parquet(out_path, index=False)
    print(f"[generate_features] Wrote features to {out_path}")

    # Also drop a small JSON sidecar report next to it — handy for debugging,
    # not required by the contract.
    report_path = out_path.with_suffix(".report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()
