import { useState, useEffect, useCallback, useRef } from "react";
import Papa from "papaparse";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, ReferenceLine, ScatterChart, Scatter
} from "recharts";

// ═══════════════════════════════════════════════════════
//  DESIGN TOKENS
// ═══════════════════════════════════════════════════════
const C = {
  bg:"#04080f", surface:"#080f1e", card:"#0c1628", raised:"#111f35",
  border:"#172845", dim:"#1e3050", text:"#e4eeff", muted:"#6888aa",
  faint:"#2d4060", accent:"#1e6fef", accentL:"#4d8fff", accentD:"#1454b8",
  green:"#00d68f", greenD:"#008f5e", amber:"#f5a623", red:"#f03050",
  purple:"#9b6dff", google:"#4285f4", meta:"#1877f2", msft:"#00b4d8",
};
const CH = { "Google Ads": C.google, "Meta Ads": C.meta, "MS Ads": C.msft };

// ═══════════════════════════════════════════════════════
//  SAMPLE DATA — aligned dataset
// ═══════════════════════════════════════════════════════
const SAMPLE_CSV = `date,channel,campaign_type,campaign_name,spend,revenue,conversions,clicks,impressions,sessions,aov
2026-01-01,Google Ads,Search,Brand Core,8400,42000,318,4300,145000,12800,132.08
2026-01-01,Google Ads,Shopping,Product Feed,5200,23400,201,3150,280000,9400,116.42
2026-01-01,Meta Ads,Prospecting,Broad Awareness,4900,16170,148,7000,520000,14200,109.26
2026-01-01,Meta Ads,Retargeting,Cart Recovery,3100,14570,164,2450,98000,5800,88.84
2026-01-01,MS Ads,Search,Brand MS,1900,7600,76,1020,42000,3100,100.00
2026-02-01,Google Ads,Search,Brand Core,8900,44950,340,4500,152000,13500,132.21
2026-02-01,Google Ads,Shopping,Product Feed,5700,26220,220,3320,295000,9900,119.18
2026-02-01,Meta Ads,Prospecting,Broad Awareness,5300,18020,162,7400,548000,15000,111.23
2026-02-01,Meta Ads,Retargeting,Cart Recovery,3500,16800,190,2660,104000,6200,88.42
2026-02-01,MS Ads,Search,Brand MS,2100,8610,88,1120,46000,3400,97.84
2026-03-01,Google Ads,Search,Brand Core,9600,49920,374,4780,160000,14200,133.48
2026-03-01,Google Ads,Shopping,Product Feed,6300,29610,248,3620,312000,10600,119.40
2026-03-01,Meta Ads,Prospecting,Broad Awareness,5900,21240,186,7900,572000,16100,114.19
2026-03-01,Meta Ads,Retargeting,Cart Recovery,3900,19110,216,2920,110000,6900,88.47
2026-03-01,MS Ads,Search,Brand MS,2500,10500,102,1260,49000,3800,102.94
2026-04-01,Google Ads,Search,Brand Core,8800,42240,332,4420,148000,13200,127.23
2026-04-01,Google Ads,Shopping,Product Feed,5900,26550,228,3280,298000,9800,116.45
2026-04-01,Meta Ads,Prospecting,Broad Awareness,5500,19250,168,7500,555000,15400,114.58
2026-04-01,Meta Ads,Retargeting,Cart Recovery,3600,17280,196,2740,106000,6400,88.16
2026-04-01,MS Ads,Search,Brand MS,2200,9020,92,1180,47000,3500,98.04
2026-05-01,Google Ads,Search,Brand Core,10100,51510,406,5060,168000,15200,126.87
2026-05-01,Google Ads,Shopping,Product Feed,6600,31680,268,3780,325000,11200,118.21
2026-05-01,Meta Ads,Prospecting,Broad Awareness,6200,23560,208,8300,595000,16900,113.27
2026-05-01,Meta Ads,Retargeting,Cart Recovery,4200,20790,232,3080,115000,7200,89.61
2026-05-01,MS Ads,Search,Brand MS,2700,11340,112,1380,52000,4100,101.25
2026-06-01,Google Ads,Search,Brand Core,10400,54080,422,5240,175000,15800,128.15
2026-06-01,Google Ads,Shopping,Product Feed,6900,33810,288,3960,338000,11800,117.40
2026-06-01,Meta Ads,Prospecting,Broad Awareness,6500,25350,222,8700,612000,17600,114.19
2026-06-01,Meta Ads,Retargeting,Cart Recovery,4600,23460,256,3320,120000,7800,91.64
2026-06-01,MS Ads,Search,Brand MS,2900,12470,122,1480,55000,4400,102.21`;

// ═══════════════════════════════════════════════════════
//  STATS ENGINE
// ═══════════════════════════════════════════════════════
function buildStats(rows) {
  const DEFAULTS = {
    "Google Ads": { roas:4.9, std:0.32 },
    "Meta Ads":   { roas:3.8, std:0.40 },
    "MS Ads":     { roas:4.3, std:0.28 },
  };
  const channels = ["Google Ads","Meta Ads","MS Ads"];
  const MIN_CAMPAIGN_SPEND = 50; // below this a campaign's own ROAS is too noisy to trust on its own
  const out = {};

  channels.forEach(ch => {
    const chRows = rows.filter(r => (r.channel||"").trim() === ch);
    if (!chRows.length) {
      out[ch] = { avgRoas:DEFAULTS[ch].roas, stdRoas:DEFAULTS[ch].std, trendPct:1.5, campaigns:{}, ctypes:{} };
      return;
    }

    // Monthly buckets — used for trend + dispersion, NOT for the headline ROAS
    // (averaging monthly ratios equally would let a $5-spend month with $0 revenue
    // distort the number just as much as a $50k month — so we don't do that)
    const byMonth = {};
    chRows.forEach(r => {
      const mo = (r.date||"").slice(0,7);
      if (!byMonth[mo]) byMonth[mo] = { spend:0, rev:0 };
      byMonth[mo].spend += +(r.spend)||0;
      byMonth[mo].rev   += +(r.revenue)||0;
    });
    const monthsChrono = Object.keys(byMonth).sort().map(k=>byMonth[k]);
    const monthsWithSpend = monthsChrono.filter(m => m.spend>0);

    // Headline ROAS = SPEND-WEIGHTED blended ratio across all dollars, not an
    // average-of-averages. This is the fix: total revenue ÷ total spend.
    const totalSpend = chRows.reduce((a,r)=>a+(+r.spend||0),0);
    const totalRev   = chRows.reduce((a,r)=>a+(+r.revenue||0),0);
    const avg = totalSpend>0 ? totalRev/totalSpend : DEFAULTS[ch].roas;

    // Spend-weighted month-to-month dispersion (so a near-zero-spend month can't
    // inflate uncertainty the same as a real, well-funded month)
    const variance = monthsWithSpend.length
      ? monthsWithSpend.reduce((a,m)=>{ const r=m.rev/m.spend; return a + m.spend*(r-avg)**2; },0) / Math.max(totalSpend,1)
      : DEFAULTS[ch].std**2;
    const std = Math.sqrt(variance);

    // Trend: spend-weighted ROAS of the first half of months vs the second half
    let trend = 0;
    if (monthsWithSpend.length >= 4) {
      const h = Math.floor(monthsWithSpend.length/2);
      const f = monthsWithSpend.slice(0,h), s = monthsWithSpend.slice(h);
      const fSpend=f.reduce((a,m)=>a+m.spend,0), fRev=f.reduce((a,m)=>a+m.rev,0);
      const sSpend=s.reduce((a,m)=>a+m.spend,0), sRev=s.reduce((a,m)=>a+m.rev,0);
      const roas1 = fSpend>0 ? fRev/fSpend : 0, roas2 = sSpend>0 ? sRev/sSpend : 0;
      if (roas1>0) trend = ((roas2-roas1)/roas1)*100;
    }

    // Campaign-type breakdown — spend-weighted, and built from whatever types are
    // actually present in the data (Search/Shopping/Performance Max/Display/Video/etc)
    // instead of a fixed hardcoded list that silently dropped unrecognized types.
    const typesPresent = [...new Set(chRows.map(r=>(r.campaign_type||"Other").trim()).filter(Boolean))];
    const ctypes = {};
    typesPresent.forEach(ct => {
      const ctR = chRows.filter(r => (r.campaign_type||"").trim()===ct);
      const ctSpend = ctR.reduce((a,r)=>a+(+r.spend||0),0);
      const ctRev   = ctR.reduce((a,r)=>a+(+r.revenue||0),0);
      if (ctSpend<=0 && ctRev<=0) return;
      ctypes[ct] = {
        avgRoas: ctSpend>0 ? ctRev/ctSpend : 0,
        totalSpend: ctSpend,
        totalRevenue: ctRev,
        conversions: ctR.reduce((a,r)=>a+(+r.conversions||0),0),
      };
    });

    // Individual campaign breakdown
    const campMap = {};
    chRows.forEach(r => {
      const name = (r.campaign_name||"Unknown").trim();
      if (!campMap[name]) campMap[name] = { spend:0, rev:0, conv:0, clicks:0, sessions:0, aovSum:0, aovCount:0 };
      campMap[name].spend    += +(r.spend)||0;
      campMap[name].rev      += +(r.revenue)||0;
      campMap[name].conv     += +(r.conversions)||0;
      campMap[name].clicks   += +(r.clicks)||0;
      campMap[name].sessions += +(r.sessions)||0;
      if (+r.aov) { campMap[name].aovSum += +r.aov; campMap[name].aovCount++; }
    });
    const campaigns = {};
    Object.entries(campMap).forEach(([name, d]) => {
      campaigns[name] = {
        spend: d.spend, revenue: d.rev,
        roas: d.spend>0 ? d.rev/d.spend : 0,
        cvr:  d.clicks>0 ? (d.conv/d.clicks)*100 : 0,
        // fall back to revenue/conversions when no explicit per-row aov was supplied
        aov:  d.aovCount>0 ? d.aovSum/d.aovCount : (d.conv>0 ? d.rev/d.conv : 0),
        conv: d.conv, sessions: d.sessions,
        insufficientData: d.spend < MIN_CAMPAIGN_SPEND,
      };
    });

    // Anomaly detection: spend-weighted baseline, built only from campaigns with
    // enough spend to trust (thin campaigns are shown but never flagged as anomalies —
    // with $5 of spend, "anomalous ROAS" is just noise, not a signal)
    const reliable = Object.values(campaigns).filter(c=>!c.insufficientData);
    if (reliable.length >= 2) {
      const baseSpend = reliable.reduce((a,c)=>a+c.spend,0);
      const baseRev   = reliable.reduce((a,c)=>a+c.revenue,0);
      const campAvg = baseSpend>0 ? baseRev/baseSpend : 0;
      const campVar = baseSpend>0
        ? reliable.reduce((a,c)=>a+c.spend*(c.roas-campAvg)**2,0)/baseSpend
        : 0;
      const campStd = Math.sqrt(campVar) || 0.001;
      Object.entries(campaigns).forEach(([name,d])=>{
        if (d.insufficientData) { d.anomaly=false; d.anomalyDir=null; return; }
        d.anomaly = Math.abs(d.roas - campAvg) > 1.5 * campStd;
        d.anomalyDir = d.roas > campAvg ? "high" : "low";
      });
    } else {
      Object.values(campaigns).forEach(d=>{ d.anomaly=false; d.anomalyDir=null; });
    }

    out[ch] = { avgRoas: avg, stdRoas: Math.max(std,0.05), trendPct: trend, ctypes, campaigns };
  });

  return out;
}

