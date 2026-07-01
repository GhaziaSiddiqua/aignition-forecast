# AIgnition 3.0 — Probabilistic Revenue Forecasting

Python version: 3.12

## What this is

A pipeline that takes historical Google Ads / Meta Ads / Bing (MS Ads) export
CSVs and a future media budget, and produces probabilistic revenue and ROAS
forecasts (P10/P50/P90 ranges) at the aggregate, channel, campaign-type, and
individual-campaign level, for 30/60/90-day windows.

This same forecasting math also powers an interactive companion app
("RevenueIQ") that adds AI-generated executive summaries and lets a user
explore budget scenarios live — that app is for the demo walkthrough; this
repo is the offline, no-network pipeline that gets scored automatically.

## How to run it

```bash
pip install -r requirements.txt
./run.sh ./data ./pickle/model.pkl ./output/predictions.csv
```

That's the whole thing. `run.sh` runs two steps for you:

1. **`src/generate_features.py`** — reads every CSV in `data/`, automatically
   detects which platform each one came from (by its column names, not its
   filename), normalizes them into one common format, runs a few cleaning
   steps (see below), and checks the data for consistency issues.
2. **`src/predict.py`** — loads the trained model from `pickle/model.pkl`,
   combines it with the freshly cleaned data, runs a Monte Carlo simulation,
   and writes `output/predictions.csv`.

No internet access is used or required at run time.

## How the forecast actually works (plain-English version)

For each channel, we look at history and work out:
- **Average ROAS** (revenue per dollar spent) — calculated as *total revenue
  ÷ total spend*, not an average of monthly ratios. This matters: a slow
  month with $5 of spend shouldn't count as equally important as a real
  $50,000 month when figuring out the "typical" performance.
- **How much that ROAS varies** month to month (its volatility).
- **Whether it's trending up or down** over time.

Then we simulate 800 different possible futures (Monte Carlo simulation):
each one picks a slightly different ROAS for each channel (some better than
average, some worse, following a bell-curve), multiplies it by the planned
budget, and totals it up. Sorting all 800 outcomes gives us the P10 ("a
pessimistic but plausible outcome"), P50 ("the most likely outcome"), and
P90 ("an optimistic but plausible outcome").

## Data cleaning

Two automatic cleaning steps run on every input, regardless of which
platform it came from:
- **Attribution-lag trimming** — each channel's most recent ~7 days are
  dropped before computing stats, since ad platforms typically haven't
  finished attributing conversions/revenue for very recent days yet, which
  would otherwise make recent performance look artificially worse. This is
  skipped automatically for sparse/monthly-granularity uploads.
- **Zero-activity row removal** — rows with zero spend, zero clicks, and
  zero revenue (inactive days) are dropped as pure noise.

We also flag (but don't delete) any campaign with under $50 of total
historical spend as "insufficient data" — it's too little to compute a
trustworthy ROAS from, so it's excluded from anomaly detection and from
being used as a baseline for "what's normal," though it still shows up in
the output for transparency.

## The "model" (`pickle/model.pkl`)

This isn't a classifier or regressor in the traditional sense — it's a
saved set of channel-level statistical priors (average ROAS, volatility,
trend) fitted once from our historical training data by `src/train_model.py`.
`predict.py` loads this and uses it in two ways:
1. As context (printed for visibility).
2. As a **fallback** — if a channel in the held-out test data has no rows,
   or too little spend to compute a reliable estimate on its own, the
   pipeline falls back to that channel's trained prior instead of an
   arbitrary constant.

To regenerate it from new training data:
```bash
python3 src/train_model.py --data-dir ./data --out ./pickle/model.pkl
```
(We ran this once ourselves before submitting — the judges' run does not
re-run training, only `generate_features.py` + `predict.py`, per the
contract.)

## Budget input

The `run.sh` contract only provides `DATA_DIR`, `MODEL_PATH`, and
`OUTPUT_PATH` — there's no separate argument for the future budget. So
`predict.py` looks for an optional `data/budget.csv` (columns: `channel,budget`).
If that file isn't present, it falls back to each channel's recent 30-day
average daily spend, projected forward across the forecast window — i.e.
"keep spending roughly what you've been spending."

## Output format

**Placeholder schema** (long format — one row per window/level/channel/
campaign-type/campaign): `forecast_window_days, level, channel,
campaign_type, campaign_name, revenue_p10, revenue_p50, revenue_p90,
roas_p50, budget`. This should be swapped for the official format the
moment it's confirmed — the only place that needs to change is the
`write_predictions()` function in `src/predict.py`.

## Known assumptions / limitations

- Meta Ads' raw export only has one ambiguous `conversion` column (no
  separate revenue field or true conversion-count field) — it's treated as
  a revenue-value proxy. Flagged for confirmation with the organizers.
- GA4 session and Shopify conversion data are not currently ingested —
  per Q&A clarification, only Google/Meta/Bing ad data is required.
- Monte Carlo simulation is seeded (`seed=42`) for reproducibility.

## Repo structure

```
.
├── run.sh                   # entry point
├── requirements.txt
├── data/                    # input CSVs (swapped at test time)
├── pickle/model.pkl         # trained channel-level priors
├── output/predictions.csv   # written on each run
└── src/
    ├── forecast_lib.py      # core forecasting engine (shared logic)
    ├── generate_features.py # stage 1: clean + normalize
    ├── predict.py           # stage 2: forecast + write output
    └── train_model.py       # one-time: fit + pickle the model
```
