# RevenueIQ — Probabilistic Revenue Forecasting

**AIgnition 3.0 Hackathon Submission · NetElixir**

Python version: 3.12 · Tested on: Linux (Ubuntu 24)

---

## What this is

RevenueIQ forecasts e-commerce revenue and ROAS across Google Ads, Meta Ads,
and Microsoft (Bing) Ads using historical campaign export data and a planned
media budget. It produces probabilistic P10/P50/P90 ranges at the aggregate,
channel, campaign-type, and individual campaign level for 30, 60, and 90-day
windows.

**Two surfaces, one shared engine:**
- **Offline pipeline** (`run.sh` → `predictions.csv`) — auto-scored by judges,
  no network calls, fully deterministic, one command
- **Interactive app** (`App.jsx`) — React browser app with live charts, budget
  simulation, and Claude-powered AI insights

---

## Quick start (offline pipeline)

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the full pipeline
./run.sh ./data ./pickle/model.pkl ./output/predictions.csv
```

That's it. Two commands. `predictions.csv` is written to `output/`.

### What `run.sh` does internally
1. **`src/generate_features.py`** — reads every CSV in `data/`, auto-detects
   which ad platform each file came from (by column signature, not filename),
   normalizes them to a common schema, validates consistency, applies cleaning
   rules, writes `features.parquet`
2. **`src/predict.py`** — loads `pickle/model.pkl`, runs XGBoost inference +
   Monte Carlo simulation, writes `predictions.csv`

---

## How to provide budgets

Create `data/budget.csv` with your planned 30-day spend per channel:

```csv
channel,budget
Google Ads,25000
Meta Ads,18000
MS Ads,7000
```

A sample `budget.csv` is included. If the file is missing, the pipeline
falls back to each channel's recent 30-day spend run-rate automatically.

---

## Output format

`predictions.csv` — one row per (channel, campaign_type, campaign_name,
forecast_window_days):

| Column | Description |
|---|---|
| channel | Google Ads / Meta Ads / MS Ads |
| campaign_type | Search / Shopping / Performance Max / etc. |
| campaign_name | Individual campaign |
| spend | Projected spend for the window ($) |
| revenue | Historical revenue ($) |
| conversions, clicks, impressions, sessions, aov | Historical metrics |
| forecast_window_days | 30, 60, or 90 |
| forecasted_revenue_p10 | Conservative revenue forecast ($) |
| forecasted_revenue_p50 | Most likely revenue forecast ($) |
| forecasted_revenue_p90 | Optimistic revenue forecast ($) |
| forecasted_roas_p10/p50/p90 | ROAS ranges |

---

## AI insights (backend function)

> **Note for evaluators:** The AI insights module requires an Anthropic API
> key. Please set your own key via `--api-key` or the `ANTHROPIC_API_KEY`
> environment variable as shown below. The automated scoring pipeline
> (`run.sh`) does **not** require an API key — it runs fully offline.
> The AI layer is demonstrated live in the interactive React app (App.jsx)
> and can also be triggered via this backend function with a valid key.

The `src/ai_insights.py` module calls the Claude API to generate four
analyses from `predictions.csv`: Executive Summary, Anomaly Detection,
Budget Reallocation, and Risk Assessment.

**Command line:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
python3 src/ai_insights.py --predictions output/predictions.csv --window 30

# Save results as JSON:
python3 src/ai_insights.py \
  --predictions output/predictions.csv \
  --output output/insights.json
```

**Programmatic import:**
```python
import pandas as pd
from src.ai_insights import run_all_insights

df = pd.read_csv("output/predictions.csv")
results = run_all_insights(df, api_key="sk-ant-...", window=30)

for name, text in results.items():
    print(f"--- {name} ---")
    print(text)
```

---

## How the forecast works

**Layer 1 — XGBoost ML model**
Trained on 24,015 historical campaign-day rows. Predicts revenue per
campaign from 15 features: spend, clicks, impressions, conversions, CTR,
CPC, channel, campaign type, month, day of week, quarter, log-transformed
spend/clicks, and historical ROAS context from training data.

Cross-validation (5-fold time-series): **MAE = $252.94, R² = 0.659**

**Layer 2 — Monte Carlo simulation**
800 simulations per forecast window. Each draws a channel ROAS from a
normal distribution (mean and std fitted from spend-weighted historical
data), multiplies by the planned budget, applies a trend multiplier.
P10/P50/P90 are the 10th, 50th, and 90th percentiles of all 800 outcomes.
Seeded at 42 — fully reproducible.

**Key design decision — spend-weighted ROAS:**
ROAS is computed as total revenue ÷ total spend, not as an average of
monthly ratios. This prevents a low-spend month with $0 revenue from
dragging down a channel that's genuinely profitable at scale.

---

## Data cleaning (automatic)

Applied to every upload, regardless of file format:
- **Attribution-lag trimming** — drops the trailing 7 days per channel
  (ad platforms take 3-7 days to fully attribute conversions)
- **Zero-activity row removal** — drops rows where spend=0, clicks=0,
  revenue=0 (paused campaign days, pure noise)
- **Thin-campaign flagging** — campaigns with <$50 total spend are marked
  `insufficient_data` and excluded from anomaly detection

---

## Repo structure

```
.
├── run.sh                    # entry point — the one command judges run
├── requirements.txt          # pinned dependencies
├── README.md
├── data/
│   ├── budget.csv            # 30-day budget per channel (edit this)
│   ├── bing_campaign_stats.csv
│   ├── google_ads_campaign_stats.csv
│   └── meta_ads_campaign_stats.csv
├── docs/
│   └── Technical_Documentation.docx
├── pickle/
│   └── model.pkl             # trained XGBoost model + priors
├── output/
│   └── predictions.csv       # written on every run
└── src/
    ├── forecast_lib.py       # core engine: normalizers, cleaning, Monte Carlo
    ├── features.py           # feature engineering (shared train/inference)
    ├── generate_features.py  # pipeline stage 1
    ├── predict.py            # pipeline stage 2
    ├── train_model.py        # one-time training script
    └── ai_insights.py        # backend Claude API integration
```

---

## Re-training the model

The model is already trained and committed. To re-train from new data:

```bash
python3 src/train_model.py --data-dir ./data --out ./pickle/model.pkl
```

---

## Dependencies

```
pandas==2.2.2
numpy==1.26.4
pyarrow==16.1.0
xgboost==3.3.0
scikit-learn==1.8.0
```

Install with: `pip install -r requirements.txt`