// ═══════════════════════════════════════════════════════
//  MONTE CARLO ENGINE
// ═══════════════════════════════════════════════════════
function monteCarlo(budgets, stats, N=800) {
  const chs = Object.keys(budgets).filter(ch => (budgets[ch]||0)>0);
  const sims = Array.from({length:N}, () => {
    let total = 0;
    chs.forEach(ch => {
      const s = stats[ch]||{avgRoas:4.2,stdRoas:0.3,trendPct:0};
      const u1=Math.random(), u2=Math.random();
      const z = Math.sqrt(-2*Math.log(Math.max(u1,1e-9)))*Math.cos(2*Math.PI*u2);
      const roas = Math.max(0.5, s.avgRoas + z*s.stdRoas);
      total += (budgets[ch]||0) * roas * (1 + s.trendPct/100);
    });
    return total;
  });
  sims.sort((a,b)=>a-b);
  const p = f => sims[Math.floor(N*f)];
  return { p10:p(.10), p25:p(.25), p50:p(.50), p75:p(.75), p90:p(.90), mean:sims.reduce((a,b)=>a+b,0)/N, sims };
}

// ═══════════════════════════════════════════════════════
//  GENERIC ROW CLEANING — applied regardless of upload path
//  (separate files, merged file, or demo dataset)
// ═══════════════════════════════════════════════════════
function cleanRows(rows) {
  const byChannel = {};
  rows.forEach(r => {
    const ch = (r.channel||"").trim();
    if (!byChannel[ch]) byChannel[ch] = [];
    byChannel[ch].push(r);
  });

  const cleaned = [];
  Object.values(byChannel).forEach(chRows => {
    const validDates = chRows.map(r=>r.date).filter(Boolean);
    const uniqueDates = new Set(validDates).size;
    // Only apply day-level attribution-lag trimming to genuinely daily data
    // (monthly/sparse uploads, like the demo dataset, are left untouched —
    // trimming "7 days" off a monthly series would wipe out a whole period)
    let cutoff = null;
    if (uniqueDates > 20) {
      const sorted = [...validDates].sort();
      const maxDate = new Date(sorted[sorted.length-1]);
      if (!isNaN(maxDate)) {
        cutoff = new Date(maxDate);
        cutoff.setDate(cutoff.getDate()-7);
      }
    }
    chRows.forEach(r => {
      if (cutoff) {
        const d = r.date ? new Date(r.date) : null;
        if (d && !isNaN(d) && d > cutoff) return; // drop attribution-lag window
      }
      const spend = +r.spend||0, clicks = +r.clicks||0, revenue = +r.revenue||0;
      if (spend===0 && clicks===0 && revenue===0) return; // drop true zero-activity rows
      cleaned.push(r);
    });
  });
  return cleaned;
}

// ═══════════════════════════════════════════════════════
//  FULL FORECAST BUILDER
// ═══════════════════════════════════════════════════════
function buildForecast(rawRows, budgets, days) {
  const rows  = cleanRows(rawRows);
  const stats = buildStats(rows);
  const mc    = monteCarlo(budgets, stats);
  const total = Object.values(budgets).reduce((a,b)=>a+(b||0),0);

  // Daily cumulative series with seasonality
  const series = [];
  for (let d=0; d<days; d++) {
    const season = 1 + 0.055*Math.sin((2*Math.PI*((d%30)-6))/30);
    const frac   = (d+1)/days;
    if (d===0||d===days-1||d%Math.max(1,Math.floor(days/16))===0) {
      series.push({
        day: `D${d+1}`,
        low:  Math.round(mc.p10*frac*season),
        mid:  Math.round(mc.p50*frac*season),
        high: Math.round(mc.p90*frac*season),
      });
    }
  }

  // Per-channel forecast
  const chData = {};
  ["Google Ads","Meta Ads","MS Ads"].forEach(ch => {
    const b = budgets[ch]||0;
    if (!b) return;
    const s = stats[ch];
    const tm = 1 + s.trendPct/100;
    const mid = b*s.avgRoas*tm;
    chData[ch] = {
      budget:b, roas:s.avgRoas*tm,
      revMid:mid, revLow:mid*.81, revHigh:mid*1.19,
      trend:s.trendPct, ctypes:s.ctypes, campaigns:s.campaigns,
    };
  });

  // Budget sensitivity (continuous: 50%–200% of plan in 15 steps)
  const sensitivity = Array.from({length:15},(_,i)=>{
    const mult = 0.5 + i*0.10;
    const sb = {};
    Object.keys(budgets).forEach(ch => { sb[ch]=(budgets[ch]||0)*mult; });
    const m = monteCarlo(sb,stats,300);
    const b = Object.values(sb).reduce((a,v)=>a+v,0);
    return { mult:Math.round(mult*100), budget:Math.round(b), p50:Math.round(m.p50), roas:+(m.p50/Math.max(b,1)).toFixed(2) };
  });

  // 4 scenarios
  const scenarios = [
    {label:"−20%",mult:.80},{label:"Planned",mult:1.00},
    {label:"+20%",mult:1.20},{label:"+40%",mult:1.40},
  ].map(sc=>{
    const sb={};
    Object.keys(budgets).forEach(ch=>{sb[ch]=(budgets[ch]||0)*sc.mult;});
    const m=monteCarlo(sb,stats,400);
    const b=Object.values(sb).reduce((a,v)=>a+v,0);
    return {...sc,budget:Math.round(b),p10:Math.round(m.p10),p50:Math.round(m.p50),p90:Math.round(m.p90),roas:+(m.p50/Math.max(b,1)).toFixed(2)};
  });

  // Histogram
  const BINS=18, bMin=mc.sims[0], bMax=mc.sims[799], bw=(bMax-bMin)/BINS;
  const histogram = Array.from({length:BINS},(_,i)=>{
    const lo=bMin+i*bw;
    return {r:`$${Math.round(lo/1000)}k`, count:mc.sims.filter(v=>v>=lo&&v<lo+bw).length};
  });

  // Historical chart
  const histChart = (() => {
    const m={};
    rows.forEach(r=>{
      const d=(r.date||"").slice(0,7); if(!d)return;
      if(!m[d])m[d]={date:d,"Google Ads":0,"Meta Ads":0,"MS Ads":0};
      const ch=(r.channel||"").trim(); if(ch in m[d])m[d][ch]+=(+r.revenue||0);
    });
    return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date));
  })();

  // Anomaly flags across all channels
  const anomalies = [];
  Object.entries(chData).forEach(([ch,d])=>{
    Object.entries(d.campaigns||{}).forEach(([name,c])=>{
      if(c.anomaly) anomalies.push({ ch, name, roas:c.roas, dir:c.anomalyDir, budget:d.budget/Object.keys(d.campaigns).length });
    });
  });

  // Conversion / order metrics
  const ga4Metrics = (() => {
    const totalSessions = rows.reduce((a,r)=>a+(+r.sessions||0),0);
    const totalConv     = rows.reduce((a,r)=>a+(+r.conversions||0),0);
    const totalRev      = rows.reduce((a,r)=>a+(+r.revenue||0),0);
    const aovArr = rows.filter(r=>+r.aov>0).map(r=>+r.aov);
    const avgAov = aovArr.length ? aovArr.reduce((a,b)=>a+b,0)/aovArr.length : 0;
    return {
      totalSessions, totalConv, totalRev,
      avgCvr: totalSessions>0 ? (totalConv/totalSessions*100).toFixed(2) : "—",
      avgAov: avgAov.toFixed(2),
      byChannel: ["Google Ads","Meta Ads","MS Ads"].map(ch=>{
        const r=rows.filter(x=>(x.channel||"").trim()===ch);
        const s=r.reduce((a,x)=>a+(+x.sessions||0),0);
        const cv=r.reduce((a,x)=>a+(+x.conversions||0),0);
        return { ch, sessions:s, cvr:s>0?(cv/s*100).toFixed(2):0, conv:cv };
      }),
    };
  })();

  const blendedRoas = total>0 ? (mc.p50/total).toFixed(2) : "0";
  const confWidth   = Math.round(((mc.p90-mc.p10)/mc.p50)*100);

  return { series, chData, scenarios, sensitivity, histogram, histChart, mc, stats, total, blendedRoas, confWidth, days, anomalies, ga4Metrics };
}

