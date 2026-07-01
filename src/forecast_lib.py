"""
forecast_lib.py — Core forecasting engine for the AIgnition 3.0 submission.

This is a Python port of the same forecasting logic already validated in the
interactive React prototype (RevenueIQ): platform-specific CSV normalizers,
data cleaning (attribution-lag trimming + zero-activity row removal),
spend-weighted ROAS / trend statistics, and Monte Carlo probabilistic
simulation. Keeping the math identical across both surfaces means the
offline scored pipeline and the interactive demo agree with each other.

No network calls. No randomness without a seed. Pure pandas/numpy.
"""

import glob
import os
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

CANONICAL_COLUMNS = [
    "date", "channel", "campaign_type", "campaign_name",
    "spend", "revenue", "conversions", "clicks", "impressions", "sessions", "aov",
]

CHANNELS = ["Google Ads", "Meta Ads", "MS Ads"]
MIN_CAMPAIGN_SPEND = 50.0  # below this, a campaign's own ROAS is too noisy to trust


# ─────────────────────────────────────────────────────────
#  PLATFORM FILE DETECTION + NORMALIZATION
# ─────────────────────────────────────────────────────────
def _title_case(s):
    return " ".join(w.capitalize() for w in str(s or "").replace("_", " ").split())


def _infer_campaign_type_from_name(name):
    n = str(name or "").lower()
    if "prospect" in n:
        return "Prospecting"
    if "retarget" in n:
        return "Retargeting"
    if "shop" in n:
        return "Shopping"
    if "search" in n:
        return "Search"
    return "Other"


def detect_platform(df: pd.DataFrame, filename: str = "") -> str:
    """Identify which ad platform a raw export came from, by column signature
    first (robust to renamed files) and filename as a fallback hint."""
    cols = set(df.columns)
    if {"TimePeriod", "CampaignId"}.issubset(cols) or {"Spend", "Revenue", "Clicks", "CampaignName"}.issubset(cols):
        return "bing"
    if {"segments_date", "metrics_cost_micros"}.issubset(cols):
        return "google"
    if {"date_start", "cpc", "cpm"}.issubset(cols):
        return "meta"
    if {"date", "channel", "campaign_type", "spend", "revenue"}.issubset(cols):
        return "canonical"  # already-merged / pre-normalized file
    fn = filename.lower()
    if "bing" in fn or "microsoft" in fn or "ms_ads" in fn:
        return "bing"
    if "google" in fn:
        return "google"
    if "meta" in fn or "facebook" in fn:
        return "meta"
    return "unknown"


