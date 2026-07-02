"""
ai_insights.py — Backend AI analysis layer using the Claude API.

Per organizer confirmation: LLM calls should be triggered from the UI,
but a backend function must also be provided so the organizers can call
it directly against forecasted data without needing the React app.

Usage (standalone):
    python3 src/ai_insights.py \
        --predictions ./output/predictions.csv \
        --api-key YOUR_ANTHROPIC_API_KEY

Or imported and called programmatically:
    from ai_insights import run_all_insights
    results = run_all_insights(predictions_df, api_key="sk-ant-...")

The API key can also be set via the environment variable:
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 src/ai_insights.py --predictions ./output/predictions.csv
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

import pandas as pd


# ─────────────────────────────────────────────────────────
#  CLAUDE API CALL — no third-party http library needed,
#  uses Python's built-in urllib so there are zero extra deps
# ─────────────────────────────────────────────────────────
def call_claude(prompt: str, api_key: str, max_tokens: int = 600) -> str:
    """
    Call the Anthropic Messages API and return the text response.
    Uses only Python stdlib (urllib) — no requests/httpx dependency.
    """
    url = "https://api.anthropic.com/v1/messages"
    payload = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["content"][0]["text"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        return f"API error {e.code}: {body}"
    except Exception as e:
        return f"Request failed: {e}"


# ─────────────────────────────────────────────────────────
#  FORECAST SUMMARY BUILDER
#  Turns predictions.csv into a compact text block that fits
#  in a prompt without hitting token limits
# ─────────────────────────────────────────────────────────
def summarise_forecast(df: pd.DataFrame, window: int = 30) -> str:
    """
    Summarise the predictions dataframe for a given forecast window
    into a concise text block ready to inject into a prompt.
    """
    w = df[df["forecast_window_days"] == window].copy()
    if w.empty:
        return f"No forecast data found for {window}-day window."

    lines = [f"FORECAST WINDOW: {window} days\n"]

    # Aggregate totals
    total_spend  = w["spend"].sum()
    total_rev_p50 = w["forecasted_revenue_p50"].sum()
    total_rev_p10 = w["forecasted_revenue_p10"].sum()
    total_rev_p90 = w["forecasted_revenue_p90"].sum()
    blended_roas  = total_rev_p50 / total_spend if total_spend > 0 else 0

    lines.append("AGGREGATE:")
    lines.append(f"  Total budget:    ${total_spend:,.0f}")
    lines.append(f"  P10 revenue:     ${total_rev_p10:,.0f}")
    lines.append(f"  P50 revenue:     ${total_rev_p50:,.0f}  (most likely)")
    lines.append(f"  P90 revenue:     ${total_rev_p90:,.0f}")
    lines.append(f"  Blended ROAS:    {blended_roas:.2f}x\n")

    # Channel breakdown
    lines.append("CHANNEL BREAKDOWN:")
    ch_grp = w.groupby("channel").agg(
        spend=("spend", "sum"),
        rev_p10=("forecasted_revenue_p10", "sum"),
        rev_p50=("forecasted_revenue_p50", "sum"),
        rev_p90=("forecasted_revenue_p90", "sum"),
    ).reset_index()

    for _, row in ch_grp.iterrows():
        roas = row["rev_p50"] / row["spend"] if row["spend"] > 0 else 0
        lines.append(
            f"  {row['channel']:<12} budget=${row['spend']:>10,.0f}  "
            f"P50=${row['rev_p50']:>10,.0f}  ROAS={roas:.2f}x  "
            f"range=[${row['rev_p10']:,.0f}–${row['rev_p90']:,.0f}]"
        )

    # Campaign type breakdown
    lines.append("\nCAMPAIGN TYPE BREAKDOWN:")
    ct_grp = w.groupby(["channel", "campaign_type"]).agg(
        spend=("spend", "sum"),
        rev_p50=("forecasted_revenue_p50", "sum"),
    ).reset_index()
    for _, row in ct_grp.iterrows():
        roas = row["rev_p50"] / row["spend"] if row["spend"] > 0 else 0
        lines.append(
            f"  {row['channel']:<12} / {row['campaign_type']:<18} "
            f"ROAS={roas:.2f}x  P50=${row['rev_p50']:,.0f}"
        )

    # Top 5 campaigns by P50 revenue
    lines.append("\nTOP 5 CAMPAIGNS (by P50 revenue):")
    top5 = w.nlargest(5, "forecasted_revenue_p50")
    for _, row in top5.iterrows():
        roas = row["forecasted_roas_p50"]
        lines.append(
            f"  {row['channel']:<12} / {row['campaign_name']:<35} "
            f"P50=${row['forecasted_revenue_p50']:,.0f}  ROAS={roas:.2f}x"
        )

    # Bottom 5 by ROAS (excluding zero-spend)
    lines.append("\nBOTTOM 5 CAMPAIGNS (by ROAS — potential underperformers):")
    nonzero = w[w["spend"] > 50]
    if len(nonzero) >= 5:
        bottom5 = nonzero.nsmallest(5, "forecasted_roas_p50")
        for _, row in bottom5.iterrows():
            lines.append(
                f"  {row['channel']:<12} / {row['campaign_name']:<35} "
                f"ROAS={row['forecasted_roas_p50']:.2f}x  "
                f"spend=${row['spend']:,.0f}"
            )

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────
#  PROMPT BUILDERS
#  Each returns a complete, self-contained prompt string.
#  All prompts inject REAL numbers from the forecast —
#  Claude interprets data, it does not make up numbers.
# ─────────────────────────────────────────────────────────
def prompt_executive_summary(forecast_text: str) -> str:
    return f"""You are a senior e-commerce performance analyst writing a board-level executive brief. Be direct, specific, and professional. No bullet points, no headers — flowing prose only.

