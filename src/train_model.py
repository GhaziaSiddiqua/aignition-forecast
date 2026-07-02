"""
train_model.py — Train an XGBoost regression model to predict revenue
from ad campaign features, and save it to pickle/model.pkl.

This script is run ONCE before submission. The judges do not re-run it —
they only run generate_features.py and predict.py via run.sh.

Usage:
    python3 src/train_model.py --data-dir ./data --out ./pickle/model.pkl
"""

import argparse
import pickle
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
from xgboost import XGBRegressor
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, r2_score

from forecast_lib import (
    load_and_normalize_data_dir, clean_rows,
    build_stats, CHANNELS,
)
from features import engineer_features, build_roas_lookup, FEATURE_COLS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--out",      required=True)
    args = parser.parse_args()

    # ── 1. Load + clean data ──────────────────────────────────────────────
    print("Reading data from", args.data_dir)
    raw = load_and_normalize_data_dir(args.data_dir)
    df  = clean_rows(raw)
    print(f"  {len(df)} clean rows loaded")

    # Sort chronologically — important for time-series cross-validation
    df = df.sort_values("date").reset_index(drop=True)

    # ── 2. Build ROAS lookup from training data ───────────────────────────
    roas_lookup = build_roas_lookup(df)
    print("  ROAS lookup built:")
    for ch, r in roas_lookup["channel"].items():
        print(f"    {ch}: {r:.2f}x")

    # ── 3. Feature engineering ────────────────────────────────────────────
    X = engineer_features(df, roas_lookup)
    y = df["revenue"].values

    print(f"\nFeature matrix: {X.shape[0]} rows × {X.shape[1]} features")
    print("Features:", FEATURE_COLS)

    # ── 4. Time-series cross-validation (no data leakage) ─────────────────
    # We use TimeSeriesSplit so earlier folds are always training data and
    # later folds are always validation data — same as the real-world scenario
    # where we train on the past and predict the future.
    print("\nRunning time-series cross-validation (5 folds)...")
    tscv = TimeSeriesSplit(n_splits=5)
    mae_scores, r2_scores = [], []

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        X_train, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_train, y_val = y[train_idx],       y[val_idx]

        model = XGBRegressor(
            n_estimators=400,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=10,
            reg_alpha=0.1,
            reg_lambda=1.0,
            random_state=42,
            n_jobs=-1,
            verbosity=0,
        )
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )

        preds = model.predict(X_val)
        preds = np.maximum(preds, 0)  # revenue can't be negative

        mae = mean_absolute_error(y_val, preds)
        r2  = r2_score(y_val, preds)
        mae_scores.append(mae)
        r2_scores.append(r2)
        print(f"  Fold {fold+1}: MAE=${mae:.2f}  R²={r2:.3f}")

    print(f"\nCross-val summary:")
    print(f"  Avg MAE : ${np.mean(mae_scores):.2f} ± ${np.std(mae_scores):.2f}")
    print(f"  Avg R²  : {np.mean(r2_scores):.3f} ± {np.std(r2_scores):.3f}")

    # ── 5. Final model — train on ALL data ────────────────────────────────
    print("\nTraining final model on full dataset...")
    final_model = XGBRegressor(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=10,
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=-1,
        verbosity=0,
    )
    final_model.fit(X, y, verbose=False)

    # Feature importance
    importance = dict(zip(FEATURE_COLS, final_model.feature_importances_))
    print("\nTop features by importance:")
    for feat, imp in sorted(importance.items(), key=lambda x: -x[1])[:8]:
        print(f"  {feat:<28} {imp:.4f}")

    # ── 6. Channel-level statistical priors (Monte Carlo fallback) ────────
    channel_stats = build_stats(df)
    print("\nChannel priors (spend-weighted ROAS):")
    for ch in CHANNELS:
        s = channel_stats[ch]
        print(f"  {ch}: {s.avg_roas:.2f}x  std={s.std_roas:.3f}  trend={s.trend_pct:+.1f}%")

    # ── 7. Save everything to pickle ──────────────────────────────────────
    artifact = {
        "version":          "2.0",
        "model":            final_model,
        "roas_lookup":      roas_lookup,
        "channel_stats":    channel_stats,
        "feature_cols":     FEATURE_COLS,
        "trained_on_rows":  len(df),
        "cv_mae_mean":      float(np.mean(mae_scores)),
        "cv_r2_mean":       float(np.mean(r2_scores)),
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "wb") as f:
        pickle.dump(artifact, f)

    print(f"\nSaved model to {args.out}")
    print(f"Pickle size: {os.path.getsize(args.out)/1024:.1f} KB")


if __name__ == "__main__":
    main()