def normalize_bing(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame()
    out["date"] = df["TimePeriod"].astype(str).str.strip()
    out["channel"] = "MS Ads"
    out["campaign_type"] = df.get("CampaignType", "Other").fillna("Other").map(_title_case)
    out["campaign_name"] = df.get("CampaignName", "Unknown").fillna("Unknown").astype(str).str.strip()
    out["spend"] = pd.to_numeric(df.get("Spend"), errors="coerce").fillna(0.0)
    out["revenue"] = pd.to_numeric(df.get("Revenue"), errors="coerce").fillna(0.0)
    out["conversions"] = pd.to_numeric(df.get("Conversions"), errors="coerce").fillna(0.0)
    out["clicks"] = pd.to_numeric(df.get("Clicks"), errors="coerce").fillna(0.0)
    out["impressions"] = pd.to_numeric(df.get("Impressions"), errors="coerce").fillna(0.0)
    out["sessions"] = out["clicks"]
    out["aov"] = np.where(out["conversions"] > 0, out["revenue"] / out["conversions"], 0.0)
    return out[CANONICAL_COLUMNS]


def normalize_google(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame()
    out["date"] = df["segments_date"].astype(str).str.strip()
    out["channel"] = "Google Ads"
    out["campaign_type"] = df.get("campaign_advertising_channel_type", "Other").fillna("Other").map(_title_case)
    out["campaign_name"] = df.get("campaign_name", "Unknown").fillna("Unknown").astype(str).str.strip()
    out["spend"] = pd.to_numeric(df.get("metrics_cost_micros"), errors="coerce").fillna(0.0) / 1e6
    out["conversions"] = pd.to_numeric(df.get("metrics_conversions"), errors="coerce").fillna(0.0)
    out["revenue"] = pd.to_numeric(df.get("metrics_conversions_value"), errors="coerce").fillna(0.0)
    out["clicks"] = pd.to_numeric(df.get("metrics_clicks"), errors="coerce").fillna(0.0)
    out["impressions"] = pd.to_numeric(df.get("metrics_impressions"), errors="coerce").fillna(0.0)
    out["sessions"] = out["clicks"]
    out["aov"] = np.where(out["conversions"] > 0, out["revenue"] / out["conversions"], 0.0)
    return out[CANONICAL_COLUMNS]


def normalize_meta(df: pd.DataFrame) -> pd.DataFrame:
    # NOTE: Meta's raw export has only one ambiguous "conversion" column (fractional
    # values, no separate revenue or true conversion-count field). We treat it as a
    # conversion-value proxy for revenue, same assumption used in the interactive app.
    # If the held-out test file has a distinct revenue/purchase-value column, update
    # this mapping accordingly.
    out = pd.DataFrame()
    out["date"] = df["date_start"].astype(str).str.strip()
    out["channel"] = "Meta Ads"
    name = df.get("campaign_name", "Unknown").fillna("Unknown").astype(str).str.strip()
    out["campaign_name"] = name
    out["campaign_type"] = name.map(_infer_campaign_type_from_name)
    out["spend"] = pd.to_numeric(df.get("spend"), errors="coerce").fillna(0.0)
    out["clicks"] = pd.to_numeric(df.get("clicks"), errors="coerce").fillna(0.0)
    conv_val = pd.to_numeric(df.get("conversion"), errors="coerce").fillna(0.0)
    out["revenue"] = conv_val
    out["conversions"] = conv_val
    out["impressions"] = pd.to_numeric(df.get("impressions"), errors="coerce").fillna(0.0)
    out["sessions"] = out["clicks"]
    out["aov"] = 0.0
    return out[CANONICAL_COLUMNS]


def normalize_canonical(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame()
    for col in CANONICAL_COLUMNS:
        out[col] = df.get(col)
    for col in ["spend", "revenue", "conversions", "clicks", "impressions", "sessions", "aov"]:
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0.0)
    out["date"] = out["date"].astype(str).str.strip()
    out["channel"] = out["channel"].astype(str).str.strip()
    out["campaign_type"] = out["campaign_type"].fillna("Other").astype(str).str.strip()
    out["campaign_name"] = out["campaign_name"].fillna("Unknown").astype(str).str.strip()
    return out[CANONICAL_COLUMNS]


NORMALIZERS = {
    "bing": normalize_bing,
    "google": normalize_google,
    "meta": normalize_meta,
    "canonical": normalize_canonical,
}


def load_and_normalize_data_dir(data_dir: str) -> pd.DataFrame:
    """Read every CSV in data_dir, auto-detect its platform by column signature,
    normalize into the canonical schema, and concatenate. Reads by pattern,
    not hardcoded filenames, per the submission contract (Section 4)."""
    csv_paths = sorted(glob.glob(os.path.join(data_dir, "*.csv")))
    if not csv_paths:
        raise FileNotFoundError(f"No CSV files found in {data_dir}")

    frames = []
    for path in csv_paths:
        raw = pd.read_csv(path)
        platform = detect_platform(raw, os.path.basename(path))
        if platform == "unknown":
            # Don't silently drop unrecognized files — fail loudly per Section 3 rules
            raise ValueError(
                f"Could not detect platform schema for {path}. "
                f"Columns found: {list(raw.columns)}"
            )
        frames.append(NORMALIZERS[platform](raw))

    merged = pd.concat(frames, ignore_index=True)
    return merged


# ─────────────────────────────────────────────────────────
#  DATA CLEANING — same rules as the interactive app
# ─────────────────────────────────────────────────────────
def clean_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Per channel: drop the trailing 7-day attribution-lag window (only on
    genuinely daily data — sparse/monthly uploads are left untouched), and
    drop rows with zero spend, zero clicks, and zero revenue (pure noise)."""
    parts = []
    for ch, g in df.groupby("channel"):
        g = g.copy()
        dates = pd.to_datetime(g["date"], errors="coerce")
        unique_dates = dates.dropna().nunique()
        if unique_dates > 20:
            max_date = dates.max()
            cutoff = max_date - pd.Timedelta(days=7)
            g = g[~(dates > cutoff)]
        no_activity = (g["spend"] == 0) & (g["clicks"] == 0) & (g["revenue"] == 0)
        g = g[~no_activity]
        parts.append(g)
    return pd.concat(parts, ignore_index=True) if parts else df


def validate_campaign_consistency(df: pd.DataFrame) -> dict:
    """Required deliverable: validate campaign consistency across the dataset.
    Flags issues that would silently corrupt the forecast rather than failing
    loudly, and returns a small report dict for logging / the docs."""
    issues = []
    if df.empty:
        issues.append("No rows after normalization.")
        return {"ok": False, "issues": issues}

    bad_channels = set(df["channel"].unique()) - set(CHANNELS)
    if bad_channels:
        issues.append(f"Unrecognized channel values found: {sorted(bad_channels)}")

    bad_dates = pd.to_datetime(df["date"], errors="coerce").isna().sum()
    if bad_dates:
        issues.append(f"{bad_dates} rows have an unparseable date.")

    neg_spend = (df["spend"] < 0).sum()
    if neg_spend:
        issues.append(f"{neg_spend} rows have negative spend.")

    dup_keys = df.duplicated(subset=["date", "channel", "campaign_name"]).sum()
    if dup_keys:
        issues.append(f"{dup_keys} duplicate (date, channel, campaign_name) rows found.")

    name_type_map = df.groupby("campaign_name")["campaign_type"].nunique()
    inconsistent = name_type_map[name_type_map > 1]
    if len(inconsistent):
        issues.append(
            f"{len(inconsistent)} campaign names map to more than one campaign_type "
            f"(e.g. {list(inconsistent.index[:5])})."
        )

    return {"ok": len(issues) == 0, "issues": issues, "row_count": len(df)}


# ─────────────────────────────────────────────────────────
#  SPEND-WEIGHTED STATS ENGINE
# ─────────────────────────────────────────────────────────
DEFAULTS = {
    "Google Ads": {"roas": 4.9, "std": 0.32},
    "Meta Ads":   {"roas": 3.8, "std": 0.40},
    "MS Ads":     {"roas": 4.3, "std": 0.28},
}


@dataclass
class ChannelStats:
    avg_roas: float
    std_roas: float
    trend_pct: float
    ctypes: dict = field(default_factory=dict)
    campaigns: dict = field(default_factory=dict)


def build_stats(df: pd.DataFrame, priors: dict = None) -> dict:
    """Spend-weighted ROAS (total revenue / total spend), not an unweighted
    average of monthly ratios — a thin/noisy month can no longer dominate
    a channel that's actually profitable overall.

    `priors`, if given, is the pickled model's previously-fitted channel_stats
    (a dict of ChannelStats from train_model.py run on our training data).
    When a channel has no rows, or too little spend to compute a trustworthy
    estimate, we fall back to that channel's trained prior instead of a fixed
    constant — this is what makes the saved model actually load-bearing,
    rather than predict.py silently ignoring it and recomputing from scratch.
    """
    out = {}
    for ch in CHANNELS:
        chdf = df[df["channel"] == ch].copy()
        fallback = (priors or {}).get(ch) or ChannelStats(DEFAULTS[ch]["roas"], DEFAULTS[ch]["std"], 1.5)

        if chdf.empty or chdf["spend"].sum() < MIN_CAMPAIGN_SPEND:
            out[ch] = fallback
            continue

        chdf["month"] = chdf["date"].astype(str).str.slice(0, 7)
        monthly = chdf.groupby("month").agg(spend=("spend", "sum"), rev=("revenue", "sum")).reset_index()
        monthly = monthly.sort_values("month")
        monthly_spend = monthly[monthly["spend"] > 0]

        total_spend = chdf["spend"].sum()
        total_rev = chdf["revenue"].sum()
        avg_roas = (total_rev / total_spend) if total_spend > 0 else DEFAULTS[ch]["roas"]

        if len(monthly_spend):
            ratios = monthly_spend["rev"] / monthly_spend["spend"]
            weights = monthly_spend["spend"]
            variance = float(np.sum(weights * (ratios - avg_roas) ** 2) / max(total_spend, 1))
        else:
            variance = DEFAULTS[ch]["std"] ** 2
        std_roas = max(np.sqrt(variance), 0.05)

        trend_pct = 0.0
        if len(monthly_spend) >= 4:
            h = len(monthly_spend) // 2
            first, second = monthly_spend.iloc[:h], monthly_spend.iloc[h:]
            s1, r1 = first["spend"].sum(), first["rev"].sum()
            s2, r2 = second["spend"].sum(), second["rev"].sum()
            roas1 = (r1 / s1) if s1 > 0 else 0
            roas2 = (r2 / s2) if s2 > 0 else 0
            if roas1 > 0:
                trend_pct = ((roas2 - roas1) / roas1) * 100

        # Campaign-type breakdown — dynamic, not a hardcoded list
        ctypes = {}
        for ct, g in chdf.groupby("campaign_type"):
            ct_spend, ct_rev = g["spend"].sum(), g["revenue"].sum()
            if ct_spend <= 0 and ct_rev <= 0:
                continue
            ctypes[ct] = {
                "avg_roas": (ct_rev / ct_spend) if ct_spend > 0 else 0,
                "total_spend": float(ct_spend),
                "total_revenue": float(ct_rev),
                "conversions": float(g["conversions"].sum()),
            }

        # Campaign-level breakdown
        campaigns = {}
        for name, g in chdf.groupby("campaign_name"):
            spend, rev = g["spend"].sum(), g["revenue"].sum()
            clicks, conv = g["clicks"].sum(), g["conversions"].sum()
            sessions = g["sessions"].sum()
            aov_rows = g[g["aov"] > 0]["aov"]
            aov = float(aov_rows.mean()) if len(aov_rows) else (rev / conv if conv > 0 else 0)
            campaigns[name] = {
                "spend": float(spend), "revenue": float(rev),
                "roas": (rev / spend) if spend > 0 else 0,
                "cvr": (conv / clicks * 100) if clicks > 0 else 0,
                "aov": aov, "conversions": float(conv), "sessions": float(sessions),
                "insufficient_data": spend < MIN_CAMPAIGN_SPEND,
            }

        reliable = {k: v for k, v in campaigns.items() if not v["insufficient_data"]}
        if len(reliable) >= 2:
            base_spend = sum(c["spend"] for c in reliable.values())
            base_rev = sum(c["revenue"] for c in reliable.values())
            camp_avg = (base_rev / base_spend) if base_spend > 0 else 0
            camp_var = (
                sum(c["spend"] * (c["roas"] - camp_avg) ** 2 for c in reliable.values()) / base_spend
                if base_spend > 0 else 0
            )
            camp_std = np.sqrt(camp_var) or 0.001
            for name, c in campaigns.items():
                if c["insufficient_data"]:
                    c["anomaly"], c["anomaly_dir"] = False, None
                    continue
                c["anomaly"] = abs(c["roas"] - camp_avg) > 1.5 * camp_std
                c["anomaly_dir"] = "high" if c["roas"] > camp_avg else "low"
        else:
            for c in campaigns.values():
                c["anomaly"], c["anomaly_dir"] = False, None

        out[ch] = ChannelStats(float(avg_roas), float(std_roas), float(trend_pct), ctypes, campaigns)

    return out


# ─────────────────────────────────────────────────────────
#  MONTE CARLO FORECAST
# ─────────────────────────────────────────────────────────
def monte_carlo(budgets: dict, stats: dict, n: int = 800, seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    active = [ch for ch in budgets if (budgets.get(ch) or 0) > 0]
    sims = np.zeros(n)
    for ch in active:
        s = stats.get(ch, ChannelStats(4.2, 0.3, 0.0))
        z = rng.standard_normal(n)
        roas = np.maximum(0.5, s.avg_roas + z * s.std_roas)
        sims += (budgets[ch] or 0) * roas * (1 + s.trend_pct / 100)
    sims.sort()
    p = lambda f: float(sims[int(n * f)])
    return {
        "p10": p(0.10), "p25": p(0.25), "p50": p(0.50), "p75": p(0.75), "p90": p(0.90),
        "mean": float(sims.mean()), "sims": sims,
    }


def build_forecast(raw_df: pd.DataFrame, budgets: dict, days: int, seed: int = 42, priors: dict = None) -> dict:
    df = clean_rows(raw_df)
    stats = build_stats(df, priors=priors)
    mc = monte_carlo(budgets, stats, seed=seed)
    total_budget = sum(v or 0 for v in budgets.values())

    channel_forecast = {}
    for ch in CHANNELS:
        b = budgets.get(ch) or 0
        if not b:
            continue
        s = stats[ch]
        tm = 1 + s.trend_pct / 100
        mid = b * s.avg_roas * tm
        channel_forecast[ch] = {
            "budget": b, "roas": s.avg_roas * tm,
            "revenue_p10": mid * 0.81, "revenue_p50": mid, "revenue_p90": mid * 1.19,
            "trend_pct": s.trend_pct, "ctypes": s.ctypes, "campaigns": s.campaigns,
        }

    blended_roas = (mc["p50"] / total_budget) if total_budget > 0 else 0
    conf_width = ((mc["p90"] - mc["p10"]) / mc["p50"] * 100) if mc["p50"] else 0

    return {
        "days": days, "total_budget": total_budget, "mc": mc,
        "blended_roas": blended_roas, "conf_width": conf_width,
        "channels": channel_forecast, "stats": stats,
    }
