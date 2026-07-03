# RevenueIQ — Interactive React App

This is the interactive frontend for RevenueIQ. It runs entirely in the
browser — no backend server needed.

## What it shows

| Tab | What it does |
|---|---|
| Setup | Upload CSVs (separate per-platform, merged, or demo dataset). Enter budget per channel. Choose 30/60/90 day window. |
| Forecast | P10/P50/P90 revenue bands, channel breakdown, probability histogram, KPI cards |
| Scenarios | Budget slider (50–200%), 4 preset scenarios, sensitivity curve, channel efficiency ranking |
| Campaigns | Anomaly alerts, campaign-type forecast, individual campaign table with ROAS/CVR/AOV |
| AI Insights | 4 Claude-powered analyses: Executive Summary, Anomaly Detection, Budget Reallocation, Risk Assessment |

## How to run it

This is a React component (App.jsx). To run it locally you need Node.js.

**Quickest way — use an online sandbox:**
1. Go to [stackblitz.com](https://stackblitz.com) or [codesandbox.io](https://codesandbox.io)
2. Create a new React project
3. Replace the default App.jsx with this one
4. Install dependencies: `papaparse` and `recharts`

**Or run locally:**
```bash
npx create-react-app revenueiq
cd revenueiq
npm install papaparse recharts
# Replace src/App.js with App.jsx content
npm start
```

## Notes

- The AI Insights tab calls the Anthropic Claude API directly from the browser.
  It will work as long as the API endpoint allows browser requests.
- Upload modes: separate files (Google/Meta/Bing native exports auto-detected),
  merged CSV, or built-in demo dataset.
- No backend required — all forecasting runs client-side.
