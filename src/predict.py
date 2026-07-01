"""
predict.py — Stage 2 of the pipeline (the part that produces the final answer).

In plain terms: this script loads the saved model (the channel "personality
profiles" from train_model.py), combines them with the cleaned data from
generate_features.py, runs the probabilistic forecast (the Monte Carlo
simulation), and writes the results to a CSV file the judges will open and
score.

IMPORTANT — output format is a placeholder right now. The submission guide
says the output columns must match "the format announced at the launch,"
which we don't have yet. The schema below is a reasonable, defensible
placeholder (covers aggregate / channel / campaign-type / campaign-level
forecasts, as the challenge brief requires) but the column names/layout
should be swapped for the official spec the moment we have it — see the
WRITE_PREDICTIONS function, which is the only place that needs to change.

Future budget input: the run.sh contract only gives us DATA_DIR, MODEL_PATH,
OUTPUT_PATH — no separate budget argument. So this script looks for an
optional `data/budget.csv` (columns: channel,budget) the way it looks for
any other CSV in data/. If no budget file is present, it falls back to a
sensible default: each channel's most recent 30-day average daily spend,
projected forward across the forecast window. This fallback behavior is
documented in the README.
"""

import argparse
import glob
import os
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forecast_lib import CHANNELS, build_forecast  # noqa: E402

FORECAST_WINDOWS = [30, 60, 90]
SEED = 42


def load_model(model_path):
    import pickle
    with open(model_path, "rb") as f:
        return pickle.load(f)


def find_budget_file(data_dir):
    candidates = glob.glob(os.path.join(data_dir, "budget*.csv"))
    return candidates[0] if candidates else None


def derive_budgets(features_df, data_dir):
    """Use an explicit data/budget.csv if present; otherwise fall back to
    each channel's recent daily spend run-rate, projected across 30 days."""
    budget_path = find_budget_file(data_dir)
    if budget_path:
        print(f"[predict] Using budget file: {budget_path}")
        b = pd.read_csv(budget_path)
        return {row["channel"]: float(row["budget"]) for _, row in b.iterrows()}

    print("[predict] No budget.csv found in data/ — falling back to recent "
          "30-day average daily spend per channel, projected forward.")
    budgets = {}
    for ch in CHANNELS:
        chdf = features_df[features_df["channel"] == ch].copy()
        if chdf.empty:
            budgets[ch] = 0.0
            continue
        chdf["date"] = pd.to_datetime(chdf["date"], errors="coerce")
        chdf = chdf.dropna(subset=["date"])
        recent = chdf[chdf["date"] >= chdf["date"].max() - pd.Timedelta(days=30)]
        daily_avg = recent["spend"].sum() / 30 if len(recent) else chdf["spend"].sum() / max(chdf["date"].nunique(), 1)
        budgets[ch] = float(daily_avg * 30)  # baseline 30-day projection; scaled per window below
    return budgets


def write_predictions(all_forecasts, output_path):
    """Writes a long-format CSV: one row per (window, level, channel,
    campaign_type, campaign_name, metric). Placeholder schema — see module
    docstring. Easy to re-shape once the official format is confirmed.
    """
    rows = []
    for days, fc in all_forecasts.items():
        rows.append({
            "forecast_window_days": days, "level": "aggregate", "channel": "ALL",
            "campaign_type": "", "campaign_name": "",
            "revenue_p10": fc["mc"]["p10"], "revenue_p50": fc["mc"]["p50"], "revenue_p90": fc["mc"]["p90"],
            "roas_p50": fc["blended_roas"], "budget": fc["total_budget"],
        })
        for ch, d in fc["channels"].items():
            rows.append({
                "forecast_window_days": days, "level": "channel", "channel": ch,
                "campaign_type": "", "campaign_name": "",
                "revenue_p10": d["revenue_p10"], "revenue_p50": d["revenue_p50"], "revenue_p90": d["revenue_p90"],
                "roas_p50": d["roas"], "budget": d["budget"],
            })
            for ct, c in d["ctypes"].items():
                rows.append({
                    "forecast_window_days": days, "level": "campaign_type", "channel": ch,
                    "campaign_type": ct, "campaign_name": "",
                    "revenue_p10": c["total_revenue"] * 0.81, "revenue_p50": c["total_revenue"],
                    "revenue_p90": c["total_revenue"] * 1.19,
                    "roas_p50": c["avg_roas"], "budget": c["total_spend"],
                })
            for name, c in d["campaigns"].items():
                rows.append({
                    "forecast_window_days": days, "level": "campaign", "channel": ch,
                    "campaign_type": "", "campaign_name": name,
                    "revenue_p10": c["revenue"] * 0.81, "revenue_p50": c["revenue"], "revenue_p90": c["revenue"] * 1.19,
                    "roas_p50": c["roas"], "budget": c["spend"],
                })

    out_df = pd.DataFrame(rows)
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_csv(out_path, index=False)
    print(f"[predict] Wrote {len(out_df)} prediction rows to {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Load the model + features and write probabilistic forecasts.")
    parser.add_argument("--features", required=True, help="Path to features.parquet from generate_features.py")
    parser.add_argument("--model", required=True, help="Path to the pickled model")
    parser.add_argument("--data-dir", default="./data", help="Folder the budget file (if any) lives in")
    parser.add_argument("--output", required=True, help="Where to write predictions.csv")
    args = parser.parse_args()

    print(f"[predict] Loading model from {args.model} ...")
    model = load_model(args.model)
    print(f"[predict] Model version {model.get('version')}, "
          f"trained on {model.get('trained_on_rows')} rows")

    print(f"[predict] Loading features from {args.features} ...")
    features = pd.read_parquet(args.features)

    base_budgets = derive_budgets(features, args.data_dir)
    print(f"[predict] Base (30-day) budgets: {base_budgets}")

    all_forecasts = {}
    for days in FORECAST_WINDOWS:
        scale = days / 30
        budgets = {ch: v * scale for ch, v in base_budgets.items()}
        all_forecasts[days] = build_forecast(
            features, budgets, days, seed=SEED, priors=model.get("channel_stats")
        )
        print(f"[predict] {days}d window -> blended ROAS "
              f"{all_forecasts[days]['blended_roas']:.2f}x, "
              f"P50 revenue ${all_forecasts[days]['mc']['p50']:,.0f}")

    write_predictions(all_forecasts, args.output)


if __name__ == "__main__":
    main()