// ═══════════════════════════════════════════════════════
//  AI ENGINE
// ═══════════════════════════════════════════════════════
async function askClaude(prompt) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:1000, messages:[{role:"user",content:prompt}] }),
    });
    const d = await res.json();
    return d.content?.find(b=>b.type==="text")?.text || "Analysis unavailable.";
  } catch { return "Unable to reach Claude API. Please check your connection."; }
}

// ═══════════════════════════════════════════════════════
//  CSV EXPORT
// ═══════════════════════════════════════════════════════
function exportForecastCSV(fc, budgets, days) {
  const rows = [];
  rows.push(["RevenueIQ Probabilistic Forecast Export"]);
  rows.push(["Generated", new Date().toISOString()]);
  rows.push(["Forecast Window (days)", days]);
  rows.push(["Total Budget", fc.total]);
  rows.push([]);
  rows.push(["--- AGGREGATE FORECAST ---"]);
  rows.push(["Metric","P10 Conservative","P50 Most Likely","P90 Optimistic"]);
  rows.push(["Total Revenue", Math.round(fc.mc.p10), Math.round(fc.mc.p50), Math.round(fc.mc.p90)]);
  rows.push(["Blended ROAS", (fc.mc.p10/fc.total).toFixed(2), fc.blendedRoas, (fc.mc.p90/fc.total).toFixed(2)]);
  rows.push([]);
  rows.push(["--- CHANNEL BREAKDOWN ---"]);
  rows.push(["Channel","Budget","Revenue P10","Revenue P50","Revenue P90","ROAS","Trend %"]);
  Object.entries(fc.chData).forEach(([ch,d])=>{
    rows.push([ch, d.budget, Math.round(d.revLow), Math.round(d.revMid), Math.round(d.revHigh), d.roas.toFixed(2), d.trend.toFixed(1)]);
  });
  rows.push([]);
  rows.push(["--- CAMPAIGN-TYPE BREAKDOWN ---"]);
  rows.push(["Channel","Campaign Type","Est Budget","Revenue","ROAS"]);
  Object.entries(fc.chData).forEach(([ch,d])=>{
    Object.entries(d.ctypes||{}).forEach(([ct,c])=>{
      const ctB = d.budget/Math.max(Object.keys(d.ctypes).length,1);
      rows.push([ch, ct, Math.round(ctB), Math.round(ctB*c.avgRoas), c.avgRoas.toFixed(2)]);
    });
  });
  rows.push([]);
  rows.push(["--- INDIVIDUAL CAMPAIGN BREAKDOWN ---"]);
  rows.push(["Channel","Campaign","Budget","Revenue","ROAS","CVR %","AOV","Anomaly"]);
  Object.entries(fc.chData).forEach(([ch,d])=>{
    Object.entries(d.campaigns||{}).forEach(([name,c])=>{
      const cb = d.budget/Math.max(Object.keys(d.campaigns).length,1);
      rows.push([ch, name, Math.round(cb), Math.round(c.revenue), c.roas.toFixed(2), c.cvr.toFixed(2), c.aov.toFixed(2), c.insufficientData?"low-data":(c.anomaly?"YES":"no")]);
    });
  });
  rows.push([]);
  rows.push(["--- SCENARIOS ---"]);
  rows.push(["Scenario","Budget","P10","P50","P90","ROAS"]);
  fc.scenarios.forEach(sc=>{
    rows.push([sc.label, sc.budget, sc.p10, sc.p50, sc.p90, sc.roas]);
  });

  const csv = rows.map(r=>r.map(v=>`"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `RevenueIQ_Forecast_${days}d_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
const money  = n => "$"+Math.round(n).toLocaleString();
const moneyK = n => n>=1e6?`$${(n/1e6).toFixed(2)}M`:`$${Math.round(n/1000)}k`;
const pctFmt = n => (n>=0?"+":"")+n.toFixed(1)+"%";

function useCount(target, ms=900) {
  const [v,setV] = useState(0);
  const ref = useRef({from:0, raf:null});
  useEffect(()=>{
    cancelAnimationFrame(ref.current.raf);
    const from = ref.current.from;
    let start=null;
    const step=ts=>{
      if(!start)start=ts;
      const t=Math.min((ts-start)/ms,1);
      const val = Math.round(from+(target-from)*(1-Math.pow(1-t,3)));
      setV(val);
      if(t<1) ref.current.raf=requestAnimationFrame(step);
      else ref.current.from=target;
    };
    ref.current.raf=requestAnimationFrame(step);
    return ()=>cancelAnimationFrame(ref.current.raf);
  },[target]);
  return v;
}

// ═══════════════════════════════════════════════════════
//  PLATFORM FILE NORMALIZERS
//  Maps each ad platform's native raw-export column schema
//  into the canonical row shape the forecast engine expects:
//  { date, channel, campaign_type, campaign_name, spend,
//    revenue, conversions, clicks, impressions, sessions, aov }
// ═══════════════════════════════════════════════════════
const toNum = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const titleCase = s => (s||"").toLowerCase().replace(/(^|_|\s)([a-z])/g, (_,p,c)=>(p?" ":"")+c.toUpperCase()).trim();

function inferCampaignType(name) {
  const n = (name||"").toLowerCase();
  if (n.includes("prospect"))  return "Prospecting";
  if (n.includes("retarget"))  return "Retargeting";
  if (n.includes("shop"))      return "Shopping";
  if (n.includes("search"))    return "Search";
  return "Other";
}

// ── Bing Ads native export: CampaignId, TimePeriod, Revenue, Spend, Clicks,
//    Impressions, Conversions, CampaignType, DailyBudget, CampaignName ──
function normalizeBingRows(rawRows) {
  return rawRows
    .filter(r => r.TimePeriod)
    .map(r => {
      const spend = toNum(r.Spend), revenue = toNum(r.Revenue), conversions = toNum(r.Conversions), clicks = toNum(r.Clicks);
      return {
        date: (r.TimePeriod||"").trim(),
        channel: "MS Ads",
        campaign_type: titleCase((r.CampaignType||"Other").trim()),
        campaign_name: (r.CampaignName||"Unknown").trim(),
        spend, revenue, conversions, clicks,
        impressions: toNum(r.Impressions),
        sessions: clicks, // Bing export has no site-analytics sessions field; clicks used as proxy
        aov: conversions>0 ? revenue/conversions : 0,
      };
    });
}

// ── Meta Ads native export: campaign_id, date_start, cpc, cpm, ctr, reach,
//    spend, clicks, impressions, conversion, daily_budget, campaign_name ──
// NOTE: Meta's raw export only has ONE ambiguous "conversion" column (fractional
// values, e.g. 183, 163.2) and no separate revenue or conversion-count field.
// We treat it as a conversion-value proxy for revenue, since it isn't a clean
// integer count. If your Meta export actually has a true conversion COUNT and a
// separate revenue/purchase-value column, tell us the exact header names and
// we'll map them precisely instead of using this assumption.
function normalizeMetaRows(rawRows) {
  return rawRows
    .filter(r => r.date_start)
    .map(r => {
      const spend = toNum(r.spend), clicks = toNum(r.clicks), conversionVal = toNum(r.conversion);
      const campaign_name = (r.campaign_name||"Unknown").trim();
      return {
        date: (r.date_start||"").trim(),
        channel: "Meta Ads",
        campaign_type: inferCampaignType(campaign_name),
        campaign_name,
        spend,
        revenue: conversionVal,
        conversions: conversionVal,
        clicks,
        impressions: toNum(r.impressions),
        sessions: clicks,
        aov: 0, // no reliable separate conversion-count field to divide by
      };
    });
}

// ── Google Ads native export: campaign_id, segments_date, metrics_clicks,
//    metrics_conversions, metrics_cost_micros, metrics_impressions,
//    metrics_video_views, metrics_conversions_value, campaign_advertising_channel_type,
//    campaign_budget_amount, campaign_name ──
// metrics_conversions = conversion COUNT, metrics_conversions_value = revenue ($).
// Cost is in micros, so we divide by 1,000,000 to get spend in $.
function normalizeGoogleRows(rawRows) {
  return rawRows
    .filter(r => r.segments_date)
    .map(r => {
      const spend = toNum(r.metrics_cost_micros) / 1e6;
      const conversions = toNum(r.metrics_conversions);
      const revenue = toNum(r.metrics_conversions_value);
      return {
        date: (r.segments_date||"").trim(),
        channel: "Google Ads",
        campaign_type: titleCase((r.campaign_advertising_channel_type||"Other").trim()),
        campaign_name: (r.campaign_name||"Unknown").trim(),
        spend, revenue, conversions,
        clicks: toNum(r.metrics_clicks),
        impressions: toNum(r.metrics_impressions),
        sessions: toNum(r.metrics_clicks),
        aov: conversions>0 ? revenue/conversions : 0,
      };
    });
}


function Card({children, glow, style={}}) {
  return <div style={{background:C.card,border:`1px solid ${glow?C.accentD:C.border}`,borderRadius:14,padding:20,boxShadow:glow?`0 0 48px -12px ${C.accent}44`:"none",...style}}>{children}</div>;
}
function SLabel({children}) {
  return <p style={{margin:"0 0 12px",fontSize:10,fontWeight:700,color:C.faint,letterSpacing:".14em",textTransform:"uppercase"}}>{children}</p>;
}
function Div() { return <div style={{height:1,background:C.border,margin:"14px 0"}}/>; }

function Badge({ch}) {
  const c=CH[ch]||C.accent;
  const icon={Google:"G",Meta:"f",MS:"M"};
  const k=Object.keys(icon).find(k=>ch.includes(k));
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:99,background:c+"18",color:c,border:`1px solid ${c}28`,fontSize:11,fontWeight:700}}>{icon[k]} {ch}</span>;
}
function TrendPill({v}) {
  const up=v>=0;
  return <span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 7px",borderRadius:99,fontSize:11,fontWeight:600,background:(up?C.green:C.red)+"18",color:up?C.green:C.red,border:`1px solid ${(up?C.green:C.red)}28`}}>{up?"▲":"▼"} {Math.abs(v).toFixed(1)}%</span>;
}
function StatusDot({ok}) {
  return <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:ok?C.green:C.amber,marginRight:5}}/>; 
}

