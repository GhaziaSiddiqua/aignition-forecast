"""
predict.py — Step 2 of the pipeline.

Loads the trained XGBoost model + channel priors from model.pkl,
applies them to the cleaned feature set, and writes predictions.csv.

Output format (per organizer confirmation):
  Same columns as the input training data, PLUS forecasted metrics:
  forecasted_revenue_p10, forecasted_revenue_p50, forecasted_revenue_p90,
  forecasted_roas_p10, forecasted_roas_p50, forecasted_roas_p90,
  forecast_window_days

Usage:
    python3 src/predict.py --features features.parquet \
                           --model pickle/model.pkl \
                           --data-dir ./data \
                           --output ./output/predictions.csv
"""

import argparse
import os
import pickle
import sys
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd

from forecast_lib import build_forecast, CHANNELS, clean_rows, load_and_normalize_data_dir
from features import engineer_features, FEATURE_COLS

FORECAST_WINDOWS = [30, 60, 90]
SEED = 42


def load_budgets(data_dir: str, df: pd.DataFrame) -> dict:
    """Load budgets from data/budget.csv if present, otherwise fall back
    to each channel's recent 30-day average daily spend × 30."""
    budget_path = os.path.join(data_dir, "budget.csv")
    if os.path.exists(budget_path):
        bdf = pd.read_csv(budget_path)
        budgets = dict(zip(bdf["channel"], bdf["budget"]))
        print(f"[predict] Loaded budgets from {budget_path}: {budgets}")
        return budgets

    # Fallback: use recent 30-day run-rate per channel
    df2 = df.copy()
    df2["date"] = pd.to_datetime(df2["date"], errors="coerce")
    cutoff = df2["date"].max() - pd.Timedelta(days=30)
    recent = df2[df2["date"] >= cutoff]
    budgets = {}
    for ch in CHANNELS:
        ch_spend = recent[recent["channel"] == ch]["spend"].sum()
        budgets[ch] = float(ch_spend) if ch_spend > 0 else 0.0
    print(f"[predict] No budget.csv found — using 30-day run-rate: {budgets}")
    return budgets


def predict_with_model(model_artifact: dict, features_df: pd.DataFrame,
                       raw_df: pd.DataFrame) -> pd.DataFrame:
    """
    Use the XGBoost model to predict revenue for each row in features_df,
    then derive ROAS. Returns raw_df with prediction columns added.
    """
    xgb_model   = model_artifact["model"]
    roas_lookup = model_artifact.get("roas_lookup", {})
    feat_cols   = model_artifact.get("feature_cols", FEATURE_COLS)

    X = engineer_features(raw_df, roas_lookup)[feat_cols]
    preds = np.maximum(xgb_model.predict(X), 0)  # revenue >= 0

    out = raw_df.copy()
    out["ml_predicted_revenue"] = preds
    out["ml_predicted_roas"]    = np.where(
        out["spend"] > 0, preds / out["spend"], 0
    )
    return out


