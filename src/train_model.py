"""
train_model.py — Builds and saves the "model" the judges' pipeline will load.

In plain terms: this script looks at historical data once, works out each
channel's typical ROAS, how much that ROAS bounces around, and whether it's
trending up or down — then saves those numbers to disk as pickle/model.pkl
so predict.py can load them instantly later without recalculating from
scratch every time.

This only needs to be run once, by us, before submitting. The judges' test
run does NOT re-run this file — per the submission rules, they only run
generate_features.py + predict.py against their own held-out data.
"""

import argparse
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forecast_lib import build_stats, clean_rows, load_and_normalize_data_dir  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Train (fit) channel-level forecasting priors and pickle them.")
    parser.add_argument("--data-dir", default="./data", help="Folder containing historical channel CSVs")
    parser.add_argument("--out", default="./pickle/model.pkl", help="Where to write the pickled model")
    args = parser.parse_args()

    print(f"Reading historical data from {args.data_dir} ...")
    df = load_and_normalize_data_dir(args.data_dir)
    df = clean_rows(df)
    print(f"  -> {len(df)} clean rows across {df['channel'].nunique()} channels")

    print("Fitting channel-level priors (spend-weighted ROAS, volatility, trend) ...")
    stats = build_stats(df)
    for ch, s in stats.items():
        print(f"  {ch}: avg_roas={s.avg_roas:.2f}x  std_roas={s.std_roas:.3f}  trend={s.trend_pct:+.1f}%")

    model = {
        "version": "1.0",
        "channel_stats": stats,
        "trained_on_rows": len(df),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        pickle.dump(model, f)
    print(f"\nSaved model to {out_path}")


if __name__ == "__main__":
    main()