const Tip=({active,payload,label})=>{
  if(!active||!payload?.length)return null;
  return <div style={{background:C.raised,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",fontSize:12,minWidth:160}}>
    <p style={{margin:"0 0 7px",color:C.muted,fontWeight:600}}>{label}</p>
    {payload.map((p,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
      <span style={{color:p.color||C.text}}>{p.name}</span>
      <b style={{color:C.text}}>{typeof p.value==="number"?money(p.value):p.value}</b>
    </div>)}
  </div>;
};

function KPICard({label,display,sub,accent}) {
  return <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 18px",borderTop:`2px solid ${accent}`,position:"relative",overflow:"hidden"}}>
    <div style={{position:"absolute",top:-20,right:-20,width:70,height:70,borderRadius:"50%",background:accent+"14"}}/>
    <p style={{margin:"0 0 5px",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",fontWeight:600}}>{label}</p>
    <p style={{margin:"0 0 3px",fontSize:22,fontWeight:800,color:C.text,letterSpacing:"-0.04em",fontVariantNumeric:"tabular-nums"}}>{display}</p>
    {sub&&<p style={{margin:0,fontSize:11,color:C.muted}}>{sub}</p>}
  </div>;
}

function AIBlock({label,icon,prompt,autoRun,triggerKey}) {
  const [text,setText]=useState("");
  const [busy,setBusy]=useState(false);
  const ran=useRef(false);
  const run=useCallback(async()=>{
    if(!prompt)return;
    setBusy(true);setText("");
    setText(await askClaude(prompt));
    setBusy(false);
  },[prompt]);
  useEffect(()=>{ if(autoRun&&prompt&&!ran.current){ran.current=true;run();} },[autoRun,prompt]);
  useEffect(()=>{ if(triggerKey&&autoRun){ran.current=false;} },[triggerKey]);
  return <div style={{background:"rgba(155,109,255,0.05)",border:"1px solid rgba(155,109,255,0.20)",borderRadius:14,padding:18}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:26,height:26,borderRadius:7,background:"linear-gradient(135deg,#9b6dff,#6d28d9)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>{icon}</div>
        <span style={{fontSize:11,fontWeight:700,color:"#b39dff",textTransform:"uppercase",letterSpacing:".1em"}}>{label}</span>
      </div>
      <button onClick={run} disabled={busy} style={{background:"transparent",border:"1px solid rgba(155,109,255,0.22)",borderRadius:6,color:"#9b6dff",fontSize:11,padding:"3px 9px",cursor:busy?"wait":"pointer"}}>↺ Refresh</button>
    </div>
    {busy?<p style={{margin:0,fontSize:13,color:C.muted}}>◌ Analysing with Claude AI…</p>
         :<p style={{margin:0,fontSize:13,color:"#d4c6ff",lineHeight:1.8,whiteSpace:"pre-line"}}>{text||<span style={{color:C.faint}}>Click ↺ to generate</span>}</p>}
  </div>;
}

function EmptyState({go}) {
  return <Card style={{textAlign:"center",padding:"60px 24px"}}>
    <div style={{fontSize:38,marginBottom:10}}>📈</div>
    <p style={{color:C.text,fontSize:15,fontWeight:600,margin:"0 0 6px"}}>No forecast generated yet</p>
    <p style={{color:C.muted,fontSize:13,margin:"0 0 20px"}}>Go to Setup, enter your budget, then click Run Forecast.</p>
    <button onClick={go} style={{padding:"9px 22px",borderRadius:9,background:C.accent,border:"none",color:"white",fontSize:13,fontWeight:600,cursor:"pointer"}}>Go to Setup →</button>
  </Card>;
}

// ═══════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════
const UPLOAD_CHANNELS = [
  { key:"Google Ads", label:"Google Ads CSV" },
  { key:"Meta Ads",   label:"Meta Ads CSV"   },
  { key:"MS Ads",     label:"Bing Ads CSV"   },
];

export default function App() {
  const [tab,      setTab     ] = useState("setup");
  const [csvData,  setCsvData ] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [budgets,  setBudgets ] = useState({"Google Ads":25000,"Meta Ads":18000,"MS Ads":7000});
  const [days,     setDays    ] = useState(30);
  const [fc,       setFc      ] = useState(null);
  const [running,  setRunning ] = useState(false);
  const [aiKey,    setAiKey   ] = useState(0);
  const [customBudgetMult, setCustomBudgetMult] = useState(100);

  // ── Data-source selection (separate / merged / demo) ──
  const [dataMode, setDataMode] = useState(null); // "separate" | "merged" | "demo"
  const [separateFiles, setSeparateFiles] = useState({ "Google Ads":null, "Meta Ads":null, "MS Ads":null }); // {fileName, rows}
  const [mergedFile, setMergedFile] = useState(null); // {fileName, rows}

  const resetDataState = () => {
    setCsvData(null); setFileName(null);
    setSeparateFiles({ "Google Ads":null, "Meta Ads":null, "MS Ads":null });
    setMergedFile(null);
  };

  const chooseDataMode = (mode) => {
    resetDataState();
    setDataMode(mode);
    if (mode === "demo") {
      const r = Papa.parse(SAMPLE_CSV,{header:true,skipEmptyLines:true});
      setCsvData(r.data); setFileName("demo_dataset.csv");
    }
  };

  // Upload one of the 3 per-channel files; normalizes each platform's native
  // export schema into the canonical row shape used by the forecast engine
  const loadSeparateFile = useCallback((channelKey, file) => {
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      const normalizer = channelKey === "Google Ads" ? normalizeGoogleRows
                        : channelKey === "Meta Ads"   ? normalizeMetaRows
                        : normalizeBingRows;
      const rows = normalizer(r.data);
      setSeparateFiles(prev=>({ ...prev, [channelKey]: { fileName:file.name, rows } }));
    }});
  }, []);

  const removeSeparateFile = (channelKey) => {
    setSeparateFiles(prev=>({ ...prev, [channelKey]: null }));
  };

  // Upload the single merged file
  const loadMergedFile = useCallback((file) => {
    Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{
      setMergedFile({ fileName:file.name, rows:r.data });
    }});
  }, []);

  const removeMergedFile = () => setMergedFile(null);

  // Whenever the relevant upload state changes, build the merged csvData used by the forecast engine
  useEffect(()=>{
    if (dataMode === "separate") {
      const allUploaded = UPLOAD_CHANNELS.every(c => separateFiles[c.key]);
      if (allUploaded) {
        const merged = UPLOAD_CHANNELS.flatMap(c => separateFiles[c.key].rows);
        setCsvData(merged);
        setFileName(UPLOAD_CHANNELS.map(c=>separateFiles[c.key].fileName).join(" + "));
      } else {
        setCsvData(null); setFileName(null);
      }
    } else if (dataMode === "merged") {
      if (mergedFile) {
        setCsvData(mergedFile.rows);
        setFileName(mergedFile.fileName);
      } else {
        setCsvData(null); setFileName(null);
      }
    }
  }, [dataMode, separateFiles, mergedFile]);

  // Is there enough data to run a forecast, given the selected mode?
  const isDataReady = (() => {
    if (dataMode === "demo") return true;
    if (dataMode === "separate") return UPLOAD_CHANNELS.every(c => separateFiles[c.key]);
    if (dataMode === "merged") return !!mergedFile;
    return false;
  })();

  const runForecast = () => {
    if (!isDataReady) return;
    setRunning(true);
    setTimeout(()=>{
      const result = buildForecast(csvData||[],budgets,days);
      setFc(result); setRunning(false); setAiKey(k=>k+1); setTab("forecast");
    },600);
  };

  const totalBudget = Object.values(budgets).reduce((a,b)=>a+(b||0),0);

  // Custom budget scenario
  const customBudgets = {};
  Object.keys(budgets).forEach(ch=>{ customBudgets[ch]=(budgets[ch]||0)*(customBudgetMult/100); });
  const customTotal = Object.values(customBudgets).reduce((a,b)=>a+b,0);

  // Animated values
  const animP50   = useCount(fc?.mc.p50||0);
  const animTotal = useCount(fc?.total||0);

  // AI prompts
  const aiPrompts = fc ? (()=>{
    const chLines = Object.entries(fc.chData)
      .map(([ch,d])=>`${ch}: $${money(d.budget)} → P50 $${money(d.revMid)} (ROAS ${d.roas.toFixed(2)}x, trend ${pctFmt(d.trend)})`)
      .join("\n");
    const anomLines = fc.anomalies.length
      ? fc.anomalies.map(a=>`  • ${a.name} (${a.ch}): ROAS ${a.roas.toFixed(2)}x — statistically ${a.dir} outlier`).join("\n")
      : "  • No statistical anomalies detected";
    const campLines = Object.entries(fc.chData).flatMap(([ch,d])=>
      Object.entries(d.campaigns||{}).map(([n,c])=>`${ch} / ${n}: ROAS ${c.roas.toFixed(2)}x, CVR ${c.cvr.toFixed(2)}%, AOV $${c.aov.toFixed(0)}`)
    ).join("\n");

    return {
      executive:`You are a senior ecommerce performance analyst writing a board-level executive brief. Be direct, specific, and professional. No bullet points, no headers.

FORECAST (${fc.days}-day period):
• Budget: $${money(fc.total)} | P10: $${money(fc.mc.p10)} | P50: $${money(fc.mc.p50)} | P90: $${money(fc.mc.p90)}
• Blended ROAS: ${fc.blendedRoas}x | Uncertainty: ±${fc.confWidth}%

CHANNELS:
${chLines}

Conversion data: Avg CVR ${fc.ga4Metrics.avgCvr}%, Avg AOV $${fc.ga4Metrics.avgAov}

Write exactly 5 sharp sentences: (1) overall revenue outlook with range, (2) strongest channel and why, (3) weakest channel and specific gap, (4) what triggers the conservative P10 scenario, (5) one concrete dollar-specific budget action for this week.`,

      anomaly:`You are a marketing data scientist identifying performance anomalies and opportunities.

STATISTICALLY DETECTED ANOMALIES (±1.5 std from channel mean):
${anomLines}

CAMPAIGN-LEVEL DATA:
${campLines}

Conversion data: Avg CVR ${fc.ga4Metrics.avgCvr}%, Avg AOV $${fc.ga4Metrics.avgAov}

Identify: (1) the most significant anomaly and its likely cause, (2) a compounding trend creating a growth opportunity, (3) an operational risk from underperforming segments. 4 sentences maximum. Be specific with numbers.`,

      reallocation:`You are a paid media strategist with $${money(fc.total)} to allocate over ${fc.days} days.

CURRENT PERFORMANCE:
${chLines}

CAMPAIGN DETAIL:
${campLines}

Recommend ONE specific reallocation: state exact dollar amounts, which channel gains, which loses, and the projected ROAS improvement. Then give one conversion rate optimisation suggestion. 3 sentences only.`,

      risk:`You are a risk analyst for a digital marketing agency. Assess operational risks in this forecast.

FORECAST RANGE: P10 $${money(fc.mc.p10)} to P90 $${money(fc.mc.p90)} (±${fc.confWidth}% uncertainty)
CHANNELS: ${chLines}
ANOMALIES: ${anomLines}

Identify the top 3 operational risks that could cause actual revenue to fall below P10, with specific triggers and one mitigation action per risk. Be concise and actionable.`,
    };
  })() : {};

  const TABS = [
    {id:"setup",     label:"Setup",      icon:"⚙"},
    {id:"forecast",  label:"Forecast",   icon:"📈"},
    {id:"scenarios", label:"Scenarios",  icon:"⚖"},
    {id:"campaigns", label:"Campaigns",  icon:"🎯"},
    {id:"insights",  label:"AI Insights",icon:"✦"},
  ];

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"system-ui,-apple-system,sans-serif"}}>
      <style>{`
        *{box-sizing:border-box}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
        input[type=number]{-moz-appearance:textfield}
        input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:${C.dim};border-radius:2px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:${C.accent};cursor:pointer;border:2px solid ${C.bg}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${C.surface}}
        ::-webkit-scrollbar-thumb{background:${C.dim};border-radius:2px}
        .row-h:hover{background:${C.raised}!important;transition:background .12s}
      `}</style>

      {/* ── NAV ── */}
      <header style={{background:C.surface+"f9",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,zIndex:200,backdropFilter:"blur(16px)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
              <rect width="30" height="30" rx="8" fill={C.accent}/>
              <polyline points="5,22 9,15 13,18 17,11 21,14 25,8" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="25" cy="8" r="2.5" fill={C.green}/>
            </svg>
            <div>
              <div style={{fontSize:13,fontWeight:800,letterSpacing:"-0.05em",lineHeight:1}}>RevenueIQ</div>
              <div style={{fontSize:9,color:C.muted,letterSpacing:".14em",textTransform:"uppercase"}}>Probabilistic Forecasting · NetElixir</div>
            </div>
          </div>
          {fc&&<div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:C.green}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite"}}/>
            {fc.days}d forecast active · {fc.anomalies.length} anomal{fc.anomalies.length===1?"y":"ies"} detected
          </div>}
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {fc&&<button onClick={()=>exportForecastCSV(fc,budgets,days)} style={{padding:"6px 14px",borderRadius:8,background:"transparent",border:`1px solid ${C.border}`,color:C.muted,fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
              ⬇ Export CSV
            </button>}
            <button onClick={runForecast} disabled={running||!isDataReady} title={!isDataReady?"Upload the required data in Setup first":""} style={{padding:"8px 18px",borderRadius:9,fontSize:12,fontWeight:700,background:running?C.dim:(!isDataReady?C.dim:`linear-gradient(135deg,${C.accent},${C.accentD})`),border:"none",color:"white",cursor:running?"wait":(!isDataReady?"not-allowed":"pointer"),opacity:!isDataReady&&!running?0.55:1,boxShadow:running||!isDataReady?"none":`0 4px 20px ${C.accent}44`}}>
              {running?"◌ Simulating…":"▶ Run Forecast"}
            </button>
          </div>
        </div>
        <div style={{display:"flex",overflowX:"auto",padding:"0 8px",scrollbarWidth:"none"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{flexShrink:0,padding:"8px 14px",background:"transparent",border:"none",borderBottom:`2px solid ${tab===t.id?C.accent:"transparent"}`,color:tab===t.id?C.accent:C.muted,fontSize:12,fontWeight:tab===t.id?700:400,cursor:"pointer",whiteSpace:"nowrap",transition:"color .15s"}}>
              {t.icon}  {t.label}
            </button>
          ))}
        </div>
      </header>

      <main style={{maxWidth:900,margin:"0 auto",padding:"20px 14px 80px"}}>

        {/* ════ SETUP ════ */}
        {tab==="setup"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeUp .25s ease"}}>
            <Card>
              <SLabel>Step 1 — Historical Data</SLabel>
              <p style={{margin:"0 0 12px",fontSize:12,color:C.muted}}>Choose how you'd like to provide your historical channel data.</p>

              {/* Mode picker */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
                {[
                  {id:"separate", label:"Upload Separate Files", desc:"One CSV per channel", icon:"📑"},
                  {id:"merged",   label:"Upload Merged File",    desc:"One combined CSV",    icon:"🗂"},
                  {id:"demo",     label:"Demo Dataset",          desc:"Use sample data",      icon:"🧪"},
                ].map(opt=>(
                  <button key={opt.id} onClick={()=>chooseDataMode(opt.id)} style={{padding:"12px 10px",borderRadius:10,background:dataMode===opt.id?C.accent+"18":C.surface,border:`1px solid ${dataMode===opt.id?C.accent:C.border}`,color:dataMode===opt.id?C.accent:C.muted,textAlign:"center",cursor:"pointer",transition:"all .15s"}}>
                    <div style={{fontSize:18,marginBottom:4}}>{opt.icon}</div>
                    <div style={{fontSize:12,fontWeight:dataMode===opt.id?700:600,color:dataMode===opt.id?C.accent:C.text}}>{opt.label}</div>
                    <div style={{fontSize:10,color:C.faint,marginTop:2}}>{opt.desc}</div>
                  </button>
                ))}
              </div>

              {/* ── SEPARATE FILES MODE ── */}
              {dataMode==="separate"&&(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {UPLOAD_CHANNELS.map(c=>{
                    const uploaded = separateFiles[c.key];
                    return <div key={c.key} style={{border:`1px solid ${uploaded?C.green+"30":C.border}`,borderRadius:10,padding:"10px 12px",background:uploaded?C.green+"0a":C.surface}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <Badge ch={c.key}/>
                          <span style={{fontSize:11,color:C.muted}}>{c.label}</span>
                        </div>
                        {uploaded
                          ?<button onClick={()=>removeSeparateFile(c.key)} style={{background:"transparent",border:`1px solid ${C.red}40`,borderRadius:6,color:C.red,fontSize:11,padding:"3px 9px",cursor:"pointer"}}>✕ Remove</button>
                          :<label style={{color:C.accent,cursor:"pointer",fontSize:11,fontWeight:600,textDecoration:"underline"}}>
                              Upload
                              <input type="file" accept=".csv" style={{display:"none"}} onChange={e=>e.target.files[0]&&loadSeparateFile(c.key,e.target.files[0])}/>
                            </label>
                        }
                      </div>
                      {uploaded&&<div style={{marginTop:7,fontSize:11,color:C.green}}>✓ {uploaded.fileName} — {uploaded.rows.length} rows loaded</div>}
                    </div>;
                  })}
                  <p style={{margin:"2px 0 0",fontSize:11,color:C.faint}}>Upload each platform's native export as-is — Google Ads, Meta Ads and Bing Ads each have different column names, and the app automatically maps them. No manual renaming needed. The three files are merged automatically once all are uploaded.</p>
                </div>
              )}

              {/* ── MERGED FILE MODE ── */}
              {dataMode==="merged"&&(
                <div>
                  {!mergedFile?(
                    <div onDrop={e=>{e.preventDefault();e.dataTransfer.files[0]&&loadMergedFile(e.dataTransfer.files[0]);}} onDragOver={e=>e.preventDefault()} style={{border:`2px dashed ${C.border}`,borderRadius:12,padding:"28px 16px",textAlign:"center",background:C.surface}}>
                      <div style={{fontSize:24,marginBottom:6}}>📤</div>
                      <p style={{margin:"0 0 3px",fontSize:13,color:C.muted}}>
                        Drop CSV here or <label style={{color:C.accent,cursor:"pointer",textDecoration:"underline"}}>browse<input type="file" accept=".csv" style={{display:"none"}} onChange={e=>e.target.files[0]&&loadMergedFile(e.target.files[0])}/></label>
                      </p>
                      <p style={{margin:0,fontSize:11,color:C.faint}}>date · channel · campaign_type · campaign_name · spend · revenue · conversions · clicks · sessions · aov</p>
                    </div>
                  ):(
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",background:C.green+"12",border:`1px solid ${C.green}28`,borderRadius:8}}>
                      <span style={{fontSize:12,color:C.green}}>✓ {mergedFile.fileName} — {mergedFile.rows.length} rows loaded</span>
                      <button onClick={removeMergedFile} style={{background:"transparent",border:`1px solid ${C.red}40`,borderRadius:6,color:C.red,fontSize:11,padding:"3px 9px",cursor:"pointer"}}>✕ Remove</button>
                    </div>
                  )}
                </div>
              )}

              {/* ── DEMO MODE ── */}
              {dataMode==="demo"&&(
                <div style={{padding:"9px 12px",background:C.green+"12",border:`1px solid ${C.green}28`,borderRadius:8,fontSize:12,color:C.green}}>
                  ✓ Demo dataset loaded — {csvData?.length||0} rows across Google Ads, Meta Ads and Bing Ads
                </div>
              )}

              {!dataMode&&(
                <p style={{margin:0,fontSize:12,color:C.faint,textAlign:"center",padding:"6px 0"}}>Select an option above to get started.</p>
              )}

              {csvData?.length>0&&(
                <div style={{marginTop:14,overflowX:"auto"}}>
                  <SLabel>Data preview</SLabel>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr>{Object.keys(csvData[0]).slice(0,7).map(k=><th key={k} style={{padding:"5px 9px",color:C.muted,textAlign:"left",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",fontWeight:600}}>{k}</th>)}</tr></thead>
                    <tbody>{csvData.slice(0,4).map((row,i)=><tr key={i} className="row-h">{Object.values(row).slice(0,7).map((v,j)=><td key={j} style={{padding:"5px 9px",color:C.muted,borderBottom:`1px solid ${C.border}22`,whiteSpace:"nowrap"}}>{v}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <SLabel>Step 2 — Future Media Budget</SLabel>
              {["Google Ads","Meta Ads","MS Ads"].map(ch=>{
                const pct=totalBudget>0?Math.round((budgets[ch]||0)/totalBudget*100):0;
                const col=CH[ch];
                return <div key={ch} style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><Badge ch={ch}/><span style={{fontSize:11,color:C.muted}}>{pct}%</span></div>
                  <div style={{position:"relative"}}>
                    <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:C.muted,fontSize:13}}>$</span>
                    <input type="number" value={budgets[ch]||""} onChange={e=>setBudgets(b=>({...b,[ch]:parseFloat(e.target.value)||0}))}
                      style={{width:"100%",padding:"10px 12px 10px 22px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,color:C.text,fontSize:14,outline:"none"}}
                      onFocus={e=>e.target.style.borderColor=C.accent}
                      onBlur={e=>e.target.style.borderColor=C.border}/>
                  </div>
                  <div style={{marginTop:5,height:3,background:C.surface,borderRadius:99}}>
                    <div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:99,transition:"width .3s ease"}}/>
                  </div>
                </div>;
              })}
              <Div/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.muted}}>Total budget</span>
                <span style={{fontSize:18,fontWeight:800,fontVariantNumeric:"tabular-nums"}}>{money(totalBudget)}</span>
              </div>
            </Card>

            <Card>
              <SLabel>Step 3 — Forecast Window</SLabel>
              <div style={{display:"flex",gap:10}}>
                {[30,60,90].map(d=>(
                  <button key={d} onClick={()=>setDays(d)} style={{flex:1,padding:"12px 0",borderRadius:10,background:days===d?C.accent+"18":C.surface,border:`1px solid ${days===d?C.accent:C.border}`,color:days===d?C.accent:C.muted,fontSize:14,fontWeight:days===d?700:400,cursor:"pointer",transition:"all .15s"}}>
                    {d}<span style={{fontSize:11,fontWeight:400}}> days</span>
                  </button>
                ))}
              </div>
            </Card>

            <button onClick={runForecast} disabled={running||!isDataReady} style={{padding:"14px",borderRadius:12,fontSize:14,fontWeight:700,background:running?C.dim:(!isDataReady?C.dim:`linear-gradient(135deg,${C.accent},${C.accentD})`),border:"none",color:"white",cursor:running?"wait":(!isDataReady?"not-allowed":"pointer"),opacity:!isDataReady&&!running?0.55:1,boxShadow:running||!isDataReady?"none":`0 6px 28px ${C.accent}44`,transition:"box-shadow .2s"}}>
              {running?"◌  Running Monte Carlo Simulation (800 iterations)…":(!isDataReady?"Upload required data above to continue":"▶  Generate Probabilistic Forecast")}
            </button>
            {!isDataReady&&dataMode&&(
              <p style={{margin:"-8px 0 0",fontSize:11,color:C.amber,textAlign:"center"}}>
                {dataMode==="separate"&&"Upload all 3 channel CSVs above to enable forecasting."}
                {dataMode==="merged"&&"Upload your merged CSV above to enable forecasting."}
              </p>
            )}
            {!dataMode&&(
              <p style={{margin:"-8px 0 0",fontSize:11,color:C.amber,textAlign:"center"}}>Choose a data source above to enable forecasting.</p>
            )}
          </div>
        )}

        {/* ════ FORECAST ════ */}
        {tab==="forecast"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeUp .25s ease"}}>
            {!fc?<EmptyState go={()=>setTab("setup")}/>:<>
              {/* KPIs */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <KPICard label="Most Likely Revenue (P50)" display={moneyK(animP50)} sub={`${moneyK(fc.mc.p10)} – ${moneyK(fc.mc.p90)}`} accent={C.accent}/>
                <KPICard label="Blended ROAS" display={`${fc.blendedRoas}×`} sub="Revenue per $1 spend" accent={C.purple}/>
                <KPICard label="Total Budget" display={moneyK(animTotal)} sub={`${fc.days}-day period`} accent={C.green}/>
                <KPICard label="Uncertainty Range" display={`±${fc.confWidth}%`} sub="P10–P90 confidence band" accent={C.amber}/>
              </div>

              {/* Conversion metrics row */}
              <Card>
                <SLabel>Performance Metrics</SLabel>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                  {[
                    {label:"Avg Conversion Rate", value:fc.ga4Metrics.avgCvr+"%", accent:C.green},
                    {label:"Avg Order Value",      value:"$"+fc.ga4Metrics.avgAov, accent:C.amber},
                    {label:"Total Conversions",    value:fc.ga4Metrics.totalConv.toLocaleString(), accent:C.accent},
                  ].map(m=>(
                    <div key={m.label} style={{background:C.surface,borderRadius:10,padding:"12px 14px",borderLeft:`3px solid ${m.accent}`}}>
                      <p style={{margin:"0 0 4px",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".1em"}}>{m.label}</p>
                      <p style={{margin:0,fontSize:18,fontWeight:800,color:C.text}}>{m.value}</p>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:12}}>
                  {fc.ga4Metrics.byChannel.map(b=>(
                    <div key={b.ch} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${C.border}22`}}>
                      <Badge ch={b.ch}/>
                      <span style={{fontSize:12,color:C.muted}}>Sessions: <b style={{color:C.text}}>{b.sessions.toLocaleString()}</b></span>
                      <span style={{fontSize:12,color:C.muted}}>CVR: <b style={{color:C.green}}>{b.cvr}%</b></span>
                      <span style={{fontSize:12,color:C.muted}}>Conv: <b style={{color:C.text}}>{b.conv.toLocaleString()}</b></span>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Revenue band chart */}
              <Card glow>
                <SLabel>Cumulative Revenue Forecast — {fc.days}-Day Probability Bands</SLabel>
                <p style={{margin:"0 0 14px",fontSize:11,color:C.faint}}>P10–P90 band from 800 Monte Carlo simulations. Solid line = P50 median. Dashed = confidence bounds.</p>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={fc.series} margin={{top:8,right:4,bottom:0,left:0}}>
                    <defs>
                      <linearGradient id="gH" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.accent} stopOpacity={.12}/>
                        <stop offset="100%" stopColor={C.accent} stopOpacity={.01}/>
                      </linearGradient>
                      <linearGradient id="gM" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.accent} stopOpacity={.30}/>
                        <stop offset="100%" stopColor={C.accent} stopOpacity={.04}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                    <XAxis dataKey="day" tick={{fill:C.faint,fontSize:10}}/>
                    <YAxis tickFormatter={moneyK} tick={{fill:C.faint,fontSize:10}} width={54}/>
                    <Tooltip content={<Tip/>}/>
                    <Area type="monotone" dataKey="high" name="P90 Optimistic"   stroke={C.accent+"50"} strokeWidth={1} strokeDasharray="5 4" fill="url(#gH)"/>
                    <Area type="monotone" dataKey="mid"  name="P50 Most Likely"  stroke={C.accent}      strokeWidth={2.5}                    fill="url(#gM)"/>
                    <Area type="monotone" dataKey="low"  name="P10 Conservative" stroke={C.accent+"50"} strokeWidth={1} strokeDasharray="5 4" fill={C.bg}/>
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              {/* Channel breakdown */}
              <Card>
                <SLabel>Channel Revenue Breakdown</SLabel>
                {Object.entries(fc.chData).map(([ch,d])=>{
                  const totMid=Object.values(fc.chData).reduce((s,x)=>s+x.revMid,0);
                  const share=Math.round(d.revMid/(totMid||1)*100);
                  const col=CH[ch];
                  return <div key={ch} style={{background:C.surface,borderRadius:12,padding:14,marginBottom:10,border:`1px solid ${C.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9}}>
                      <Badge ch={ch}/>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:17,fontWeight:800}}>{money(d.revMid)}</div>
                        <div style={{fontSize:10,color:C.muted,marginTop:2}}>{money(d.revLow)} – {money(d.revHigh)}</div>
                      </div>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:"6px 16px",fontSize:12,marginBottom:8}}>
                      <span style={{color:C.muted}}>Budget: <b style={{color:C.text}}>{money(d.budget)}</b></span>
                      <span style={{color:C.muted}}>ROAS: <b style={{color:col}}>{d.roas.toFixed(2)}×</b></span>
                      <span style={{color:C.muted}}>Share: <b style={{color:C.text}}>{share}%</b></span>
                      <TrendPill v={d.trend}/>
                    </div>
                    <div style={{height:4,background:C.card,borderRadius:99}}>
                      <div style={{height:"100%",width:`${share}%`,background:col,borderRadius:99,transition:"width .4s ease"}}/>
                    </div>
                  </div>;
                })}
              </Card>

              {/* Probability histogram */}
              <Card>
                <SLabel>Revenue Probability Distribution — 800 Simulations</SLabel>
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart data={fc.histogram} margin={{top:5,right:4,bottom:0,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                    <XAxis dataKey="r" tick={{fill:C.faint,fontSize:9}} interval={3}/>
                    <YAxis hide/>
                    <Tooltip contentStyle={{background:C.raised,border:`1px solid ${C.border}`,borderRadius:8,fontSize:11}}/>
                    <Bar dataKey="count" name="Simulations" radius={[3,3,0,0]}>
                      {fc.histogram.map((e,i)=>{
                        const mx=Math.max(...fc.histogram.map(h=>h.count));
                        return <Cell key={i} fill={e.count>=mx*.75?C.accent:C.accentD+"80"}/>;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:12,padding:"10px 14px",background:C.surface,borderRadius:10}}>
                  {[{l:"P10 Conservative",v:moneyK(fc.mc.p10),c:C.red},{l:"P50 Most Likely",v:moneyK(fc.mc.p50),c:C.accent},{l:"P90 Optimistic",v:moneyK(fc.mc.p90),c:C.green}].map(s=>(
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:15,fontWeight:800,color:s.c}}>{s.v}</div>
                      <div style={{fontSize:9,color:C.faint,marginTop:2}}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Export prompt */}
              <div style={{padding:"12px 16px",background:C.green+"0e",border:`1px solid ${C.green}28`,borderRadius:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.muted}}>Download full forecast with all channel, campaign-type and campaign-level data</span>
                <button onClick={()=>exportForecastCSV(fc,budgets,days)} style={{padding:"7px 14px",borderRadius:8,background:C.green,border:"none",color:C.bg,fontSize:12,fontWeight:700,cursor:"pointer"}}>⬇ Export CSV</button>
              </div>
            </>}
          </div>
        )}

        {/* ════ SCENARIOS ════ */}
        {tab==="scenarios"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeUp .25s ease"}}>
            {!fc?<EmptyState go={()=>setTab("setup")}/>:<>

              {/* Custom budget slider */}
              <Card>
                <SLabel>Custom Budget Simulator</SLabel>
                <p style={{margin:"0 0 14px",fontSize:12,color:C.muted}}>Drag the slider to simulate any budget level and instantly see the revenue forecast change.</p>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
                  <span style={{fontSize:12,color:C.muted,minWidth:60}}>Budget</span>
                  <input type="range" min={50} max={200} step={5} value={customBudgetMult} onChange={e=>setCustomBudgetMult(+e.target.value)} style={{flex:1}}/>
                  <span style={{fontSize:13,fontWeight:700,color:C.accent,minWidth:50,textAlign:"right"}}>{customBudgetMult}%</span>
                </div>
                {(()=>{
                  const sens = fc.sensitivity.find(s=>s.mult===Math.round(customBudgetMult/5)*5)||fc.sensitivity[Math.floor((customBudgetMult-50)/10)];
                  const customB = totalBudget*(customBudgetMult/100);
                  const sb = {};
                  Object.keys(budgets).forEach(ch=>{sb[ch]=(budgets[ch]||0)*(customBudgetMult/100);});
                  const cmc = monteCarlo(sb, fc.stats, 200);
                  return <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                    <div style={{background:C.surface,borderRadius:10,padding:"12px 14px",borderLeft:`3px solid ${C.accent}`}}>
                      <p style={{margin:"0 0 3px",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".1em"}}>Budget</p>
                      <p style={{margin:0,fontSize:18,fontWeight:800}}>{money(customB)}</p>
                    </div>
                    <div style={{background:C.surface,borderRadius:10,padding:"12px 14px",borderLeft:`3px solid ${C.green}`}}>
                      <p style={{margin:"0 0 3px",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".1em"}}>P50 Revenue</p>
                      <p style={{margin:0,fontSize:18,fontWeight:800,color:C.green}}>{money(cmc.p50)}</p>
                    </div>
                    <div style={{background:C.surface,borderRadius:10,padding:"12px 14px",borderLeft:`3px solid ${C.purple}`}}>
                      <p style={{margin:"0 0 3px",fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:".1em"}}>Blended ROAS</p>
                      <p style={{margin:0,fontSize:18,fontWeight:800,color:C.purple}}>{customB>0?(cmc.p50/customB).toFixed(2):0}×</p>
                    </div>
                  </div>;
                })()}

                {/* Sensitivity curve */}
                <div style={{marginTop:16}}>
                  <SLabel>Budget vs Revenue Sensitivity Curve</SLabel>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={fc.sensitivity} margin={{top:5,right:4,bottom:0,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="mult" tick={{fill:C.faint,fontSize:10}} tickFormatter={v=>`${v}%`}/>
                      <YAxis tickFormatter={moneyK} tick={{fill:C.faint,fontSize:10}} width={54}/>
                      <Tooltip content={<Tip/>}/>
                      <ReferenceLine x={customBudgetMult} stroke={C.amber} strokeDasharray="4 3" label={{value:"You",fill:C.amber,fontSize:10}}/>
                      <Line type="monotone" dataKey="p50" name="P50 Revenue" stroke={C.accent} strokeWidth={2.5} dot={false}/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* 4 preset scenarios */}
              <Card>
                <SLabel>Preset Budget Scenarios</SLabel>
                {fc.scenarios.map(sc=>{
                  const isBase=sc.label==="Planned";
                  const barW=Math.round(sc.p50/fc.scenarios[3].p50*100);
                  return <div key={sc.label} style={{background:isBase?C.accent+"0d":C.surface,border:`1px solid ${isBase?C.accentD:C.border}`,borderRadius:12,padding:"13px 15px",marginBottom:10,position:"relative"}}>
                    {isBase&&<div style={{position:"absolute",top:-9,left:14,background:C.accent,color:"white",fontSize:9,fontWeight:800,padding:"2px 9px",borderRadius:99,letterSpacing:".08em",textTransform:"uppercase"}}>Your plan</div>}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <div>
                        <p style={{margin:"0 0 2px",fontSize:12,color:C.muted,fontWeight:600}}>{sc.label}</p>
                        <p style={{margin:0,fontSize:21,fontWeight:800}}>{moneyK(sc.p50)}</p>
                        <p style={{margin:"2px 0 0",fontSize:10,color:C.muted}}>{moneyK(sc.p10)} – {moneyK(sc.p90)}</p>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <p style={{margin:0,fontSize:11,color:C.muted}}>Budget: <b style={{color:C.text}}>{moneyK(sc.budget)}</b></p>
                        <p style={{margin:"3px 0 0",fontSize:11,color:C.muted}}>ROAS: <b style={{color:C.accentL}}>{sc.roas}×</b></p>
                      </div>
                    </div>
                    <div style={{marginTop:9,height:3,background:C.card,borderRadius:99}}>
                      <div style={{height:"100%",width:`${barW}%`,background:isBase?C.accent:C.dim,borderRadius:99}}/>
                    </div>
                  </div>;
                })}
              </Card>

              {/* Scenario chart */}
              <Card>
                <SLabel>Scenario Revenue Chart</SLabel>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={fc.scenarios} margin={{top:5,right:4,bottom:10,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                    <XAxis dataKey="label" tick={{fill:C.faint,fontSize:11}}/>
                    <YAxis tickFormatter={moneyK} tick={{fill:C.faint,fontSize:10}} width={54}/>
                    <Tooltip content={<Tip/>}/>
                    <Bar dataKey="p50" name="P50 Revenue"  fill={C.accent}      radius={[4,4,0,0]}/>
                    <Bar dataKey="p10" name="P10 Revenue"  fill={C.red+"80"}    radius={[4,4,0,0]}/>
                    <Bar dataKey="p90" name="P90 Revenue"  fill={C.green+"80"}  radius={[4,4,0,0]}/>
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              {/* Channel ranking */}
              <Card>
                <SLabel>Channel Efficiency Ranking</SLabel>
                {Object.entries(fc.chData).sort((a,b)=>b[1].roas-a[1].roas).map(([ch,d],i)=>{
                  const col=CH[ch];
                  const maxR=Math.max(...Object.values(fc.chData).map(x=>x.roas));
                  return <div key={ch} style={{background:C.surface,borderRadius:12,padding:13,marginBottom:10,border:`1px solid ${C.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:20}}>{["🥇","🥈","🥉"][i]}</span>
                        <Badge ch={ch}/>
                      </div>
                      <span style={{fontSize:24,fontWeight:900,color:col}}>{d.roas.toFixed(2)}×</span>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:"5px 16px",fontSize:12}}>
                      <span style={{color:C.muted}}>Spend: <b style={{color:C.text}}>{money(d.budget)}</b></span>
                      <span style={{color:C.muted}}>Revenue: <b style={{color:C.green}}>{money(d.revMid)}</b></span>
                      <TrendPill v={d.trend}/>
                    </div>
                    <div style={{marginTop:7,height:3,background:C.card,borderRadius:99}}>
                      <div style={{height:"100%",width:`${Math.round(d.roas/maxR*100)}%`,background:col,borderRadius:99}}/>
                    </div>
                  </div>;
                })}
              </Card>
            </>}
          </div>
        )}

        {/* ════ CAMPAIGNS ════ */}
        {tab==="campaigns"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeUp .25s ease"}}>
            {!fc?<EmptyState go={()=>setTab("setup")}/>:<>

              {/* Anomaly alerts */}
              {fc.anomalies.length>0&&(
                <div style={{background:C.amber+"0e",border:`1px solid ${C.amber}30`,borderRadius:12,padding:"12px 16px"}}>
                  <p style={{margin:"0 0 8px",fontSize:11,fontWeight:700,color:C.amber,textTransform:"uppercase",letterSpacing:".1em"}}>⚠ Statistical Anomalies Detected</p>
                  {fc.anomalies.map((a,i)=>(
                    <div key={i} style={{fontSize:12,color:C.muted,marginBottom:4,display:"flex",gap:8,alignItems:"center"}}>
                      <span style={{color:a.dir==="high"?C.green:C.red}}>{a.dir==="high"?"▲ HIGH":"▼ LOW"}</span>
                      <b style={{color:C.text}}>{a.name}</b> ({a.ch}) — ROAS {a.roas.toFixed(2)}× is a statistical outlier vs channel average
                    </div>
                  ))}
                </div>
              )}

              {/* Campaign-type level */}
              <Card>
                <SLabel>Campaign-Type Level Forecast</SLabel>
                {Object.entries(fc.chData).map(([ch,d])=>(
                  Object.keys(d.ctypes).length>0&&(
                    <div key={ch} style={{marginBottom:18}}>
                      <div style={{marginBottom:8}}><Badge ch={ch}/></div>
                      {Object.entries(d.ctypes).map(([ct,ctD])=>{
                        const ctB=d.budget/Math.max(Object.keys(d.ctypes).length,1);
                        return <div key={ct} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",background:C.surface,borderRadius:9,marginBottom:5,border:`1px solid ${C.border}`}}>
                          <span style={{fontSize:12,padding:"2px 8px",background:C.card,borderRadius:6,color:C.muted}}>{ct}</span>
                          <div style={{display:"flex",gap:16,fontSize:12,alignItems:"center"}}>
                            <span style={{color:C.muted}}>Budget: <b style={{color:C.text}}>{money(ctB)}</b></span>
                            <span style={{color:C.muted}}>ROAS: <b style={{color:CH[ch]}}>{ctD.avgRoas.toFixed(2)}×</b></span>
                            <span style={{color:C.green,fontWeight:700}}>{money(ctB*ctD.avgRoas)}</span>
                          </div>
                        </div>;
                      })}
                    </div>
                  )
                ))}
              </Card>

              {/* Individual campaign table */}
              <Card>
                <SLabel>Individual Campaign Level Forecast</SLabel>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr>{["Channel","Campaign","Est Budget","Revenue","ROAS","CVR %","AOV","Status"].map(h=>(
                        <th key={h} style={{padding:"7px 10px",color:C.muted,textAlign:"left",borderBottom:`1px solid ${C.border}`,fontWeight:600,fontSize:10,textTransform:"uppercase",letterSpacing:".07em",whiteSpace:"nowrap"}}>{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {Object.entries(fc.chData).flatMap(([ch,d])=>
                        Object.entries(d.campaigns||{}).map(([name,c])=>{
                          const cb=d.budget/Math.max(Object.keys(d.campaigns).length,1);
                          return <tr key={`${ch}-${name}`} className="row-h" style={{transition:"background .12s"}}>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`}}><Badge ch={ch}/></td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`,color:C.text,fontWeight:600}}>{name}</td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`,color:C.muted,fontVariantNumeric:"tabular-nums"}}>{money(cb)}</td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`,color:C.green,fontWeight:700,fontVariantNumeric:"tabular-nums"}}>{money(c.revenue)}</td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`}}><span style={{color:CH[ch],fontWeight:700}}>{c.roas.toFixed(2)}×</span></td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`,color:C.muted}}>{c.cvr.toFixed(2)}%</td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`,color:C.muted}}>{c.aov>0?"$"+c.aov.toFixed(0):"—"}</td>
                            <td style={{padding:"8px 10px",borderBottom:`1px solid ${C.border}22`}}>
                              {c.insufficientData
                                ?<span style={{fontSize:10,padding:"2px 7px",borderRadius:99,background:C.faint+"18",color:C.muted,fontWeight:700}}>Low data</span>
                                :c.anomaly
                                ?<span style={{fontSize:10,padding:"2px 7px",borderRadius:99,background:(c.anomalyDir==="high"?C.green:C.red)+"18",color:c.anomalyDir==="high"?C.green:C.red,fontWeight:700}}>{c.anomalyDir==="high"?"▲ HIGH":"▼ LOW"}</span>
                                :<span style={{fontSize:10,color:C.faint}}>Normal</span>}
                            </td>
                          </tr>;
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* Historical chart */}
              {fc.histChart.length>0&&(
                <Card>
                  <SLabel>Historical Channel Revenue (from uploaded data)</SLabel>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={fc.histChart} margin={{top:5,right:4,bottom:20,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="date" tick={{fill:C.faint,fontSize:10}}/>
                      <YAxis tickFormatter={moneyK} tick={{fill:C.faint,fontSize:10}} width={54}/>
                      <Tooltip content={<Tip/>}/>
                      <Legend wrapperStyle={{fontSize:10,color:C.muted,paddingTop:10}}/>
                      <Bar dataKey="Google Ads" fill={C.google} radius={[3,3,0,0]}/>
                      <Bar dataKey="Meta Ads"   fill={C.meta}   radius={[3,3,0,0]}/>
                      <Bar dataKey="MS Ads"     fill={C.msft}   radius={[3,3,0,0]}/>
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              )}
            </>}
          </div>
        )}

        {/* ════ AI INSIGHTS ════ */}
        {tab==="insights"&&(
          <div style={{display:"flex",flexDirection:"column",gap:16,animation:"fadeUp .25s ease"}}>
            {!fc?<EmptyState go={()=>setTab("setup")}/>:<>
              <div style={{padding:"12px 16px",background:"rgba(155,109,255,0.07)",border:"1px solid rgba(155,109,255,0.20)",borderRadius:10,fontSize:12,color:C.muted}}>
                ✦ <b style={{color:C.text}}>Claude AI</b> analyses your real forecast data — ROAS, budgets, statistical anomalies, sessions, AOV and conversion rates. Four independent analyses generated automatically.
              </div>

              <AIBlock key={`exec-${aiKey}`}   label="Executive Summary"                    icon="📋" prompt={aiPrompts.executive}    autoRun triggerKey={aiKey}/>
              <AIBlock key={`anom-${aiKey}`}   label="Anomaly & Opportunity Detection"      icon="🔍" prompt={aiPrompts.anomaly}      autoRun triggerKey={aiKey}/>
              <AIBlock key={`alloc-${aiKey}`}  label="Budget Reallocation Recommendation"   icon="💡" prompt={aiPrompts.reallocation} autoRun triggerKey={aiKey}/>
              <AIBlock key={`risk-${aiKey}`}   label="Operational Risk Assessment"          icon="⚠" prompt={aiPrompts.risk}         autoRun triggerKey={aiKey}/>

              {/* Full summary card */}
              <Card>
                <SLabel>Forecast Summary — Submission Report</SLabel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {[
                    {label:"Forecast Window",   value:`${fc.days} days`},
                    {label:"Total Budget",       value:money(fc.total)},
                    {label:"P50 Revenue",        value:moneyK(fc.mc.p50)},
                    {label:"P10 Conservative",   value:moneyK(fc.mc.p10)},
                    {label:"P90 Optimistic",     value:moneyK(fc.mc.p90)},
                    {label:"Blended ROAS",       value:`${fc.blendedRoas}×`},
                    {label:"Uncertainty Range",  value:`±${fc.confWidth}%`},
                    {label:"Anomalies Flagged",  value:`${fc.anomalies.length} campaigns`},
                    {label:"Avg CVR",            value:`${fc.ga4Metrics.avgCvr}%`},
                    {label:"Avg AOV",            value:`$${fc.ga4Metrics.avgAov}`},
                    {label:"Simulation Method",  value:"Monte Carlo · 800 iter"},
                    {label:"Model",              value:"ROAS × Trend × Seasonality"},
                  ].map(item=>(
                    <div key={item.label} style={{background:C.surface,borderRadius:9,padding:"11px 13px",border:`1px solid ${C.border}`}}>
                      <div style={{fontSize:9,color:C.faint,textTransform:"uppercase",letterSpacing:".1em",marginBottom:3,fontWeight:600}}>{item.label}</div>
                      <div style={{fontSize:13,fontWeight:700,color:C.text}}>{item.value}</div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:14}}>
                  <button onClick={()=>exportForecastCSV(fc,budgets,days)} style={{width:"100%",padding:"11px",borderRadius:9,background:C.accent,border:"none",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>⬇ Download Full Forecast Report (CSV)</button>
                </div>
              </Card>
            </>}
          </div>
        )}

      </main>
    </div>
  );
}
