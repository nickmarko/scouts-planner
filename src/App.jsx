import { useState, useMemo, useEffect } from "react";
import Papa from "papaparse";
import {
  Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, BarChart
} from "recharts";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const FALLBACK_DATA = {
  year1: { label: "Year 1", membership: [1820,1790,1810,1840,1830,1740,1680,1720,2050,2110,2080,1980], finance: [1200,-800,400,600,-1200,-4800,-3600,300,7200,1800,-2400,-1800] },
  year2: { label: "Year 2", membership: [1910,1880,1900,1940,1920,1820,1750,1810,2160,2210,2180,2000], finance: [1400,-900,500,700,-1400,-5200,-4000,400,8100,2000,-2600,-2000] }
};

// ── Math helpers ──────────────────────────────────────────────────────────────

function parseCSV(csvText) {
  const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const years = {};
  result.data.forEach(row => {
    const yr = `year${row.year}`;
    if (!years[yr]) years[yr] = { label: row.label, membership: [], finance: [] };
    years[yr].membership.push(Number(row.membership));
    years[yr].finance.push(Number(row.finance));
  });
  return years;
}

function computeSeasonalIndices(y1, y2) {
  const avg = y1.map((v, i) => (v + y2[i]) / 2);
  const mean = avg.reduce((a, b) => a + b, 0) / 12;
  return avg.map(v => mean !== 0 ? v / mean : 1);
}

function lastActualIdx(actuals) {
  let last = -1;
  actuals.forEach((v, i) => { if (v !== "") last = i; });
  return last;
}

// Project from startIdx to 11, starting at startVal, targeting goalVal, following indices shape.
// Strategy: compute a linear baseline from startVal to goalVal, then modulate each month's
// value by its seasonal index relative to the mean index — this produces a curve that
// both hits the goal at month 11 AND reflects the seasonal peaks and valleys.
function projectSegment(startVal, goalVal, indices, startIdx) {
  if (startIdx > 11) return Array(12).fill(null);
  const result = Array(12).fill(null);
  const totalMonths = 12 - startIdx;
  const allMean = indices.reduce((a, b) => a + b, 0) / 12;

  // Build raw seasonal curve: linear trend * seasonal ratio at each month
  const raw = [];
  for (let i = 0; i < totalMonths; i++) {
    const mi = startIdx + i;
    // Linear interpolation position (0 at start, 1 at end)
    const t = totalMonths === 1 ? 1 : i / (totalMonths - 1);
    const linearVal = startVal + (goalVal - startVal) * t;
    // Seasonal ratio: how much this month deviates from the mean
    const seasonalRatio = allMean !== 0 ? indices[mi] / allMean : 1;
    raw.push(linearVal * seasonalRatio);
  }

  // The last raw value may not equal goalVal exactly due to seasonal scaling.
  // Scale all raw values so the endpoint lands exactly on goalVal.
  const rawEnd = raw[raw.length - 1];
  const scale = rawEnd !== 0 ? goalVal / rawEnd : 1;
  for (let i = 0; i < totalMonths; i++) {
    result[startIdx + i] = Math.round(raw[i] * scale);
  }
  return result;
}

// Apply one-time lump-sum events to a balance array from their month forward
function applyEvents(balances, events, afterIdx = -1) {
  const result = [...balances];
  events.forEach(evt => {
    const mi = MONTHS.indexOf(evt.month);
    if (mi > afterIdx && evt.amount !== "" && Number(evt.amount) !== 0) {
      for (let i = mi; i < 12; i++) {
        if (result[i] !== null) result[i] = Math.round(result[i] + Number(evt.amount));
      }
    }
  });
  return result;
}

// Full-year original target (no actuals), with events
function buildOriginalTargets(startVal, goalVal, indices, events) {
  return applyEvents(projectSegment(startVal, goalVal, indices, 0), events);
}

// Reforecast: lock actuals, reproject remaining months to hit goal following seasonal shape.
// The seasonal shape is applied as a RELATIVE adjustment on top of a linear ramp from
// lastVal to goalVal — so the line never dips below the linear path, it only adds
// seasonal peaks above it. This correctly shows "what you need to do to get back on track."
function buildReforecast(actuals, goalVal, indices, events) {
  const last = lastActualIdx(actuals);
  if (last === -1) return Array(12).fill(null);
  const lastVal = Number(actuals[last]);
  const result = Array(12).fill(null);
  for (let i = 0; i <= last; i++) {
    if (actuals[i] !== "") result[i] = Number(actuals[i]);
  }
  if (last === 11) return result;

  const futureEvents = events.filter(e => MONTHS.indexOf(e.month) > last && e.amount !== "" && Number(e.amount) !== 0);
  const futureEventTotal = futureEvents.reduce((s, e) => s + Number(e.amount), 0);
  const adjustedGoal = goalVal - futureEventTotal;

  const remaining = 11 - last;
  // Build a linear ramp from lastVal to adjustedGoal
  // Then add seasonal deviation on top (only peaks, not valleys below linear)
  const allMean = indices.reduce((a,b) => a+b, 0) / 12;
  for (let i = 0; i < remaining; i++) {
    const mi = last + 1 + i;
    const t = remaining === 1 ? 1 : i / (remaining - 1);
    const linear = lastVal + (adjustedGoal - lastVal) * t;
    // Seasonal ratio relative to mean — only apply upward deviation
    const seasonalRatio = allMean !== 0 ? indices[mi] / allMean : 1;
    // Blend: use seasonal shape but floor at the linear ramp value
    const seasonal = linear * seasonalRatio;
    result[mi] = Math.round(Math.max(linear, seasonal));
  }
  // Force last month to exactly hit the goal
  result[11] = Math.round(adjustedGoal);

  return applyEvents(result, futureEvents, last);
}

// Projected trajectory: anchor to last actual, then scale the historical seasonal
// curve for the remaining months to start from that anchor point.
// This reflects "if our seasonal pattern holds, where do we go from here"
// rather than extrapolating short-term momentum which can badly mislead.
function buildTrajectory(actuals, indices, events) {
  const last = lastActualIdx(actuals);
  if (last === -1) return Array(12).fill(null);
  const result = Array(12).fill(null);
  for (let i = 0; i <= last; i++) {
    if (actuals[i] !== "") result[i] = Number(actuals[i]);
  }
  if (last === 11) return result;
  const lastVal = Number(actuals[last]);

  // Compute the ratio of last actual vs what the historical average says this
  // month should look like. Apply that same ratio to all future months.
  // This preserves the seasonal shape while anchoring to current reality.
  const allMean = indices.reduce((a, b) => a + b, 0) / 12;
  const expectedAtLastMonth = allMean !== 0 ? indices[last] * (lastVal / indices[last]) : lastVal;
  // Scale factor: how far above/below the seasonal norm are we right now?
  const scaleFactor = indices[last] !== 0 ? lastVal / (indices[last] * allMean / allMean) : 1;

  // Project remaining months by scaling the seasonal index by our current level
  // relative to the historical seasonal mean
  const historicalSeasonalMean = indices.reduce((a,b) => a+b, 0) / 12;
  // Find what the baseline level would be given our current actual vs expected
  const impliedBaseline = historicalSeasonalMean !== 0 ? lastVal / indices[last] * historicalSeasonalMean : lastVal;

  for (let i = last + 1; i < 12; i++) {
    // Each future month = implied baseline * that month seasonal index / mean
    const projected = historicalSeasonalMean !== 0
      ? impliedBaseline * indices[i] / historicalSeasonalMean
      : lastVal;
    result[i] = Math.round(projected);
  }

  const futureEvents = events.filter(e => MONTHS.indexOf(e.month) > last && e.amount !== "" && Number(e.amount) !== 0);
  return applyEvents(result, futureEvents, last);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

const TabButton = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{
    padding: "10px 20px", border: "none",
    borderBottom: active ? "3px solid #2E7D32" : "3px solid transparent",
    background: "transparent", color: active ? "#2E7D32" : "#666",
    fontWeight: active ? "700" : "500", fontSize: "14px", cursor: "pointer",
    fontFamily: "inherit", transition: "all 0.2s", whiteSpace: "nowrap"
  }}>{children}</button>
);

