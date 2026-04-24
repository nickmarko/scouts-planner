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

// Reforecast: lock actuals, reproject remaining months to hit goal, apply future events
function buildReforecast(actuals, goalVal, indices, events) {
  const last = lastActualIdx(actuals);
  if (last === -1) return Array(12).fill(null);
  const lastVal = Number(actuals[last]);
  const result = Array(12).fill(null);
  for (let i = 0; i <= last; i++) {
    if (actuals[i] !== "") result[i] = Number(actuals[i]);
  }
  if (last === 11) return result;
  // Adjust goal: subtract lump sums already captured in actuals, keep future ones
  const futureEvents = events.filter(e => MONTHS.indexOf(e.month) > last && e.amount !== "" && Number(e.amount) !== 0);
  const futureEventTotal = futureEvents.reduce((s, e) => s + Number(e.amount), 0);
  const adjustedGoal = goalVal - futureEventTotal; // will be re-added by applyEvents below
  const remaining = projectSegment(lastVal, adjustedGoal, indices, last + 1);
  for (let i = last + 1; i < 12; i++) result[i] = remaining[i];
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
  const [financeGoal, setFinanceGoal] = useState(5000);
  const [financeStartBalance, setFinanceStartBalance] = useState(3000);
  const [financeEvents, setFinanceEvents] = useState([
    { id: 1, month: "Sep", amount: "", label: "Asset Sale" }
  ]);
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
  const financeGoalBalance = financeStartBalance + financeGoal;
  const activeEvents = financeEvents.filter(e => e.amount !== "" && Number(e.amount) !== 0);

  // ── Projections ──
  const origMember   = useMemo(() => buildOriginalTargets(memberStart, memberGoalCount, memberIndices, []), [memberStart, memberGoalCount, memberIndices]);
  const rfMember     = useMemo(() => buildReforecast(actuals.membership, memberGoalCount, memberIndices, []), [actuals.membership, memberGoalCount, memberIndices]);
  const trajMember   = useMemo(() => buildTrajectory(actuals.membership, memberIndices, []), [actuals.membership, memberIndices]);

  const origFinance  = useMemo(() => buildOriginalTargets(financeStartBalance, financeGoalBalance, financeIndices, activeEvents), [financeStartBalance, financeGoalBalance, financeIndices, activeEvents]);
  const rfFinance    = useMemo(() => buildReforecast(actuals.finance, financeGoalBalance, financeIndices, activeEvents), [actuals.finance, financeGoalBalance, financeIndices, activeEvents]);
  const trajFinance  = useMemo(() => buildTrajectory(actuals.finance, financeIndices, activeEvents), [actuals.finance, financeIndices, activeEvents]);

  const lastMemberIdx  = lastActualIdx(actuals.membership);
  const lastFinanceIdx = lastActualIdx(actuals.finance);
  const hasM = lastMemberIdx >= 0;
  const hasF = lastFinanceIdx >= 0;

  const projMemberEnd  = trajMember[11];
  const projFinanceEnd = trajFinance[11];

  // ── Chart data ──
  const memberChart = MONTHS.map((m, i) => ({
    month: m,
    [historicalData.year1.label]: historicalData.year1.membership[i],
    [historicalData.year2.label]: historicalData.year2.membership[i],
    "Original Target":       origMember[i],
    "Actual":                actuals.membership[i] !== "" ? Number(actuals.membership[i]) : null,
    "Reforecast to Goal":    rfMember[i],
    "Projected Trajectory":  trajMember[i],
  }));

  const financeChart = MONTHS.map((m, i) => ({
    month: m,
    "Original Target":      origFinance[i],
    "Actual":               actuals.finance[i] !== "" ? Number(actuals.finance[i]) : null,
    "Reforecast to Goal":   rfFinance[i],
    "Projected Trajectory": trajFinance[i],
  }));

  const indexChart = MONTHS.map((m, i) => ({
    month: m, "Member Index": Math.round(memberIndices[i]*100)/100, "Finance Index": Math.round(financeIndices[i]*100)/100
  }));

  // ── Styles ──
  const card = { background:"#fff", borderRadius:12, padding:24, boxShadow:"0 2px 8px rgba(0,0,0,0.06)", marginBottom:20 };
  const th   = { padding:"8px 12px", background:"#f5f5f5", fontWeight:700, color:"#555", fontSize:13 };
  const head = (title, sub) => (
    <div style={{ marginBottom:20 }}>
      <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1a3a1a", letterSpacing:"-0.02em" }}>{title}</h2>
      {sub && <p style={{ margin:"4px 0 0", fontSize:13, color:"#777" }}>{sub}</p>}
    </div>
  );

  const SummaryBanner = ({ hasActuals, lastIdx, rfLine, trajEnd, goalVal, goalLabel, prefix="" }) => {
    if (!hasActuals) return null;
    const gap = trajEnd !== null ? trajEnd - goalVal : null;
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
          <div style={{ fontSize:12, color:"#888" }}>
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
              goalVal={memberGoalCount} goalLabel=" scouts" />

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>Monthly Membership Chart</div>
              <ChartLegend items={[
                { color:"#a5d6a7", label:historicalData.year1.label, dash:"4 3" },
                { color:"#66bb6a", label:historicalData.year2.label },
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
                  <YAxis tick={{ fontSize:12 }} tickFormatter={v=>v.toLocaleString()} />
                  <Tooltip content={<Tip suffix=" scouts" />} />
                  <Line type="monotone" dataKey={historicalData.year1.label} stroke="#a5d6a7" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                  <Line type="monotone" dataKey={historicalData.year2.label} stroke="#66bb6a" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Original Target" stroke="#1B5E20" strokeWidth={2} dot={{ fill:"#1B5E20", r:3 }} strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="Actual" stroke="#F57F17" strokeWidth={2.5} dot={{ fill:"#F57F17", r:5 }} connectNulls={false} />
                  {hasM&&<Line type="monotone" dataKey="Reforecast to Goal" stroke="#1565C0" strokeWidth={2} dot={false} strokeDasharray="4 2" />}
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
              <div style={{ fontSize:13, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:20 }}>Finance Goals</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:32 }}>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
                    <span style={{ fontSize:13, color:"#666", fontWeight:600 }}>Starting Bank Balance</span>
                    <span style={{ fontSize:28, fontWeight:800, color:"#555" }}>${financeStartBalance.toLocaleString()}</span>
                  </div>
                  <input type="range" min={0} max={20000} step={500} value={financeStartBalance}
                    onChange={e=>setFinanceStartBalance(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#555" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>$0</span><span>$10k</span><span>$20k</span>
                  </div>
                </div>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
                    <span style={{ fontSize:13, color:"#666", fontWeight:600 }}>Year-End Net Change Goal</span>
                    <span style={{ fontSize:28, fontWeight:800, color:financeGoal>=0?"#2E7D32":"#c62828" }}>
                      {financeGoal>=0?"+$":"-$"}{Math.abs(financeGoal).toLocaleString()}
                    </span>
                  </div>
                  <input type="range" min={-10000} max={20000} step={500} value={financeGoal}
                    onChange={e=>setFinanceGoal(Number(e.target.value))}
                    style={{ width:"100%", cursor:"pointer", accentColor:"#2E7D32" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", marginTop:4 }}>
                    <span>-$10k</span><span>$0</span><span>+$10k</span><span>+$20k</span>
                  </div>
                  <div style={{ marginTop:8, fontSize:12, color:"#888" }}>
                    Target ending balance: <b style={{ color:"#2E7D32" }}>${financeGoalBalance.toLocaleString()}</b>
                  </div>
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

            <SummaryBanner hasActuals={hasF} lastIdx={lastFinanceIdx}
              rfLine={rfFinance} trajEnd={projFinanceEnd}
              goalVal={financeGoalBalance} goalLabel="" prefix="$" />

            <div style={card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#555", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>Running Balance Chart</div>
              <ChartLegend items={[
                { color:"#1B5E20", label:"Original Target", dash:"6 3" },
                { color:"#F57F17", label:"Actual" },
                ...(hasF?[
                  { color:"#1565C0", label:"Reforecast to Goal", dash:"4 2" },
                  { color:"#E65100", label:"Projected Trajectory", dash:"2 2" },
                ]:[]),
                ...(activeEvents.length>0?[{ color:"#9C27B0", label:"One-time Event ★" }]:[])
              ]} />
              <ResponsiveContainer width="100%" height={340}>
                <ComposedChart data={financeChart} margin={{ top:10, right:20, bottom:0, left:20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize:12 }} />
                  <YAxis tick={{ fontSize:12 }} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} />
                  <Tooltip content={<Tip prefix="$" />} />
                  <ReferenceLine y={financeStartBalance} stroke="#ddd" strokeDasharray="4 3" />
                  <ReferenceLine y={0} stroke="#ffcdd2" strokeWidth={1.5} />
                  {activeEvents.map(evt=>(
                    <ReferenceLine key={evt.id} x={evt.month} stroke="#9C27B0" strokeDasharray="3 2"
                      label={{ value:`${evt.label} ${Number(evt.amount)>=0?"+$":"-$"}${Math.abs(Number(evt.amount)).toLocaleString()}`, fontSize:10, fill:"#9C27B0", position:"insideTopRight" }} />
                  ))}
                  <Line type="monotone" dataKey="Original Target" stroke="#1B5E20" strokeWidth={2} dot={{ fill:"#1B5E20", r:3 }} strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="Actual" stroke="#F57F17" strokeWidth={2.5} dot={{ fill:"#F57F17", r:5 }} connectNulls={false} />
                  {hasF&&<Line type="monotone" dataKey="Reforecast to Goal" stroke="#1565C0" strokeWidth={2} dot={false} strokeDasharray="4 2" />}
                  {hasF&&<Line type="monotone" dataKey="Projected Trajectory" stroke="#E65100" strokeWidth={2} dot={false} strokeDasharray="2 2" />}
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
                      const orig=origFinance[i], refc=rfFinance[i];
                      const actual=actuals.finance[i]!==""?Number(actuals.finance[i]):null;
                      const variance=actual!==null?actual-orig:null;
                      const hasEvt=activeEvents.some(e=>e.month===m);
                      return(
                        <tr key={m} style={{ borderBottom:"1px solid #f0f0f0", background:hasEvt?"#fdf8ff":"#fff" }}>
                          <td style={{ padding:"7px 12px", fontWeight:600 }}>
                            {m}{hasEvt&&<span style={{ marginLeft:6, fontSize:11, color:"#9C27B0", fontWeight:700 }}>★</span>}
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:"#1B5E20", fontWeight:600 }}>${orig?.toLocaleString()}</td>
                          <td style={{ padding:"7px 12px", textAlign:"center", color:refc!==null?"#1565C0":"#ccc", fontWeight:refc!==null?700:400 }}>
                            {refc!==null?`$${refc.toLocaleString()}`:"—"}
                          </td>
                          <td style={{ padding:"4px 8px", textAlign:"center" }}>
                            <input type="number" placeholder="—" value={actuals.finance[i]}
                              onChange={e=>setActuals(p=>({...p,finance:p.finance.map((v,j)=>j===i?e.target.value:v)}))}
                              style={{ width:100, padding:"4px 6px", border:"1px solid #ddd", borderRadius:4, fontSize:13, textAlign:"center", fontFamily:"inherit" }} />
                          </td>
                          <td style={{ padding:"7px 12px", textAlign:"center", fontWeight:variance!==null?700:400, color:variance===null?"#ccc":variance>=0?"#2E7D32":"#c62828" }}>
                            {variance!==null?(variance>=0?`+$${variance.toLocaleString()}`:`-$${Math.abs(variance).toLocaleString()}`):"—"}
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