def build_forecast_rows(raw_df: pd.DataFrame, predicted_df: pd.DataFrame,
                        model_artifact: dict, budgets: dict) -> pd.DataFrame:
    """
    Build the final output: one row per (channel, campaign_type, campaign_name,
    forecast_window_days) with the original training-data columns PLUS
    the forecasted revenue and ROAS P10/P50/P90 ranges.

    Per organizer confirmation: output has same columns as training data
    plus the forecasted metrics.
    """
    channel_stats = model_artifact.get("channel_stats", {})
    all_rows = []

    for days in FORECAST_WINDOWS:
        scale = days / 30
        window_budgets = {ch: (budgets.get(ch) or 0) * scale for ch in CHANNELS}

        # Monte Carlo for probabilistic ranges
        fc = build_forecast(raw_df, window_budgets, days, seed=SEED,
                            priors=channel_stats)

        # Group by channel + campaign_type + campaign_name and aggregate
        grp = predicted_df.groupby(
            ["channel", "campaign_type", "campaign_name"], dropna=False
        ).agg(
            spend        =("spend",       "sum"),
            revenue      =("revenue",     "sum"),
            conversions  =("conversions", "sum"),
            clicks       =("clicks",      "sum"),
            impressions  =("impressions", "sum"),
            sessions     =("sessions",    "sum"),
            aov          =("aov",         "mean"),
        ).reset_index()

        for _, row in grp.iterrows():
            ch   = row["channel"]
            hist_spend   = row["spend"]
            hist_revenue = row["revenue"]

            # Scale historical spend proportionally to the forecast window budget
            ch_budget     = window_budgets.get(ch, 0)
            ch_hist_spend = predicted_df[predicted_df["channel"]==ch]["spend"].sum()
            spend_scale   = (ch_budget / ch_hist_spend) if ch_hist_spend > 0 else 1.0

            # Base forecast from XGBoost prediction × budget scaling
            base_rev_p50 = hist_revenue * spend_scale

            # P10/P90 band from Monte Carlo uncertainty range
            ch_fc = fc["channels"].get(ch, {})
            if ch_fc and ch_fc.get("revenue_p50", 0) > 0:
                share = (hist_revenue / max(
                    predicted_df[predicted_df["channel"]==ch]["revenue"].sum(), 1
                ))
                rev_p50 = ch_fc["revenue_p50"] * share
                rev_p10 = ch_fc["revenue_p10"] * share
                rev_p90 = ch_fc["revenue_p90"] * share
            else:
                rev_p50 = base_rev_p50
                rev_p10 = base_rev_p50 * 0.81
                rev_p90 = base_rev_p50 * 1.19

            forecast_spend = hist_spend * spend_scale

            all_rows.append({
                # Original training data columns
                "channel":       ch,
                "campaign_type": row["campaign_type"],
                "campaign_name": row["campaign_name"],
                "spend":         round(forecast_spend, 2),
                "revenue":       round(hist_revenue, 2),
                "conversions":   round(row["conversions"], 2),
                "clicks":        round(row["clicks"], 2),
                "impressions":   round(row["impressions"], 2),
                "sessions":      round(row["sessions"], 2),
                "aov":           round(row["aov"], 2),
                # Forecasted metrics
                "forecast_window_days":      days,
                "forecasted_revenue_p10":    round(max(rev_p10, 0), 2),
                "forecasted_revenue_p50":    round(max(rev_p50, 0), 2),
                "forecasted_revenue_p90":    round(max(rev_p90, 0), 2),
                "forecasted_roas_p10":       round(rev_p10 / max(forecast_spend, 1), 4),
                "forecasted_roas_p50":       round(rev_p50 / max(forecast_spend, 1), 4),
                "forecasted_roas_p90":       round(rev_p90 / max(forecast_spend, 1), 4),
            })

    return pd.DataFrame(all_rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--features",  required=True)
    parser.add_argument("--model",     required=True)
    parser.add_argument("--data-dir",  required=True)
    parser.add_argument("--output",    required=True)
    args = parser.parse_args()

    # Load model
    print(f"[predict] Loading model from {args.model}")
    with open(args.model, "rb") as f:
        model_artifact = pickle.load(f)
    print(f"  Model version: {model_artifact.get('version','?')}")
    print(f"  Trained on: {model_artifact.get('trained_on_rows','?')} rows")
    print(f"  CV MAE: ${model_artifact.get('cv_mae_mean',0):.2f}  "
          f"R²: {model_artifact.get('cv_r2_mean',0):.3f}")

    # Load cleaned features
    print(f"\n[predict] Loading features from {args.features}")
    raw_df = pd.read_parquet(args.features)
    print(f"  {len(raw_df)} rows")

    # Budgets
    budgets = load_budgets(args.data_dir, raw_df)

    # XGBoost predictions
    print("\n[predict] Running XGBoost predictions...")
    predicted_df = predict_with_model(model_artifact, None, raw_df)
    print(f"  Predicted revenue range: "
          f"${predicted_df['ml_predicted_revenue'].min():.2f} – "
          f"${predicted_df['ml_predicted_revenue'].max():.2f}")

    # Build final forecast output
    print("\n[predict] Building probabilistic forecast output...")
    output_df = build_forecast_rows(raw_df, predicted_df, model_artifact, budgets)
    print(f"  {len(output_df)} output rows "
          f"({len(output_df)//len(FORECAST_WINDOWS)} groups × {len(FORECAST_WINDOWS)} windows)")

    # Write output
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    output_df.to_csv(args.output, index=False)
    print(f"\n[predict] Written to {args.output}")
    print("\nSample output:")
    print(output_df[output_df["forecast_window_days"]==30].head(3).to_string(index=False))


if __name__ == "__main__":
    main()
