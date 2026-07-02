"""
features.py — Feature engineering shared between training and prediction.

Every feature computed here must be computable from:
  - the raw row itself (spend, clicks, impressions, channel, campaign_type, date)
  - aggregates over the TRAINING set only (encodings, rolling stats)

No future data is used. No leakage.
"""

import numpy as np
import pandas as pd

# Campaign type normalisation — collapse platform-specific variants into
# clean buckets so the model sees consistent categories
CTYPE_MAP = {
    "performance max": "performance_max",
    "performancemax":  "performance_max",
    "search":          "search",
    "shopping":        "shopping",
    "prospecting":     "prospecting",
    "retargeting":     "retargeting",
    "video":           "video",
    "display":         "display",
    "demand gen":      "demand_gen",
    "audience":        "audience",
    "other":           "other",
}

CHANNEL_MAP = {"Google Ads": 0, "Meta Ads": 1, "MS Ads": 2}

FEATURE_COLS = [
    "channel_enc",
    "campaign_type_enc",
    "spend",
    "clicks",
    "impressions",
    "conversions",
    "month",
    "day_of_week",
    "quarter",
    "spend_log",
    "clicks_log",
    "ctr",               # clicks / impressions — ad relevance signal
    "cpc",               # spend / clicks — cost efficiency
    "channel_monthly_roas",   # rolling channel ROAS from training history
    "ctype_monthly_roas",     # rolling campaign-type ROAS
]


def normalise_ctype(s):
    return CTYPE_MAP.get(str(s or "").strip().lower(), "other")


def engineer_features(df: pd.DataFrame, roas_lookup: dict = None) -> pd.DataFrame:
    """
    Takes a canonical-schema DataFrame and returns a feature matrix
    aligned to FEATURE_COLS.

    roas_lookup: dict produced by build_roas_lookup() from training data.
    If None (e.g. at inference time without history), defaults to 1.0.
    """
    out = pd.DataFrame(index=df.index)

    # Date features
    dates = pd.to_datetime(df["date"], errors="coerce")
    out["month"]       = dates.dt.month.fillna(6).astype(int)
    out["day_of_week"] = dates.dt.dayofweek.fillna(0).astype(int)
    out["quarter"]     = dates.dt.quarter.fillna(2).astype(int)

    # Channel + campaign type encoding
    out["channel_enc"]       = df["channel"].map(CHANNEL_MAP).fillna(-1).astype(int)
    out["campaign_type_enc"] = df["campaign_type"].map(normalise_ctype).map(
        {k: i for i, k in enumerate(sorted(set(CTYPE_MAP.values())))}
    ).fillna(0).astype(int)

    # Raw numeric features — clip negatives just in case
    out["spend"]       = df["spend"].clip(lower=0).fillna(0)
    out["clicks"]      = df["clicks"].clip(lower=0).fillna(0)
    out["impressions"] = df["impressions"].clip(lower=0).fillna(0)
    out["conversions"] = df["conversions"].clip(lower=0).fillna(0)

    # Log-transform spend and clicks (reduces impact of outlier campaigns)
    out["spend_log"]  = np.log1p(out["spend"])
    out["clicks_log"] = np.log1p(out["clicks"])

    # Derived ratios
    out["ctr"] = np.where(out["impressions"] > 0, out["clicks"] / out["impressions"], 0)
    out["cpc"] = np.where(out["clicks"] > 0,      out["spend"]  / out["clicks"],      0)

    # Historical ROAS context (from training data lookup)
    if roas_lookup:
        ch_roas   = df["channel"].map(roas_lookup.get("channel", {})).fillna(1.0)
        ctype_key = df["campaign_type"].map(normalise_ctype)
        ct_roas   = ctype_key.map(roas_lookup.get("ctype", {})).fillna(1.0)
    else:
        ch_roas   = pd.Series(1.0, index=df.index)
        ct_roas   = pd.Series(1.0, index=df.index)

    out["channel_monthly_roas"] = ch_roas.values
    out["ctype_monthly_roas"]   = ct_roas.values

    return out[FEATURE_COLS]


def build_roas_lookup(df: pd.DataFrame) -> dict:
    """
    Compute spend-weighted ROAS per channel and per campaign-type
    from the training set. Used to enrich features at both train
    and inference time.
    """
    lookup = {}

    # Channel-level spend-weighted ROAS
    ch = df.groupby("channel").agg(s=("spend","sum"), r=("revenue","sum"))
    lookup["channel"] = (ch["r"] / ch["s"].replace(0, np.nan)).fillna(1.0).to_dict()

    # Campaign-type-level spend-weighted ROAS
    df2 = df.copy()
    df2["_ct"] = df2["campaign_type"].map(normalise_ctype)
    ct = df2.groupby("_ct").agg(s=("spend","sum"), r=("revenue","sum"))
    lookup["ctype"] = (ct["r"] / ct["s"].replace(0, np.nan)).fillna(1.0).to_dict()

    return lookup