const ChartLegend = ({ items }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginBottom: 14, fontSize: 12 }}>
    {items.map(({ color, label, dash }) => (
      <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width="24" height="10">
          <line x1="0" y1="5" x2="24" y2="5" stroke={color} strokeWidth="2.5" strokeDasharray={dash || "none"} />
        </svg>
        <span style={{ color: "#555" }}>{label}</span>
      </div>
    ))}
  </div>
);

const Tip = ({ active, payload, label, prefix = "", suffix = "" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "10px 14px", fontSize: 13, boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => p.value != null && (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <b>{prefix}{p.value.toLocaleString()}{suffix}</b>
        </div>
      ))}
    </div>
  );
};

const StatusBadge = ({ onTrack }) =>
  onTrack === null ? <span style={{ color: "#ccc" }}>—</span>
  : onTrack
    ? <span style={{ background: "#E8F5E9", color: "#2E7D32", padding: "2px 10px", borderRadius: 20, fontWeight: 700, fontSize: 12 }}>✓ On Track</span>
    : <span style={{ background: "#FFEBEE", color: "#c62828", padding: "2px 10px", borderRadius: 20, fontWeight: 700, fontSize: 12 }}>⚠ Behind</span>;

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("data");
  const [historicalData, setHistoricalData] = useState(FALLBACK_DATA);
  const [csvLoaded, setCsvLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [memberGoalCount, setMemberGoalCount] = useState(2200);
  const [financeNetGoal, setFinanceNetGoal] = useState(0); // target net position at year end
  const [financeStartBalance, setFinanceStartBalance] = useState(9197);
  const [financeEvents, setFinanceEvents] = useState([
    { id: 1, month: "Sep", amount: "", label: "Asset Sale" }
  ]);
  const [outstandingDebt, setOutstandingDebt] = useState(500000);
  const [suppressNovBump, setSuppressNovBump] = useState(false);
  const [showMemberHistory, setShowMemberHistory] = useState(true);
  const [showFinanceHistory, setShowFinanceHistory] = useState(true);
  const [actuals, setActuals] = useState({
    membership: Array(12).fill(""),
    finance: Array(12).fill("")
  });
  const [csvCopied, setCsvCopied] = useState(false);

  const copyCsvToClipboard = () => {
    const rows = ["year,label,month,membership,finance"];
    ["year1","year2"].forEach((yr, yi) => {
      MONTHS.forEach((m, mi) => {
        rows.push([yi+1, historicalData[yr].label, m, historicalData[yr].membership[mi], historicalData[yr].finance[mi]].join(","));
      });
    });
    navigator.clipboard.writeText(rows.join("\n")).then(() => {
      setCsvCopied(true);
      setTimeout(() => setCsvCopied(false), 2500);
    });
  };

  useEffect(() => {
    fetch("/data.csv")
      .then(r => r.text())
      .then(t => { setHistoricalData(parseCSV(t)); setCsvLoaded(true); })
      .catch(() => { setLoadError(true); setCsvLoaded(true); });
  }, []);

  const { memberIndices, financeIndices } = useMemo(() => ({
    memberIndices: computeSeasonalIndices(historicalData.year1.membership, historicalData.year2.membership),
    financeIndices: computeSeasonalIndices(historicalData.year1.finance, historicalData.year2.finance)
  }), [historicalData]);

  const memberStart = historicalData.year2.membership[11];
  const memberGoalPct = Math.round(((memberGoalCount - memberStart) / memberStart) * 1000) / 10;
  // Required cash at year end = pay off debt + desired net cushion
  const financeGoalBalance = outstandingDebt + financeNetGoal;
  const activeEvents = financeEvents.filter(e => e.amount !== "" && Number(e.amount) !== 0);

  // ── Projections ──
  const origMember   = useMemo(() => buildOriginalTargets(memberStart, memberGoalCount, memberIndices, []), [memberStart, memberGoalCount, memberIndices]);
  const rfMember     = useMemo(() => buildReforecast(actuals.membership, memberGoalCount, memberIndices, []), [actuals.membership, memberGoalCount, memberIndices]);
  const trajMember   = useMemo(() => buildTrajectory(actuals.membership, memberIndices, []), [actuals.membership, memberIndices]);

  // ── Finance: deviation-based projection ──
  // Average historical cash balances give us the seasonal shape.
  // We build targets by:
  //   1. Drawing a linear ramp from startBalance to goalBalance (before events)
  //   2. Adding the historical monthly deviation from ITS own trend on top
  // This keeps seasonal swings at their real dollar magnitudes — no amplification.

  const avgCashShape = useMemo(() =>
    MONTHS.map((_, i) => (historicalData.year1.finance[i] + historicalData.year2.finance[i]) / 2),
    [historicalData]);

  // Pre-compute historical deviations from its own linear trend (Jan→Dec)
  const historicalDeviations = useMemo(() => {
    const s = avgCashShape[0], e = avgCashShape[11];
    return avgCashShape.map((v, i) => {
      const trendVal = s + (e - s) * (i / 11);
      return v - trendVal;  // how much above/below trend this month historically is
    });
  }, [avgCashShape]);

  const buildFinanceTargets = (startVal, goalVal, deviations, events) => {
    const result = MONTHS.map((_, i) => {
      const t = i / 11;
      const ramp = startVal + (goalVal - startVal) * t;
      return Math.round(ramp + deviations[i]);
    });
    events.forEach(evt => {
      const mi = MONTHS.indexOf(evt.month);
      if (mi >= 0 && evt.amount !== '' && Number(evt.amount) !== 0) {
        for (let i = mi; i < 12; i++) result[i] = Math.round(result[i] + Number(evt.amount));
      }
    });
    // Force December to land exactly on goalVal + all events (no rounding drift)
    const totalEvents = events.reduce((s,e) => s + Number(e.amount||0), 0);
    result[11] = goalVal + totalEvents;
    return result;
  };

  const origFinance = useMemo(() => {
    // Goal before events: the ramp endpoint without one-time bumps.
    // Events are added back by buildFinanceTargets, so subtract them here to avoid double-counting.
    // The ramp should end at exactly financeGoalBalance after events are applied.
    const eventTotal = activeEvents.reduce((s,e) => s + Number(e.amount||0), 0);
    const goalBeforeEvents = financeGoalBalance - eventTotal;
    return buildFinanceTargets(financeStartBalance, goalBeforeEvents, historicalDeviations, activeEvents);
  }, [financeStartBalance, financeGoalBalance, historicalDeviations, activeEvents]);

  // Reforecast: from last actual, ramp to goal using deviations for remaining months.
  // When suppressNovBump is on, November deviation is zeroed out and the goal is
  // reduced by the historical Nov bump (~$107k) since that income came in Q1 instead.
  const rfFinance = useMemo(() => {
    const last = lastActualIdx(actuals.finance);
    if (last === -1) return Array(12).fill(null);
    const result = Array(12).fill(null);
    for (let i = 0; i <= last; i++) {
      if (actuals.finance[i] !== '') result[i] = Number(actuals.finance[i]);
    }
    if (last === 11) return result;
    const lastVal = Number(actuals.finance[last]);
    const futureEvents = activeEvents.filter(e => MONTHS.indexOf(e.month) > last);
    const futureEventTotal = futureEvents.reduce((s,e) => s + Number(e.amount||0), 0);
    // When Nov bump suppressed, reduce goal by the Nov historical movement
    const novBump = avgCashShape[10] - avgCashShape[9]; // ~$107k
    const adjustedGoal = financeGoalBalance - (suppressNovBump ? novBump : 0);
    const goalWithoutEvents = adjustedGoal - futureEventTotal;
    const monthsLeft = 11 - last;
    for (let i = last + 1; i < 12; i++) {
      const t = (i - last) / monthsLeft;
      const ramp = lastVal + (goalWithoutEvents - lastVal) * t;
      // Zero out Nov deviation when suppressed
      const deviation = (suppressNovBump && i === 10) ? 0 : historicalDeviations[i];
      result[i] = Math.round(ramp + deviation);
    }
    futureEvents.forEach(evt => {
      const mi = MONTHS.indexOf(evt.month);
      for (let i = mi; i < 12; i++) if (result[i] !== null) result[i] = Math.round(result[i] + Number(evt.amount||0));
    });
    return result;
  }, [actuals.finance, financeGoalBalance, historicalDeviations, activeEvents, suppressNovBump, avgCashShape]);

  // Trajectory: from last actual, project where we will naturally end up.
  // Uses historical month-to-month changes. When suppressNovBump is on, the November
  // recharter bump is zeroed out because that income has moved to earlier in the year.
  const trajFinance = useMemo(() => {
    const last = lastActualIdx(actuals.finance);
    if (last === -1) return Array(12).fill(null);
    const result = Array(12).fill(null);
    for (let i = 0; i <= last; i++) {
      if (actuals.finance[i] !== '') result[i] = Number(actuals.finance[i]);
    }
    if (last === 11) return result;
    const lastVal = Number(actuals.finance[last]);
    let running = lastVal;
    for (let i = last + 1; i < 12; i++) {
      let historicalMonthlyChange = avgCashShape[i] - avgCashShape[i - 1];
      if (suppressNovBump && i === 10) historicalMonthlyChange = 0;
      running += historicalMonthlyChange;
      result[i] = Math.round(running);
    }
    const futureEvents = activeEvents.filter(e => MONTHS.indexOf(e.month) > last);
    futureEvents.forEach(evt => {
      const mi = MONTHS.indexOf(evt.month);
      for (let i = mi; i < 12; i++) if (result[i] !== null) result[i] = Math.round(result[i] + Number(evt.amount||0));
    });
    return result;
  }, [actuals.finance, avgCashShape, activeEvents, suppressNovBump]);

  const lastMemberIdx  = lastActualIdx(actuals.membership);
  const lastFinanceIdx = lastActualIdx(actuals.finance);
  const hasM = lastMemberIdx >= 0;
  const hasF = lastFinanceIdx >= 0;

  const projMemberEnd  = trajMember[11];
  const projFinanceEnd = trajFinance[11];

  // ── Chart data ──
  const memberChart = MONTHS.map((m, i) => ({
    month: m,
    ...(showMemberHistory ? {
      [historicalData.year1.label]: historicalData.year1.membership[i],
      [historicalData.year2.label]: historicalData.year2.membership[i],
    } : {}),
    "Original Target":       origMember[i],
    "Actual":                actuals.membership[i] !== "" ? Number(actuals.membership[i]) : null,
    "Reforecast to Goal":    rfMember[i],
    "Projected Trajectory":  trajMember[i],
  }));

  // Historical cash balances — these ARE the level values (cash in bank each month)
  const financeYear1Running = historicalData.year1.finance;
  const financeYear2Running = historicalData.year2.finance;

  // Debt remaining by month — drops to zero when asset sale covers it
  const debtByMonth = useMemo(() => {
    let remaining = outstandingDebt;
    return MONTHS.map((m, i) => {
      const evt = activeEvents.find(e => MONTHS.indexOf(e.month) === i);
      if (evt && Number(evt.amount) > 0) {
        remaining = Math.max(0, remaining - Number(evt.amount));
      }
      return remaining;
    });
  }, [outstandingDebt, activeEvents]);

  // Cash chart: raw bank balance as CEO reports it
  const cashChart = MONTHS.map((m, i) => ({
    month: m,
    ...(showFinanceHistory ? {
      [historicalData.year1.label]: financeYear1Running[i],
      [historicalData.year2.label]: financeYear2Running[i],
    } : {}),
    "Original Target":      origFinance[i],
    "Actual":               actuals.finance[i] !== "" ? Number(actuals.finance[i]) : null,
    "Reforecast to Goal":   rfFinance[i],
    "Projected Trajectory": trajFinance[i],
  }));

  // Net chart: cash minus remaining debt at each month
  // Before asset sale: cash - $500k. After asset sale retires debt: same as cash chart.
  const netChart = MONTHS.map((m, i) => {
    const debt = debtByMonth[i];
    const toNet = v => (v !== null && v !== undefined) ? Math.round(v - debt) : null;
    return {
      month: m,
      ...(showFinanceHistory ? {
        [historicalData.year1.label]: toNet(financeYear1Running[i]),
        [historicalData.year2.label]: toNet(financeYear2Running[i]),
      } : {}),
      "Original Target":      toNet(origFinance[i]),
      "Actual":               actuals.finance[i] !== "" ? toNet(Number(actuals.finance[i])) : null,
      "Reforecast to Goal":   toNet(rfFinance[i]),
      "Projected Trajectory": toNet(trajFinance[i]),
    };
  });

  const indexChart = MONTHS.map((m, i) => ({
    month: m, "Member Index": Math.round(memberIndices[i]*100)/100, "Finance Index": Math.round(financeIndices[i]*100)/100
  }));

  // Fixed Y-axis domains — computed from ALL data including historical so scale never shifts when toggling
  const memberYDomain = useMemo(() => {
    const allVals = [
      ...historicalData.year1.membership, ...historicalData.year2.membership,
      ...origMember, ...rfMember.filter(v=>v!==null), ...trajMember.filter(v=>v!==null),
      ...actuals.membership.filter(v=>v!=="").map(Number)
    ].filter(v => v != null);
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const pad = (max - min) * 0.1;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [historicalData, origMember, rfMember, trajMember, actuals.membership]);

  const cashYDomain = useMemo(() => {
    const allVals = [
      ...financeYear1Running, ...financeYear2Running,
      ...origFinance, ...rfFinance.filter(v=>v!==null), ...trajFinance.filter(v=>v!==null),
      ...actuals.finance.filter(v=>v!=="").map(Number)
    ].filter(v => v != null);
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const pad = (max - min) * 0.1;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [financeYear1Running, financeYear2Running, origFinance, rfFinance, trajFinance, actuals.finance]);

  const netYDomain = useMemo(() => {
    const allVals = [
      ...financeYear1Running.map((v,i) => v - outstandingDebt),
      ...financeYear2Running.map((v,i) => v - outstandingDebt),
      ...netChart.map(r => r["Original Target"]).filter(v=>v!=null),
      ...netChart.map(r => r["Reforecast to Goal"]).filter(v=>v!=null),
      ...netChart.map(r => r["Actual"]).filter(v=>v!=null),
    ].filter(v => v != null);
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const pad = (max - min) * 0.1;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [financeYear1Running, financeYear2Running, netChart, outstandingDebt]);

  // ── Styles ──
  const card = { background:"#fff", borderRadius:12, padding:24, boxShadow:"0 2px 8px rgba(0,0,0,0.06)", marginBottom:20 };
  const th   = { padding:"8px 12px", background:"#f5f5f5", fontWeight:700, color:"#555", fontSize:13 };
  const head = (title, sub) => (
    <div style={{ marginBottom:20 }}>
      <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1a3a1a", letterSpacing:"-0.02em" }}>{title}</h2>
      {sub && <p style={{ margin:"4px 0 0", fontSize:13, color:"#777" }}>{sub}</p>}
    </div>
  );

  const SummaryBanner = ({ hasActuals, lastIdx, rfLine, trajEnd, goalVal, goalLabel, prefix="", priorYearEnd=null }) => {
    if (!hasActuals) return null;
    const gap = trajEnd !== null ? trajEnd - goalVal : null;
    const pctVsPrior = (trajEnd !== null && priorYearEnd !== null && priorYearEnd !== 0)
      ? ((trajEnd - priorYearEnd) / priorYearEnd * 100)
      : null;
    return (
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>
        <div style={{ background:"#E3F2FD", borderRadius:10, padding:"14px 18px", border:"1px solid #BBDEFB" }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#1565C0", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Reforecast to Goal</div>
          <div style={{ fontSize:13, color:"#333" }}>
            Remaining months re-projected to still reach <b>{prefix}{goalVal.toLocaleString()}{goalLabel}</b> by Dec,
            from your {MONTHS[lastIdx]} actual.
          </div>
        </div>
        <div style={{ background: gap !== null && gap >= 0 ? "#E8F5E9" : "#FFF8E1", borderRadius:10, padding:"14px 18px", border:`1px solid ${gap !== null && gap >= 0 ? "#C8E6C9" : "#FFE082"}` }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#F57F17", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Projected Year-End (current pace)</div>
          <div style={{ fontSize:22, fontWeight:800, color: gap !== null && gap >= 0 ? "#2E7D32" : "#E65100" }}>
            {trajEnd !== null ? `${prefix}${trajEnd.toLocaleString()}${goalLabel}` : "—"}
          </div>
          {pctVsPrior !== null && (
            <div style={{ fontSize:13, fontWeight:700, color: pctVsPrior >= 0 ? "#2E7D32" : "#c62828", marginTop:2 }}>
              {pctVsPrior >= 0 ? "+" : ""}{pctVsPrior.toFixed(1)}% vs prior year ({priorYearEnd.toLocaleString()} Dec {historicalData.year2.label})
            </div>
          )}
          <div style={{ fontSize:12, color:"#888", marginTop:2 }}>
            {gap !== null
              ? gap >= 0 ? `${prefix}${gap.toLocaleString()} above goal` : `${prefix}${Math.abs(gap).toLocaleString()} short of goal`
              : "Enter actuals to project"}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ fontFamily:"'DM Sans','Segoe UI',sans-serif", background:"#f8faf8", minHeight:"100vh" }}>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#1B5E20,#2E7D32 60%,#388E3C)", padding:"28px 32px 20px", color:"#fff" }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <span style={{ fontSize:36 }}>⚜️</span>
          <div>
            <h1 style={{ margin:0, fontSize:24, fontWeight:800, letterSpacing:"-0.02em" }}>Council Growth Planner</h1>
            <p style={{ margin:0, fontSize:13, opacity:0.8 }}>Membership & Finance Trajectory Forecasting</p>
          </div>
          {csvLoaded && (
            <div style={{ marginLeft:"auto", fontSize:12, background: loadError ? "rgba(255,100,100,0.3)" : "rgba(255,255,255,0.2)", padding:"4px 12px", borderRadius:20 }}>
              {loadError ? "⚠ Using sample data" : "✓ data.csv loaded"}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background:"#fff", borderBottom:"1px solid #e8e8e8", padding:"0 32px", display:"flex", gap:2, overflowX:"auto" }}>
        {[["data","📋 Historical Data"],["membership","👥 Membership"],["finance","💰 Finance"],["seasonal","📊 Seasonal"]].map(([k,l]) => (
          <TabButton key={k} active={tab===k} onClick={()=>setTab(k)}>{l}</TabButton>
        ))}
      </div>

      <div style={{ padding:"28px 32px", maxWidth:1200, margin:"0 auto" }}>

        {/* ══ DATA TAB ══ */}
        {tab==="data" && (
          <div>
            {head("Historical Data","Data loads from data.csv in the repository. Edit in-browser for immediate effect, or update the CSV in GitHub for permanent changes.")}
            <div style={{ background:"#E8F5E9", borderRadius:8, padding:"12px 16px", fontSize:13, color:"#2E7D32", border:"1px solid #C8E6C9", marginBottom:20 }}>
              <b>Permanent updates:</b> edit <code>public/data.csv</code> in GitHub → Vercel redeploys in ~30s.
              Membership = headcount at month end. Finance = net monthly cash flow.
            </div>
            <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:16 }}>
              <button onClick={copyCsvToClipboard} style={{ padding:"8px 18px", background: csvCopied ? "#2E7D32" : "#fff", color: csvCopied ? "#fff" : "#2E7D32", border:"2px solid #2E7D32", borderRadius:8, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s", display:"flex", alignItems:"center", gap:8 }}>
                {csvCopied ? "✓ Copied to clipboard!" : "📋 Copy as CSV"}
              </button>
            </div>
            {["membership","finance"].map(field => (
              <div key={field} style={card}>
                <div style={{ fontSize:13, fontWeight:700, color:"#444", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.05em" }}>
                  {field==="membership" ? "Membership (headcount at month end)" : "Finance (net monthly cash flow $)"}
                </div>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ borderCollapse:"collapse", width:"100%", fontSize:13 }}>
                    <thead><tr>
                      <th style={{ ...th, textAlign:"left" }}>Year</th>
                      {MONTHS.map(m=><th key={m} style={{ ...th, textAlign:"center", minWidth:62 }}>{m}</th>)}
                    </tr></thead>
                    <tbody>
                      {["year1","year2"].map(yr=>(
                        <tr key={yr}>
                          <td style={{ padding:"5px 12px", fontWeight:700, color:"#2E7D32", whiteSpace:"nowrap" }}>{historicalData[yr].label}</td>
                          {MONTHS.map((_,mi)=>(
                            <td key={mi} style={{ padding:"3px 4px" }}>
                              <input type="number" value={historicalData[yr][field][mi]}
                                onChange={e=>setHistoricalData(prev=>({ ...prev, [yr]:{ ...prev[yr], [field]:prev[yr][field].map((v,i)=>i===mi?Number(e.target.value):v) } }))}
                                style={{ width:62, padding:"4px 6px", border:"1px solid #ddd", borderRadius:4, fontSize:13, textAlign:"center", fontFamily:"inherit" }} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ══ MEMBERSHIP TAB ══ */}
        {tab==="membership" && (
          <div>
            {head("Membership Trajectory",`Starting from ${memberStart.toLocaleString()} members (end of ${historicalData.year2.label}).`)}

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:20 }}>Annual Growth Goal</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:32 }}>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
                    <span style={{ fontSize:13, color:"#666", fontWeight:600 }}>Target Scout Count</span>
                    <span style={{ fontSize:32, fontWeight:800, color:"#2E7D32" }}>{memberGoalCount.toLocaleString()}</span>
                  </div>
                  <input type="range" min={1000} max={4000} step={1} value={memberGoalCount}
                    onChange={e=>setMemberGoalCount(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#2E7D32" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>1,000</span><span>2,000</span><span>3,000</span><span>4,000</span>
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:"#888" }}>
                    Net change: <b style={{ color:memberGoalCount>=memberStart?"#2E7D32":"#c62828" }}>
                      {memberGoalCount>=memberStart?"+":""}{(memberGoalCount-memberStart).toLocaleString()} scouts
                    </b>
                  </div>
                </div>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
                    <span style={{ fontSize:13, color:"#666", fontWeight:600 }}>Growth Percentage</span>
                    <span style={{ fontSize:32, fontWeight:800, color:"#1565C0" }}>{memberGoalPct>=0?"+":""}{memberGoalPct}%</span>
                  </div>
                  <input type="range" min={-50} max={100} step={0.1} value={memberGoalPct}
                    onChange={e=>setMemberGoalCount(Math.round(memberStart*(1+Number(e.target.value)/100)))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#1565C0" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>-50%</span><span>0%</span><span>+25%</span><span>+50%</span><span>+75%</span><span>+100%</span>
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:"#888" }}>Starting: <b>{memberStart.toLocaleString()}</b></div>
                </div>
              </div>
              <div style={{ marginTop:16, textAlign:"center", fontSize:12, color:"#aaa" }}>↔ Sliders are linked — moving either one updates the other</div>
            </div>

            <SummaryBanner hasActuals={hasM} lastIdx={lastMemberIdx}
              rfLine={rfMember} trajEnd={projMemberEnd}
              goalVal={memberGoalCount} goalLabel=" scouts"
              priorYearEnd={historicalData.year2.membership[11]} />

            <div style={card}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.05em" }}>Monthly Membership Chart</div>
                <button onClick={()=>setShowMemberHistory(p=>!p)} style={{ fontSize:12, padding:"4px 12px", border:"1px solid #ddd", borderRadius:6, background: showMemberHistory?"#f5f5f5":"#fff", cursor:"pointer", fontFamily:"inherit", color:"#555" }}>
                  {showMemberHistory?"Hide":"Show"} Historical Lines
                </button>
              </div>
              <ChartLegend items={[
                ...(showMemberHistory?[{ color:"#a5d6a7", label:historicalData.year1.label, dash:"4 3" },{ color:"#66bb6a", label:historicalData.year2.label }]:[]),
                { color:"#1B5E20", label:"Original Target", dash:"6 3" },
                { color:"#F57F17", label:"Actual" },
                ...(hasM?[
                  { color:"#1565C0", label:"Reforecast to Goal", dash:"4 2" },
                  { color:"#E65100", label:"Projected Trajectory", dash:"2 2" },
                ]:[])
              ]} />
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={memberChart} margin={{ top:10, right:20, bottom:0, left:10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize:12 }} />
                  <YAxis tick={{ fontSize:12 }} tickFormatter={v=>v.toLocaleString()} domain={memberYDomain} />
                  <Tooltip content={<Tip suffix=" scouts" />} />
                  <Line type="monotone" dataKey={historicalData.year1.label} stroke="#a5d6a7" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                  <Line type="monotone" dataKey={historicalData.year2.label} stroke="#66bb6a" strokeWidth={2} dot={false} />
                  {showMemberHistory&&<Line type="monotone" dataKey={historicalData.year1.label} stroke="#a5d6a7" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />}
                  {showMemberHistory&&<Line type="monotone" dataKey={historicalData.year2.label} stroke="#66bb6a" strokeWidth={2} dot={false} />}
                  <Line type="monotone" dataKey="Original Target" stroke="#1B5E20" strokeWidth={2} dot={{ fill:"#1B5E20", r:3 }} strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="Actual" stroke="#F57F17" strokeWidth={2.5} dot={{ fill:"#F57F17", r:5 }} connectNulls={false} />
                  {hasM&&<Line type="monotone" dataKey="Reforecast to Goal" stroke="#1565C0" strokeWidth={3.5} dot={false} strokeDasharray="4 2" />}
                  {hasM&&<Line type="monotone" dataKey="Projected Trajectory" stroke="#E65100" strokeWidth={2} dot={false} strokeDasharray="2 2" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:16, textTransform:"uppercase", letterSpacing:"0.05em" }}>Monthly Targets & Actuals</div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%", fontSize:13 }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign:"left" }}>Month</th>
                    <th style={{ ...th, textAlign:"center", color:"#1B5E20" }}>Original Target</th>
                    <th style={{ ...th, textAlign:"center", color:"#1565C0" }}>Reforecast Target</th>
                    <th style={{ ...th, textAlign:"center", color:"#F57F17" }}>Actual</th>
                    <th style={{ ...th, textAlign:"center" }}>vs Original</th>
                    <th style={{ ...th, textAlign:"center" }}>Status</th>
                  </tr></thead>
                  <tbody>
                    {MONTHS.map((m,i)=>{
                      const orig=origMember[i], refc=rfMember[i];
                      const actual=actuals.membership[i]!==""?Number(actuals.membership[i]):null;
                      const variance=actual!==null?actual-orig:null;
                      return(
                        <tr key={m} style={{ borderBottom:"1px solid #f0f0f0" }}>
                          <td style={{ padding:"7px 12px", fontWeight:600 }}>{m}</td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:"#1B5E20", fontWeight:600 }}>{orig?.toLocaleString()}</td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:refc!==null?"#1565C0":"#ccc", fontWeight:refc!==null?700:400 }}>{refc!==null?refc.toLocaleString():"—"}</td>
                          <td style={{ padding:"4px 8px", textAlign:"center" }}>
                            <input type="number" placeholder="—" value={actuals.membership[i]}
                              onChange={e=>setActuals(p=>({...p,membership:p.membership.map((v,j)=>j===i?e.target.value:v)}))}
                              style={{ width:80, padding:"4px 6px", border:"1px solid #ddd", borderRadius:4, fontSize:13, textAlign:"center", fontFamily:"inherit" }} />
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:variance!==null?700:400, color:variance===null?"#ccc":variance>=0?"#2E7D32":"#c62828" }}>
                            {variance!==null?(variance>=0?`+${variance.toLocaleString()}`:variance.toLocaleString()):"—"}
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center" }}><StatusBadge onTrack={actual!==null?actual>=orig:null}/></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══ FINANCE TAB ══ */}
        {tab==="finance" && (
          <div>
            {head("Finance Trajectory","Track running bank balance against seasonally-adjusted monthly targets.")}

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:20 }}>Finance Setup</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:24 }}>
                <div>
                  <div style={{ fontSize:11, color:"#888", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Jan 1 Bank Balance</div>
                  <div style={{ fontSize:28, fontWeight:800, color:"#555", marginBottom:8 }}>${financeStartBalance.toLocaleString()}</div>
                  <input type="range" min={0} max={2000000} step={5000} value={financeStartBalance}
                    onChange={e=>setFinanceStartBalance(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#555" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>$0</span><span>$500k</span><span>$1M</span><span>$1.5M</span><span>$2M</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#888", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Outstanding Debt (Loan)</div>
                  <div style={{ fontSize:28, fontWeight:800, color:"#c62828", marginBottom:8 }}>-${outstandingDebt.toLocaleString()}</div>
                  <input type="range" min={0} max={2000000} step={1000} value={outstandingDebt}
                    onChange={e=>setOutstandingDebt(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#c62828" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>$0</span><span>$1M</span><span>$2M</span>
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:"#888" }}>
                    True net position: <b style={{ color: (financeStartBalance-outstandingDebt)>=0?"#2E7D32":"#c62828" }}>
                      {(financeStartBalance-outstandingDebt)>=0?"$":"-$"}{Math.abs(financeStartBalance-outstandingDebt).toLocaleString()}
                    </b>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:"#888", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Target Year-End Net Position</div>
                  <div style={{ fontSize:28, fontWeight:800, color:financeNetGoal>=0?"#2E7D32":"#c62828", marginBottom:8 }}>
                    {financeNetGoal>=0?"$":"-$"}{Math.abs(financeNetGoal).toLocaleString()}
                  </div>
                  <input type="range" min={-200000} max={500000} step={5000} value={financeNetGoal}
                    onChange={e=>setFinanceNetGoal(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#2E7D32" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>-$200k</span><span>$0</span><span>+$250k</span><span>+$500k</span>
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:"#888" }}>
                    Required year-end cash: <b style={{ color:"#2E7D32" }}>${financeGoalBalance.toLocaleString()}</b>
                  </div>
                  <div style={{ fontSize:11, color:"#aaa", marginTop:2 }}>
                    Cash needed = loan payoff (${outstandingDebt.toLocaleString()}) + net cushion
                  </div>
                </div>
              </div>
            </div>

            {/* Suppress Nov Bump Toggle */}
            <div style={{ ...card, padding:"16px 24px" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:"#555" }}>Suppress November Recharter Bump</div>
                  <div style={{ fontSize:12, color:"#888", marginTop:3 }}>
                    Turn on if recharter income has moved to Q1 — prevents double-counting the historical November spike in the trajectory projection.
                    {suppressNovBump && <span style={{ marginLeft:8, color:"#E65100", fontWeight:600 }}>Active — Nov projected flat (~$107k lower year-end)</span>}
                  </div>
                </div>
                <div
                  onClick={()=>setSuppressNovBump(p=>!p)}
                  style={{
                    width:48, height:26, borderRadius:13, cursor:"pointer", flexShrink:0, marginLeft:24,
                    background: suppressNovBump ? "#2E7D32" : "#ccc",
                    position:"relative", transition:"background 0.2s"
                  }}>
                  <div style={{
                    width:22, height:22, borderRadius:11, background:"#fff",
                    position:"absolute", top:2, transition:"left 0.2s",
                    left: suppressNovBump ? 24 : 2,
                    boxShadow:"0 1px 3px rgba(0,0,0,0.3)"
                  }} />
                </div>
              </div>
            </div>

            {/* One-time events */}
            <div style={card}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.05em" }}>One-Time Finance Events</div>
                  <div style={{ fontSize:12, color:"#888", marginTop:3 }}>Asset sales, grants, large expenses — applied as a step-change to the balance from that month forward.</div>
                </div>
                <button onClick={()=>setFinanceEvents(p=>[...p,{id:Date.now(),month:"Jan",amount:"",label:"New Event"}])}
                  style={{ padding:"6px 14px", background:"#2E7D32", color:"#fff", border:"none", borderRadius:6, fontSize:13, cursor:"pointer", fontFamily:"inherit", fontWeight:600, whiteSpace:"nowrap", marginLeft:16 }}>
                  + Add Event
                </button>
              </div>
              {financeEvents.length===0&&<div style={{ fontSize:13, color:"#aaa", textAlign:"center", padding:"8px 0" }}>No events. Click + Add Event to add one.</div>}
              {financeEvents.map(evt=>(
                <div key={evt.id} style={{ display:"flex", gap:10, alignItems:"flex-end", marginBottom:10, padding:"10px 14px", background:"#f9f9f9", borderRadius:8, border:"1px solid #eee" }}>
                  <div style={{ flex:2 }}>
                    <div style={{ fontSize:11, color:"#888", marginBottom:3, fontWeight:600 }}>LABEL</div>
                    <input value={evt.label} onChange={e=>setFinanceEvents(p=>p.map(ev=>ev.id===evt.id?{...ev,label:e.target.value}:ev))}
                      style={{ width:"100%", padding:"5px 8px", border:"1px solid #ddd", borderRadius:4, fontSize:13, fontFamily:"inherit" }} />
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:11, color:"#888", marginBottom:3, fontWeight:600 }}>MONTH</div>
                    <select value={evt.month} onChange={e=>setFinanceEvents(p=>p.map(ev=>ev.id===evt.id?{...ev,month:e.target.value}:ev))}
                      style={{ width:"100%", padding:"5px 8px", border:"1px solid #ddd", borderRadius:4, fontSize:13, fontFamily:"inherit", background:"#fff" }}>
                      {MONTHS.map(m=><option key={m}>{m}</option>)}
                    </select>
                  </div>
                  <div style={{ flex:1.5 }}>
                    <div style={{ fontSize:11, color:"#888", marginBottom:3, fontWeight:600 }}>AMOUNT ($) — use negative for expense</div>
                    <input type="number" placeholder="e.g. 15000" value={evt.amount}
                      onChange={e=>setFinanceEvents(p=>p.map(ev=>ev.id===evt.id?{...ev,amount:e.target.value}:ev))}
                      style={{ width:"100%", padding:"5px 8px", border:"1px solid #ddd", borderRadius:4, fontSize:13, fontFamily:"inherit" }} />
                  </div>
                  <button onClick={()=>setFinanceEvents(p=>p.filter(ev=>ev.id!==evt.id))}
                    style={{ padding:"6px 10px", background:"#ffebee", color:"#c62828", border:"none", borderRadius:4, cursor:"pointer", fontSize:13, marginBottom:1 }}>✕</button>
                </div>
              ))}
            </div>

            {hasF && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>
                <div style={{ background:"#E3F2FD", borderRadius:10, padding:"14px 18px", border:"1px solid #BBDEFB" }}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#1565C0", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Reforecast to Goal</div>
                  <div style={{ fontSize:13, color:"#333" }}>
                    Remaining months re-projected to reach <b>${financeGoalBalance.toLocaleString()}</b> cash by Dec
                    (net <b style={{ color:(financeGoalBalance-outstandingDebt)>=0?"#2E7D32":"#c62828" }}>
                      {(financeGoalBalance-outstandingDebt)>=0?"$":"-$"}{Math.abs(financeGoalBalance-outstandingDebt).toLocaleString()}
                    </b> after loan payoff).
                  </div>
                </div>
                <div style={{ background: projFinanceEnd!==null && (projFinanceEnd-outstandingDebt)>=0 ? "#E8F5E9" : "#FFF8E1", borderRadius:10, padding:"14px 18px", border:`1px solid ${projFinanceEnd!==null && (projFinanceEnd-outstandingDebt)>=0 ? "#C8E6C9" : "#FFE082"}` }}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#F57F17", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Projected Year-End</div>
                  <div style={{ fontSize:13, color:"#555", marginBottom:4 }}>
                    Cash: <b style={{ fontSize:20, color:"#333" }}>{projFinanceEnd!==null?`$${Math.round(projFinanceEnd).toLocaleString()}`:"—"}</b>
                  </div>
                  <div style={{ fontSize:13, color:"#555" }}>
                    After loan payoff: <b style={{ fontSize:18, color: projFinanceEnd!==null && (projFinanceEnd-outstandingDebt)>=0?"#2E7D32":"#c62828" }}>
                      {projFinanceEnd!==null?(projFinanceEnd-outstandingDebt)>=0?`+$${Math.round(projFinanceEnd-outstandingDebt).toLocaleString()}`:`-$${Math.round(Math.abs(projFinanceEnd-outstandingDebt)).toLocaleString()}`:"—"}
                    </b>
                  </div>
                  <div style={{ fontSize:11, color:"#888", marginTop:4 }}>Cash minus $500k loan payoff</div>
                </div>
              </div>
            )}

            {/* Shared legend */}
            <div style={{ ...card, paddingBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:8 }}>
                <button onClick={()=>setShowFinanceHistory(p=>!p)} style={{ fontSize:12, padding:"4px 12px", border:"1px solid #ddd", borderRadius:6, background: showFinanceHistory?"#f5f5f5":"#fff", cursor:"pointer", fontFamily:"inherit", color:"#555" }}>
                  {showFinanceHistory?"Hide":"Show"} Historical Lines
                </button>
              </div>
              <ChartLegend items={[
                ...(showFinanceHistory?[{ color:"#a5d6a7", label:historicalData.year1.label, dash:"4 3" },{ color:"#66bb6a", label:historicalData.year2.label }]:[]),
                { color:"#1B5E20", label:"Original Target", dash:"6 3" },
                { color:"#F57F17", label:"Actual" },
                ...(hasF?[{ color:"#1565C0", label:"Reforecast to Goal", dash:"4 2" }]:[]),
                ...(activeEvents.length>0?[{ color:"#9C27B0", label:"One-time Event ★" }]:[])
              ]} />
            </div>

            {/* Cash Chart — what CEO reports */}
            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" }}>Cash Position (What the CEO Reports)</div>
              <div style={{ fontSize:12, color:"#888", marginBottom:12 }}>Bank balance as reported — does not account for the ${outstandingDebt.toLocaleString()} outstanding loan.</div>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={cashChart} margin={{ top:10, right:20, bottom:0, left:20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize:12 }} />
                  <YAxis tick={{ fontSize:12 }} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} domain={cashYDomain} />
                  <Tooltip content={<Tip prefix="$" />} />
                  <ReferenceLine y={financeStartBalance} stroke="#ddd" strokeDasharray="4 3" label={{ value:"Start", fontSize:10, fill:"#bbb" }} />
                  <ReferenceLine y={0} stroke="#ffcdd2" strokeWidth={1.5} />
                  {activeEvents.map(evt=>(
                    <ReferenceLine key={evt.id} x={evt.month} stroke="#9C27B0" strokeDasharray="3 2"
                      label={{ value:`${evt.label} +$${Number(evt.amount).toLocaleString()}`, fontSize:10, fill:"#9C27B0", position:"insideTopRight" }} />
                  ))}
                  {showFinanceHistory&&<Line type="monotone" dataKey={historicalData.year1.label} stroke="#a5d6a7" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />}
                  {showFinanceHistory&&<Line type="monotone" dataKey={historicalData.year2.label} stroke="#66bb6a" strokeWidth={2} dot={false} />}
                  <Line type="monotone" dataKey="Original Target" stroke="#1B5E20" strokeWidth={2.5} dot={{ fill:"#1B5E20", r:3 }} strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="Actual" stroke="#F57F17" strokeWidth={2.5} dot={{ fill:"#F57F17", r:5 }} connectNulls={false} />
                  {hasF&&<Line type="monotone" dataKey="Reforecast to Goal" stroke="#1565C0" strokeWidth={3.5} dot={false} strokeDasharray="4 2" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Net Position Chart — cash minus debt */}
            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" }}>Net Position (Cash minus ${outstandingDebt.toLocaleString()} Loan)</div>
              <div style={{ fontSize:12, color:"#888", marginBottom:12 }}>True financial health. After asset sale retires the loan, this chart converges with the cash chart above.</div>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={netChart} margin={{ top:10, right:20, bottom:0, left:20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize:12 }} />
                  <YAxis tick={{ fontSize:12 }} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} domain={netYDomain} />
                  <Tooltip content={<Tip prefix="$" />} />
                  <ReferenceLine y={0} stroke="#c62828" strokeWidth={2} label={{ value:"Break-even", fontSize:11, fill:"#c62828", position:"insideTopLeft" }} />
                  {activeEvents.map(evt=>(
                    <ReferenceLine key={evt.id} x={evt.month} stroke="#9C27B0" strokeDasharray="3 2"
                      label={{ value:`${evt.label} (net +$${Math.max(0,Number(evt.amount)-outstandingDebt).toLocaleString()})`, fontSize:10, fill:"#9C27B0", position:"insideTopRight" }} />
                  ))}
                  {showFinanceHistory&&<Line type="monotone" dataKey={historicalData.year1.label} stroke="#a5d6a7" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />}
                  {showFinanceHistory&&<Line type="monotone" dataKey={historicalData.year2.label} stroke="#66bb6a" strokeWidth={2} dot={false} />}
                  <Line type="monotone" dataKey="Original Target" stroke="#1B5E20" strokeWidth={2.5} dot={{ fill:"#1B5E20", r:3 }} strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="Actual" stroke="#F57F17" strokeWidth={2.5} dot={{ fill:"#F57F17", r:5 }} connectNulls={false} />
                  {hasF&&<Line type="monotone" dataKey="Reforecast to Goal" stroke="#1565C0" strokeWidth={3.5} dot={false} strokeDasharray="4 2" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:16, textTransform:"uppercase", letterSpacing:"0.05em" }}>Monthly Balance Targets & Actuals</div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%", fontSize:13 }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign:"left" }}>Month</th>
                    <th style={{ ...th, textAlign:"center", color:"#1B5E20" }}>Original Target</th>
                    <th style={{ ...th, textAlign:"center", color:"#1565C0" }}>Reforecast Target</th>
                    <th style={{ ...th, textAlign:"center", color:"#F57F17" }}>Actual Balance</th>
                    <th style={{ ...th, textAlign:"center" }}>vs Original</th>
                    <th style={{ ...th, textAlign:"center" }}>Status</th>
                  </tr></thead>
                  <tbody>
                    {MONTHS.map((m,i)=>{
                      const orig=origFinance[i];
                      const refc=rfFinance[i];
                      const actual=actuals.finance[i]!==""?Number(actuals.finance[i]):null;
                      // Compare actual vs original target; use reforecast as forward guide
                      const variance=actual!==null && orig!=null ? actual-orig : null;
                      const hasEvt=activeEvents.some(e=>e.month===m);
                      const isPast=actual!==null;
                      return(
                        <tr key={m} style={{ borderBottom:"1px solid #f0f0f0", background:hasEvt?"#fdf8ff":isPast?"#fafafa":"#fff" }}>
                          <td style={{ padding:"7px 12px", fontWeight:600 }}>
                            {m}{hasEvt&&<span style={{ marginLeft:6, fontSize:11, color:"#9C27B0", fontWeight:700 }}>★</span>}
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:"#1B5E20", fontWeight:600 }}>
                            {orig!=null?`$${Math.round(orig).toLocaleString()}`:"—"}
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:refc!==null?"#1565C0":"#aaa", fontWeight:refc!==null?700:400 }}>
                            {refc!==null?`$${Math.round(refc).toLocaleString()}`:"—"}
                          </td>
                          <td style={{ padding:"4px 8px", textAlign:"center" }}>
                            <input type="number" placeholder="—" value={actuals.finance[i]}
                              onChange={e=>setActuals(p=>({...p,finance:p.finance.map((v,j)=>j===i?e.target.value:v)}))}
                              style={{ width:100, padding:"4px 6px", border:"1px solid #ddd", borderRadius:4, fontSize:13, textAlign:"center", fontFamily:"inherit" }} />
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:variance!==null?700:400, color:variance===null?"#ccc":variance>=0?"#2E7D32":"#c62828" }}>
                            {variance!==null?(variance>=0?`+$${Math.round(variance).toLocaleString()}`:`-$${Math.round(Math.abs(variance)).toLocaleString()}`):"—"}
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center" }}>
                            {actual===null?<span style={{color:"#ccc"}}>—</span>
                              :actual>=orig
                                ?<span style={{background:"#E8F5E9",color:"#2E7D32",padding:"2px 10px",borderRadius:20,fontWeight:700,fontSize:12}}>✓ On Track</span>
                                :<span style={{background:"#FFEBEE",color:"#c62828",padding:"2px 10px",borderRadius:20,fontWeight:700,fontSize:12}}>⚠ Behind</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══ SEASONAL TAB ══ */}
        {tab==="seasonal" && (
          <div>
            {head("Seasonal Pattern Analysis","Indices from your two years of history. Above 1.0 = above-average month; below 1.0 = below-average. These shape month-by-month targets.")}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:20 }}>
              {[["Membership Seasonal Indices","Member Index","#2E7D32"],["Finance Seasonal Indices","Finance Index","#1565C0"]].map(([title,key,color])=>(
                <div key={key} style={card}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:16, textTransform:"uppercase", letterSpacing:"0.05em" }}>{title}</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={indexChart} margin={{ top:5, right:10, bottom:0, left:-10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="month" tick={{ fontSize:11 }} />
                      <YAxis tick={{ fontSize:11 }} domain={[0,"auto"]} />
                      <Tooltip formatter={v=>v.toFixed(2)} />
                      <ReferenceLine y={1.0} stroke="#aaa" strokeDasharray="4 3" />
                      <Bar dataKey={key} fill={color} radius={[3,3,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>
            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:16, textTransform:"uppercase", letterSpacing:"0.05em" }}>Index Detail</div>
              <table style={{ borderCollapse:"collapse", width:"100%", fontSize:13 }}>
                <thead><tr>
                  <th style={{ ...th, textAlign:"left" }}>Month</th>
                  <th style={{ ...th, textAlign:"center", color:"#2E7D32" }}>Member Index</th>
                  <th style={{ ...th, textAlign:"center" }}>Interpretation</th>
                  <th style={{ ...th, textAlign:"center", color:"#1565C0" }}>Finance Index</th>
                  <th style={{ ...th, textAlign:"center" }}>Interpretation</th>
                </tr></thead>
                <tbody>
                  {MONTHS.map((m,i)=>{
                    const mi=Math.round(memberIndices[i]*100)/100, fi=Math.round(financeIndices[i]*100)/100;
                    const mp=Math.round((mi-1)*100), fp=Math.round((fi-1)*100);
                    return(
                      <tr key={m} style={{ borderBottom:"1px solid #f0f0f0" }}>
                        <td style={{ padding:"7px 12px", fontWeight:600 }}>{m}</td>
                        <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:700, color:mi>=1?"#2E7D32":"#c62828" }}>{mi.toFixed(2)}</td>
                        <td style={{ padding:"7px 12px", textAlign:"center", fontSize:12, color:"#666" }}>{mp>=0?`${mp}% above avg`:`${Math.abs(mp)}% below avg`}</td>
                        <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:700, color:fi>=1?"#1565C0":"#c62828" }}>{fi.toFixed(2)}</td>
                        <td style={{ padding:"7px 12px", textAlign:"center", fontSize:12, color:"#666" }}>{fp>=0?`${fp}% above avg`:`${Math.abs(fp)}% below avg`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