{forecast_text}

Write exactly 5 sentences:
1. Overall revenue outlook with the P10–P90 range and what it means for the business.
2. The strongest channel by ROAS and why it deserves the most confidence.
3. The weakest channel and the specific gap that needs addressing.
4. What conditions would push actual revenue toward the P10 (pessimistic) outcome.
5. One concrete, dollar-specific budget action to take this week."""


def prompt_anomaly_detection(forecast_text: str) -> str:
    return f"""You are a marketing data scientist identifying performance anomalies and opportunities in paid media forecasts.

{forecast_text}

Identify and explain:
1. The most significant performance anomaly (a campaign or channel with unexpectedly high or low ROAS relative to peers) and its most likely operational cause.
2. One compounding trend visible across multiple channels or campaign types that creates a growth opportunity.
3. The single highest operational risk from the underperforming segments.

Maximum 4 sentences. Be specific with the numbers from the data above."""


def prompt_budget_reallocation(forecast_text: str) -> str:
    return f"""You are a paid media strategist responsible for allocating budget across Google Ads, Meta Ads, and Microsoft Ads.

{forecast_text}

Recommend ONE specific budget reallocation:
- State the exact dollar amount to move
- Which channel or campaign type it comes FROM and which it goes TO
- The projected ROAS improvement as a result
- One conversion rate optimisation action to accompany the reallocation

3 sentences maximum. Be precise with numbers."""


def prompt_risk_assessment(forecast_text: str) -> str:
    return f"""You are a risk analyst for a digital marketing agency reviewing a probabilistic revenue forecast.

{forecast_text}

Identify the top 3 operational risks that could cause actual revenue to fall below the P10 outcome. For each risk:
- Name the specific trigger
- Quantify the potential revenue impact in dollars
- State one concrete mitigation action

Be concise and actionable. No generic advice."""


# ─────────────────────────────────────────────────────────
#  MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────
ANALYSES = {
    "executive_summary":     prompt_executive_summary,
    "anomaly_detection":     prompt_anomaly_detection,
    "budget_reallocation":   prompt_budget_reallocation,
    "risk_assessment":       prompt_risk_assessment,
}


def run_all_insights(
    predictions_df: pd.DataFrame,
    api_key: str,
    window: int = 30,
) -> dict:
    """
    Run all four AI analyses against a predictions DataFrame.
    Returns a dict of {analysis_name: text_result}.

    This is the function the organizers can call programmatically
    without needing the React UI.

    Example:
        import pandas as pd
        from src.ai_insights import run_all_insights

        df = pd.read_csv("output/predictions.csv")
        results = run_all_insights(df, api_key="sk-ant-...", window=30)
        for name, text in results.items():
            print(f"--- {name} ---")
            print(text)
    """
    forecast_text = summarise_forecast(predictions_df, window=window)
    results = {}
    for name, prompt_fn in ANALYSES.items():
        prompt = prompt_fn(forecast_text)
        print(f"  Calling Claude for: {name}...")
        results[name] = call_claude(prompt, api_key)
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Run AI insights against predictions.csv using the Claude API."
    )
    parser.add_argument(
        "--predictions", required=True,
        help="Path to predictions.csv (output of predict.py)"
    )
    parser.add_argument(
        "--api-key", default=None,
        help="Anthropic API key. If not provided, reads ANTHROPIC_API_KEY env var."
    )
    parser.add_argument(
        "--window", type=int, default=30, choices=[30, 60, 90],
        help="Forecast window to analyse (default: 30)"
    )
    parser.add_argument(
        "--output", default=None,
        help="Optional: path to write results as JSON (e.g. output/insights.json)"
    )
    args = parser.parse_args()

    # Resolve API key
    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print(
            "ERROR: No API key found.\n"
            "Provide it via --api-key or set the ANTHROPIC_API_KEY environment variable.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Load predictions
    print(f"Loading predictions from {args.predictions}...")
    df = pd.read_csv(args.predictions)
    print(f"  {len(df)} rows loaded")

    # Print the forecast summary so the user can see what Claude is working from
    print("\n" + "─" * 60)
    print(summarise_forecast(df, window=args.window))
    print("─" * 60 + "\n")

    # Run all four analyses
    print(f"Running AI analyses (window={args.window} days)...\n")
    results = run_all_insights(df, api_key=api_key, window=args.window)

    # Print results
    for name, text in results.items():
        print(f"\n{'═'*60}")
        print(f"  {name.upper().replace('_',' ')}")
        print(f"{'═'*60}")
        print(text)

    # Optionally write to JSON
    if args.output:
        os.makedirs(os.path.dirname(args.output), exist_ok=True)
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nResults written to {args.output}")


if __name__ == "__main__":
    main()
