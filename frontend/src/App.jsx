import { useState, useEffect, useCallback, useMemo } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const API_URL = "https://kaushalsharmacs-in-energy-dispatcher-api.hf.space";
const SOLAR_SHARE  = 0.55;
const WIND_SHARE   = 0.45;
const Z_THRESH     = 3.0;

// ─── OPEN-METEO: Free weather API (no key needed) ────────────────────────────
async function fetchLiveWeather(lat = 28.6139, lon = 77.209) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover,` +
    `precipitation,surface_pressure,shortwave_radiation` +
    `&forecast_days=2&timezone=auto`;
  const res  = await fetch(url);
  const data = await res.json();
  const h    = data.hourly;

  const now  = new Date();
  const rows = [];
  for (let i = 0; i < h.time.length && rows.length < 24; i++) {
    if (new Date(h.time[i]) <= now) {
      rows.unshift({
        temperature:   h.temperature_2m[i]       ?? 28,
        humidity:      h.relative_humidity_2m[i]  ?? 65,
        wind_speed:    h.wind_speed_10m[i]         ?? 15,
        cloud_cover:   h.cloud_cover[i]            ?? 40,
        precipitation: h.precipitation[i]          ?? 0,
        pressure:      h.surface_pressure[i]       ?? 1010,
        solar_rad:     h.shortwave_radiation[i]    ?? 300,
      });
    }
  }
  return { current: rows[rows.length - 1], last24h: rows };
}

// ─── LOSS OPTIMIZER ──────────────────────────────────────────────────────────
function optimizeLoss(deficitMW, beta = 1.0) {
  const opts = [
    { id: "hvac",  name: "HVAC",        mw: 20,  costPerHr: 3000,  costPerMw: 150   },
    { id: "pumps", name: "Pumps",        mw: 30,  costPerHr: 5000,  costPerMw: 166.7 },
    { id: "mill",  name: "Rolling Mill", mw: 40,  costPerHr: 15000, costPerMw: 375   },
    { id: "dgu",   name: "Diesel DGU",   mw: 999, costPerMw: 150 + beta * 0.9 * 90   },
  ].sort((a, b) => a.costPerMw - b.costPerMw);

  let remaining = deficitMW;
  const plan = [];
  for (const opt of opts) {
    if (remaining <= 0) break;
    if (opt.id === "dgu") {
      const mw   = parseFloat(remaining.toFixed(1));
      const cost = parseFloat((mw * 150 + beta * mw * 0.9 * 90).toFixed(0));
      plan.push({ ...opt, allocated: mw, cost });
      remaining = 0;
    } else {
      const take = Math.min(opt.mw, remaining);
      plan.push({ ...opt, allocated: parseFloat(take.toFixed(1)), cost: opt.costPerHr });
      remaining -= take;
    }
  }
  return { plan, totalCost: parseFloat(plan.reduce((s, p) => s + p.cost, 0).toFixed(0)) };
}

// ─── ESG PDF GENERATOR ───────────────────────────────────────────────────────
function generateESGReport({ forecast, lossResult, sensors, weather, capacity, gridMax, beta, timestamp }) {
  return new Promise((resolve) => {
    if (window.jspdf) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = resolve;
    document.head.appendChild(script);
  }).then(() => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = 210, M = 18;
    let y = 0;

    const line = (x1, y1, x2, y2, color = [30, 45, 61]) => {
      doc.setDrawColor(...color); doc.line(x1, y1, x2, y2);
    };
    const rect = (x, yy, w, h, fill) => {
      doc.setFillColor(...fill); doc.rect(x, yy, w, h, "F");
    };
    const text = (t, x, yy, opts = {}) => {
      doc.setFontSize(opts.size || 10);
      doc.setTextColor(...(opts.color || [200, 218, 232]));
      doc.setFont("helvetica", opts.bold ? "bold" : "normal");
      doc.text(String(t), x, yy, { align: opts.align || "left" });
    };

    // BG
    rect(0, 0, W, 297, [8, 12, 16]);

    // HEADER
    rect(0, 0, W, 38, [13, 19, 28]);
    line(0, 38, W, 38, [0, 212, 255]);
    doc.setFillColor(0, 212, 255);
    doc.circle(M + 6, 19, 6, "F");
    doc.setFillColor(8, 12, 16);
    doc.circle(M + 6, 19, 4, "F");
    text("AI DISPATCHER — ESG REPORT", M + 16, 15, { size: 16, bold: true, color: [255,255,255] });
    text("ENERGY · ESG · CONTROL SYSTEM", M + 16, 22, { size: 8, color: [0,212,255] });
    text(`Generated: ${timestamp}`, M + 16, 29, { size: 8, color: [106,138,158] });
    text("CONFIDENTIAL", W - M, 19, { size: 8, color: [255,180,32], align: "right", bold: true });
    y = 48;

    // SECTION 1: FACILITY
    rect(M, y, W - 2*M, 7, [0,119,153]);
    text("1. FACILITY OVERVIEW", M + 3, y + 5, { size: 9, bold: true, color: [255,255,255] });
    y += 11;
    [
      ["Total Plant Capacity", `${capacity} MW`],
      ["Grid Supply Limit",    `${gridMax} MW`],
      ["Green Energy Required",`${capacity - gridMax} MW`],
      ["Solar Share",          `55%  (${((capacity-gridMax)*SOLAR_SHARE).toFixed(0)} MW)`],
      ["Wind Share",           `45%  (${((capacity-gridMax)*WIND_SHARE).toFixed(0)} MW)`],
      ["ESG Beta Weight",      `beta = ${beta}`],
      ["Report Timestamp",     timestamp],
    ].forEach(([label, val], i) => {
      if (i % 2 === 0) rect(M, y, W-2*M, 7, [13,19,28]);
      text(label, M+3, y+5, { size: 9, color: [106,138,158] });
      text(val, W-M-3, y+5, { size: 9, bold: true, color: [0,212,255], align: "right" });
      y += 7;
    });
    y += 8;

    // SECTION 2: WEATHER
    rect(M, y, W-2*M, 7, [0,119,153]);
    text("2. CURRENT WEATHER SNAPSHOT", M+3, y+5, { size: 9, bold: true, color: [255,255,255] });
    y += 11;
    [
      ["Temperature",    `${weather.temperature} C`],
      ["Humidity",       `${weather.humidity} %`],
      ["Wind Speed",     `${weather.wind_speed} m/s`],
      ["Cloud Cover",    `${weather.cloud_cover} %`],
      ["Precipitation",  `${weather.precipitation} mm`],
      ["Pressure",       `${weather.pressure} hPa`],
      ["Solar Radiation",`${weather.solar_rad} W/m2`],
    ].forEach(([label, val], i) => {
      if (i % 2 === 0) rect(M, y, W-2*M, 7, [13,19,28]);
      text(label, M+3, y+5, { size: 9, color: [106,138,158] });
      text(val, W-M-3, y+5, { size: 9, bold: true, color: [200,218,232], align: "right" });
      y += 7;
    });
    y += 8;

    // SECTION 3: FORECAST TABLE
    rect(M, y, W-2*M, 7, [0,119,153]);
    text("3. LSTM MULTI-STEP FORECAST — NEXT 6 HOURS", M+3, y+5, { size: 9, bold: true, color: [255,255,255] });
    y += 11;
    rect(M, y, W-2*M, 7, [20,30,42]);
    const cols = [M+3, M+28, M+60, M+90, M+120, M+148];
    ["Hour","Storm Prob","Solar Drop","Wind Drop","Deficit MW","Status"].forEach((h, i) => {
      text(h, cols[i], y+5, { size: 8, bold: true, color: [0,212,255] });
    });
    y += 7;
    forecast.forEach((h, i) => {
      if (i % 2 === 0) rect(M, y, W-2*M, 7, [13,19,28]);
      const sc = h.stormProb >= 60 ? [255,68,68] : h.stormProb >= 35 ? [255,176,32] : [0,232,120];
      text(`+${h.hour}h`,     cols[0], y+5, { size: 8, color: [200,218,232] });
      text(`${h.stormProb}%`, cols[1], y+5, { size: 8, bold: true, color: sc });
      text(`${h.solarDrop}%`, cols[2], y+5, { size: 8, color: [255,176,32] });
      text(`${h.windDrop}%`,  cols[3], y+5, { size: 8, color: [68,136,255] });
      text(`${h.deficit}`,    cols[4], y+5, { size: 8, color: [200,218,232] });
      text(h.isStorm ? "STORM" : "NORMAL", cols[5], y+5, { size: 8, bold: true, color: sc });
      y += 7;
    });
    y += 8;

    // SECTION 4: SENSORS
    rect(M, y, W-2*M, 7, [0,119,153]);
    text("4. SENSOR Z-SCORE HEALTH MONITOR", M+3, y+5, { size: 9, bold: true, color: [255,255,255] });
    y += 11;
    if (sensors.length === 0) {
      rect(M, y, W-2*M, 8, [13,19,28]);
      text("No anomalous sensor rows detected — all readings within Z < 3.0", M+3, y+5.5, { size: 9, color: [0,232,120] });
      y += 12;
    } else {
      rect(M, y, W-2*M, 7, [20,30,42]);
      ["Sensor ID","Hour Row","Z-Score","Status"].forEach((h, i) => {
        text(h, [M+3, M+45, M+90, M+130][i], y+5, { size: 8, bold: true, color: [0,212,255] });
      });
      y += 7;
      sensors.forEach((s, i) => {
        if (i%2===0) rect(M, y, W-2*M, 7, [13,19,28]);
        text(s.id,     M+3,   y+5, { size: 8, color: [200,218,232] });
        text(`Row ${s.row}`, M+45, y+5, { size: 8, color: [200,218,232] });
        text(`${s.z}`, M+90,  y+5, { size: 8, bold: true, color: s.z>3?[255,68,68]:[0,232,120] });
        text(s.faulty?"ANOMALY":"OK", M+130, y+5, { size: 8, bold: true, color: s.faulty?[255,68,68]:[0,232,120] });
        y += 7;
      });
      y += 4;
      rect(M, y, W-2*M, 8, [20,30,42]);
      text(`Net Sensor Correction: ${lossResult.faultyCorr > 0 ? "+" : ""}${lossResult.faultyCorr} MW`,
        M+3, y+5.5, { size: 9, bold: true, color: [255,176,32] });
      y += 12;
    }

    // SECTION 5: LOSS PLAN
    rect(M, y, W-2*M, 7, [0,119,153]);
    text("5. LOSS MINIMIZATION — OPTIMAL ACTION PLAN", M+3, y+5, { size: 9, bold: true, color: [255,255,255] });
    y += 11;
    const bw = (W-2*M-8)/3;
    [
      { label: "RAW DEFICIT",      val: `${lossResult.rawDeficit} MW`, color: [255,68,68]  },
      { label: "AFTER SENSOR FIX", val: `${lossResult.adjDeficit} MW`, color: [255,176,32] },
      { label: "TOTAL LOSS/HR",    val: `$${lossResult.totalCost.toLocaleString()}`, color: [0,232,120] },
    ].forEach((b, i) => {
      const bx = M + i*(bw+4);
      rect(bx, y, bw, 16, [13,19,28]);
      doc.setDrawColor(...b.color); doc.rect(bx, y, bw, 16);
      text(b.label, bx+bw/2, y+6,  { size: 7, color: [106,138,158], align: "center" });
      text(b.val,   bx+bw/2, y+13, { size: 11, bold: true, color: b.color, align: "center" });
    });
    y += 22;
    lossResult.plan.forEach((p, i) => {
      const isDgu = p.id === "dgu";
      rect(M, y, W-2*M, 9, isDgu?[60,10,10]:[10,40,25]);
      doc.setDrawColor(...(isDgu?[255,68,68]:[0,232,120])); doc.rect(M, y, W-2*M, 9);
      text(`${i+1}. ${isDgu?"Start Diesel Generator (DGU)":`Shed ${p.name}`}`,
        M+4, y+6, { size: 9, bold: true, color: isDgu?[255,68,68]:[0,232,120] });
      text(`${p.allocated} MW  |  $${p.cost.toLocaleString()}/hr`,
        W-M-4, y+6, { size: 9, color: [200,218,232], align: "right" });
      y += 11;
    });
    y += 6;
    rect(M, y, W-2*M, 8, [13,19,28]);
    text("Formula: Total Loss = Operational Cost + beta x (CO2 x $90) + Risk Penalty",
      M+3, y+5.5, { size: 8, color: [106,138,158] });
    text(`beta = ${beta}`, W-M-3, y+5.5, { size: 8, color: [255,176,32], align: "right" });

    // FOOTER
    rect(0, 280, W, 17, [13,19,28]);
    line(0, 280, W, 280, [0,212,255]);
    text("AI DISPATCHER — Confidential ESG Report", M, 289, { size: 8, color: [106,138,158] });
    text("Page 1 of 1", W-M, 289, { size: 8, color: [106,138,158], align: "right" });
    text("Generated by LSTM Weather Model + Greedy Loss Optimizer", W/2, 289, { size: 7, color: [58,85,104], align: "center" });

    doc.save(`ESG_Report_${new Date().toISOString().slice(0,10)}.pdf`);
  });
}

// ─── COLOUR HELPERS ──────────────────────────────────────────────────────────
const stormColor = (p) => p >= 60 ? "#ff4444" : p >= 35 ? "#ffb020" : "#00e878";
const zColor     = (z) => z > Z_THRESH ? "#ff4444" : z > 2 ? "#ffb020" : "#00e878";

// ─── UI COMPONENTS ───────────────────────────────────────────────────────────
const Badge = ({ label, color }) => (
  <span style={{ background: color+"22", color, border: `1px solid ${color}55`,
    fontSize: 10, padding: "2px 8px", borderRadius: 2, letterSpacing: 1,
    fontFamily: "monospace", whiteSpace: "nowrap" }}>{label}</span>
);

const MetricCard = ({ label, value, unit, accent, sub }) => (
  <div style={{ background: "#0d1318", border: "1px solid #1e2d3d",
    borderTop: `2px solid ${accent}`, borderRadius: 4, padding: "16px 18px" }}>
    <div style={{ fontSize: 9, letterSpacing: 3, color: "#6a8a9e",
      fontFamily: "monospace", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    <div style={{ fontFamily: "monospace", fontSize: 28, color: accent, lineHeight: 1 }}>
      {value}<span style={{ fontSize: 13, marginLeft: 4, color: accent+"99" }}>{unit}</span>
    </div>
    {sub && <div style={{ fontSize: 11, color: "#6a8a9e", marginTop: 6 }}>{sub}</div>}
  </div>
);

const ProgressBar = ({ pct, color, label, sublabel }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
      <span style={{ fontSize: 11, color: "#c8dae8" }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: 11, color }}>{sublabel}</span>
    </div>
    <div style={{ height: 6, background: "#111820", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(100,pct)}%`, height: "100%",
        background: `linear-gradient(90deg,${color}88,${color})`,
        borderRadius: 3, transition: "width .6s ease" }} />
    </div>
  </div>
);

const SectionTitle = ({ children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
    <span style={{ fontSize: 10, letterSpacing: 4, color: "#00d4ff",
      fontFamily: "monospace", textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>
    <div style={{ flex: 1, height: 1, background: "#1e2d3d" }} />
  </div>
);

const Card = ({ children, style = {}, alert }) => (
  <div style={{ background: "#141c24", border: `1px solid ${alert?"#7a1010":"#1e2d3d"}`,
    borderRadius: 4, padding: 20, position: "relative", overflow: "hidden", ...style }}>
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2,
      background: alert
        ? "linear-gradient(90deg,transparent,#ff3d3d,transparent)"
        : "linear-gradient(90deg,transparent,#00d4ff44,transparent)" }} />
    {children}
  </div>
);

// ─── MAIN ────────────────────────────────────────────────────────────────────
export default function AIDashboard() {
  const [capacity,       setCapacity]       = useState(500);
  const [gridMax,        setGridMax]        = useState(350);
  const [beta,           setBeta]           = useState(1.0);
  const [weather,        setWeather]        = useState({
    temperature: 28, humidity: 72, wind_speed: 18,
    cloud_cover: 45, precipitation: 0.3, pressure: 1010, solar_rad: 380,
  });
  const [last24h,        setLast24h]        = useState(null);
  const [forecast,       setForecast]       = useState([]);
  const [sensors,        setSensors]        = useState([]);
  const [lossResult,     setLossResult]     = useState(null);
  const [running,        setRunning]        = useState(false);
  const [ran,            setRan]            = useState(false);
  const [apiError,       setApiError]       = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherSource,  setWeatherSource]  = useState("manual");
  const [pdfLoading,     setPdfLoading]     = useState(false);
  const [,               setTick]           = useState(0);

  const greenRequired = capacity - gridMax;

  useEffect(() => {
    const t = setInterval(() => setTick(x => x+1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = useMemo(() => new Date(), []);

  // ── FETCH LIVE WEATHER ────────────────────────────────────────────────────
  const fetchWeather = useCallback(async () => {
    setWeatherLoading(true);
    setApiError(null);
    try {
      const { current, last24h: rows } = await fetchLiveWeather();
      setWeather(current);
      setLast24h(rows);
      setWeatherSource("live");
    } catch {
      setApiError("Could not fetch live weather — check internet. Using manual input.");
      setWeatherSource("manual");
    } finally {
      setWeatherLoading(false);
    }
  }, []);

  // ── RUN PIPELINE ─────────────────────────────────────────────────────────
  const runPipeline = useCallback(async () => {
    setRunning(true);
    setApiError(null);
    try {
      const last_24h = last24h && last24h.length === 24
        ? last24h
        : Array(24).fill({ ...weather });

      const response = await fetch(`${API_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ last_24h, green_mw: greenRequired, beta }),
      });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const fc = data.forecast.map(h => ({
        hour: h.hour, stormProb: h.storm_prob, solarDrop: h.solar_drop,
        windDrop: h.wind_drop, deficit: h.adj_deficit,
        rawDeficit: h.raw_deficit, isStorm: h.is_storm,
      }));
      const sc = (data.sensor_issues || []).map((s, i) => ({
        id: `SENSOR-${String(i+1).padStart(2,"0")}`,
        z: s.z_max, faulty: s.faulty, row: s.row,
      }));
      const peakHour   = fc.find(h => h.isStorm) || fc[fc.length-1];
      const adjDeficit = peakHour?.deficit    ?? 0;
      const rawDeficit = peakHour?.rawDeficit ?? 0;
      const lr         = optimizeLoss(adjDeficit, beta);

      setForecast(fc);
      setSensors(sc);
      setLossResult({ ...lr, rawDeficit,
        adjDeficit:  parseFloat(adjDeficit.toFixed(1)),
        faultyCorr:  parseFloat((data.sensor_correction ?? 0).toFixed(1)),
      });
      setRan(true);
    } catch (err) {
      const isNetwork = err.message.includes("fetch") || err.message.includes("Failed");
      setApiError(isNetwork
        ? "Cannot reach server — make sure server.py is running (python server.py)"
        : `Model error: ${err.message}`);
    } finally {
      setRunning(false);
    }
  }, [weather, beta, greenRequired, last24h]);

  // ── GENERATE PDF ──────────────────────────────────────────────────────────
  const handlePDF = useCallback(async () => {
    if (!lossResult) return;
    setPdfLoading(true);
    try {
      await generateESGReport({ forecast, lossResult, sensors, weather,
        capacity, gridMax, beta, timestamp: now.toLocaleString() });
    } catch (e) {
      setApiError("PDF generation failed: " + e.message);
    } finally {
      setPdfLoading(false);
    }
  }, [forecast, lossResult, sensors, weather, capacity, gridMax, beta, now]);

  const stormEta  = ran ? forecast.find(h => h.isStorm) : null;
  const anySensor = sensors.some(s => s.faulty);
  const showAlert = ran && (stormEta || anySensor);

  const wFields = [
    { key: "temperature",   label: "Temp",    unit: "°C",  min: 0,   max: 50,   step: 0.5 },
    { key: "humidity",      label: "Humidity",unit: "%",   min: 0,   max: 100,  step: 1   },
    { key: "wind_speed",    label: "Wind",    unit: "m/s", min: 0,   max: 60,   step: 0.5 },
    { key: "cloud_cover",   label: "Clouds",  unit: "%",   min: 0,   max: 100,  step: 1   },
    { key: "precipitation", label: "Rain",    unit: "mm",  min: 0,   max: 50,   step: 0.1 },
    { key: "pressure",      label: "Pressure",unit: "hPa", min: 960, max: 1040, step: 1   },
    { key: "solar_rad",     label: "Solar",   unit: "W/m²",min: 0,   max: 900,  step: 5   },
  ];

  const S = {
    app: { background: "#080c10", minHeight: "100vh", color: "#c8dae8",
      fontFamily: "'Barlow','Segoe UI',sans-serif", fontSize: 14 },
    header: { background: "rgba(8,12,16,.96)", borderBottom: "1px solid #1e2d3d",
      backdropFilter: "blur(12px)", padding: "0 28px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      height: 56, position: "sticky", top: 0, zIndex: 100 },
    main: { padding: "24px 28px", maxWidth: 1440, margin: "0 auto" },
    label: { fontSize: 9, letterSpacing: 3, color: "#6a8a9e", fontFamily: "monospace",
      textTransform: "uppercase", display: "block", marginBottom: 6 },
    numInput: { background: "#0d1318", border: "1px solid #253545", borderRadius: 3,
      color: "#00d4ff", fontFamily: "monospace", fontSize: 18,
      padding: "9px 13px", width: "100%", outline: "none" },
    smallInput: { background: "#0d1318", border: "1px solid #253545", borderRadius: 3,
      color: "#c8dae8", fontFamily: "monospace", fontSize: 13,
      padding: "7px 10px", width: "100%", outline: "none" },
    runBtn: { width: "100%", padding: "13px 0",
      background: running
        ? "linear-gradient(135deg,#253545,#1e2d3d)"
        : "linear-gradient(135deg,#007799,#4488ff)",
      border: "none", borderRadius: 3, color: "#fff", fontFamily: "monospace",
      fontSize: 13, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase",
      cursor: running ? "not-allowed" : "pointer", transition: "all .2s" },
    liveBtn: { padding: "9px 16px",
      background: weatherLoading
        ? "linear-gradient(135deg,#253545,#1e2d3d)"
        : "linear-gradient(135deg,#004433,#007744)",
      border: "1px solid #00774466", borderRadius: 3, color: "#00e878",
      fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 2,
      cursor: weatherLoading ? "not-allowed" : "pointer", transition: "all .2s",
      display: "flex", alignItems: "center", gap: 6 },
    pdfBtn: { padding: "10px 20px",
      background: pdfLoading || !ran
        ? "linear-gradient(135deg,#253545,#1e2d3d)"
        : "linear-gradient(135deg,#550033,#990055)",
      border: `1px solid ${ran?"#ff006688":"#25354566"}`,
      borderRadius: 3, color: ran ? "#ff66aa" : "#3a5568",
      fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 2,
      cursor: pdfLoading||!ran ? "not-allowed" : "pointer", transition: "all .2s",
      display: "flex", alignItems: "center", gap: 6 },
  };

  return (
    <div style={S.app}>
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 34, height: 34,
            background: "linear-gradient(135deg,#00d4ff,#4488ff)",
            clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)" }} />
          <div>
            <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 16, letterSpacing: 3, color: "#fff" }}>AI DISPATCHER</div>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#00d4ff", letterSpacing: 3 }}>ENERGY · ESG · CONTROL</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {showAlert && (
            <div style={{ display: "flex", alignItems: "center", gap: 8,
              background: "#7a101022", border: "1px solid #ff3d3d55", borderRadius: 3, padding: "5px 12px" }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff4444", animation: "blink 1s infinite" }} />
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#ff4444", letterSpacing: 1 }}>
                {stormEta ? `STORM IN +${stormEta.hour}H` : "SENSOR FAULT"}
              </span>
            </div>
          )}
          {ran && !showAlert && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#00e878", animation: "blink 1.4s infinite" }} />
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00e878", letterSpacing: 1 }}>SYSTEM NORMAL</span>
            </div>
          )}

          {/* ── ESG PDF BUTTON in header ── */}
          <button style={S.pdfBtn} onClick={handlePDF} disabled={pdfLoading || !ran} title={!ran ? "Run the model first" : "Download ESG Report PDF"}>
            <span style={{ fontSize: 14 }}>{pdfLoading ? "⟳" : "📄"}</span>
            {pdfLoading ? "GENERATING PDF..." : "ESG REPORT PDF"}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%",
              background: apiError ? "#ff4444" : ran ? "#00e878" : "#3a5568" }} />
            <span style={{ fontFamily: "monospace", fontSize: 10, color: "#3a5568" }}>
              {apiError ? "API OFFLINE" : ran ? "API CONNECTED" : "API STANDBY"}
            </span>
          </div>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: "#3a5568" }}>
            {now.toLocaleTimeString()}
          </span>
        </div>
      </header>

      <style>{`
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .row-anim{animation:fadeIn .4s ease both}
        input:focus{border-color:#00d4ff!important;outline:none}
        button:hover:not(:disabled){filter:brightness(1.2);transform:translateY(-1px)}
      `}</style>

      <main style={S.main}>
        {apiError && (
          <div style={{ background: "#7a101018", border: "1px solid #ff3d3d88",
            borderRadius: 4, padding: "12px 18px", marginBottom: 16,
            display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "#ff4444", fontSize: 16 }}>⚠</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#ff4444" }}>{apiError}</span>
            </div>
            <button onClick={() => setApiError(null)} style={{ background: "none", border: "none",
              color: "#6a8a9e", cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20, marginBottom: 20 }}>
          <Card>
            <SectionTitle>Factory Configuration</SectionTitle>
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Total Plant Capacity</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="number" style={S.numInput} value={capacity}
                  onChange={e => setCapacity(+e.target.value)} min={100} max={2000} />
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3a5568" }}>MW</span>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Grid Supply Limit</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="number" style={S.numInput} value={gridMax}
                  onChange={e => setGridMax(+e.target.value)} min={0} max={capacity} />
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3a5568" }}>MW</span>
              </div>
            </div>
            <div style={{ background: "#080c10", border: "1px solid #1e2d3d",
              borderRadius: 3, padding: "12px 14px", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#6a8a9e" }}>Green Energy Required</span>
                <span style={{ fontFamily: "monospace", fontSize: 20, color: "#00e878" }}>{greenRequired} MW</span>
              </div>
              <div style={{ marginTop: 10 }}>
                <ProgressBar pct={(greenRequired/capacity)*100} color="#00e878"
                  label="Solar (55%)" sublabel={`${(greenRequired*SOLAR_SHARE).toFixed(0)} MW`} />
                <ProgressBar pct={(greenRequired/capacity)*100} color="#4488ff"
                  label="Wind (45%)" sublabel={`${(greenRequired*WIND_SHARE).toFixed(0)} MW`} />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>ESG Weight β (1=normal · 3=report day)</label>
              <input type="range" min={1} max={5} step={0.5} value={beta}
                onChange={e => setBeta(+e.target.value)}
                style={{ width: "100%", accentColor: "#00d4ff" }} />
              <div style={{ display: "flex", justifyContent: "space-between",
                fontFamily: "monospace", fontSize: 11, color: "#6a8a9e", marginTop: 4 }}>
                <span>β = {beta}</span>
                <span>{beta>=3?"🔴 High ESG":beta>=2?"🟡 Medium":"🟢 Normal"}</span>
              </div>
            </div>
            <button style={S.runBtn} onClick={runPipeline} disabled={running}>
              {running ? "⟳  RUNNING MODEL..." : "▶  RUN AI DISPATCHER"}
            </button>
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#080c10",
              border: "1px solid #1e2d3d", borderRadius: 3, fontSize: 10, color: "#3a5568", fontFamily: "monospace" }}>
              <div style={{ color: "#00d4ff", marginBottom: 4 }}>▸ START BACKEND FIRST</div>
              <div>cd backend → python server.py</div>
            </div>
          </Card>

          <div>
            <SectionTitle>Live Power Status</SectionTitle>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
              <MetricCard label="Total Consumption" value={capacity}      unit="MW" accent="#c8dae8" />
              <MetricCard label="From Grid"         value={gridMax}       unit="MW" accent="#4488ff"
                sub={`${((gridMax/capacity)*100).toFixed(0)}% of total`} />
              <MetricCard label="Green Required"    value={greenRequired} unit="MW" accent="#00e878"
                sub={`${((greenRequired/capacity)*100).toFixed(0)}% of total`} />
              <MetricCard label="ESG Beta"          value={beta}          unit="×"  accent="#ffb020"
                sub="CO₂ penalty multiplier" />
            </div>

            {/* ── WEATHER WITH LIVE FETCH BUTTON ── */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 10, letterSpacing: 3, color: "#00d4ff",
                fontFamily: "monospace", textTransform: "uppercase" }}>
                {weatherSource === "live" ? "🌐 Live Weather — Open-Meteo API" : "Weather Readings (Manual Input)"}
              </span>
              <button style={S.liveBtn} onClick={fetchWeather} disabled={weatherLoading}>
                {weatherLoading
                  ? <><span style={{ animation: "blink 1s infinite" }}>⟳</span> FETCHING...</>
                  : <><span>🌐</span> FETCH LIVE WEATHER</>}
              </button>
            </div>

            {weatherSource === "live" && (
              <div style={{ background: "#003322", border: "1px solid #00774455",
                borderRadius: 3, padding: "8px 14px", marginBottom: 10,
                display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#00e878" }}>✓</span>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00e878" }}>
                  Real weather loaded — last 24h history sent to LSTM model automatically
                </span>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8 }}>
              {wFields.map(f => (
                <div key={f.key} style={{ background: "#0d1318",
                  border: `1px solid ${weatherSource==="live"?"#00774455":"#1e2d3d"}`,
                  borderRadius: 3, padding: "10px 11px" }}>
                  <div style={{ fontSize: 9, color: "#3a5568", letterSpacing: 1.5,
                    textTransform: "uppercase", fontFamily: "monospace" }}>{f.label}</div>
                  <input type="number" style={{ ...S.smallInput, marginTop: 5 }}
                    value={weather[f.key]} min={f.min} max={f.max} step={f.step}
                    onChange={e => {
                      setWeather(w => ({ ...w, [f.key]: +e.target.value }));
                      setWeatherSource("manual");
                    }} />
                  <div style={{ fontSize: 9, color: "#3a5568", marginTop: 3, fontFamily: "monospace" }}>{f.unit}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* FORECAST */}
        {ran && (
          <div className="row-anim" style={{ marginBottom: 20 }}>
            <SectionTitle>Multi-Step Weather Forecast — Next 6 Hours (LSTM Model)</SectionTitle>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10 }}>
              {forecast.map(h => (
                <Card key={h.hour} alert={h.isStorm} style={{ padding: "14px 16px", textAlign: "center" }}>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#6a8a9e", marginBottom: 10 }}>+{h.hour}h</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ height: 48, background: "#080c10", borderRadius: 3,
                      display: "flex", alignItems: "flex-end", overflow: "hidden" }}>
                      <div style={{ width: "100%", height: `${h.stormProb}%`,
                        background: `linear-gradient(180deg,${stormColor(h.stormProb)},${stormColor(h.stormProb)}44)`,
                        transition: "height .6s ease" }} />
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 20, color: stormColor(h.stormProb), marginTop: 6 }}>
                      {h.stormProb}%
                    </div>
                    <div style={{ fontSize: 9, color: "#6a8a9e", letterSpacing: 1 }}>STORM PROB</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#ffb020", marginBottom: 3 }}>☀ Solar drop: {h.solarDrop}%</div>
                  <div style={{ fontSize: 11, color: "#4488ff", marginBottom: 8 }}>💨 Wind drop: {h.windDrop}%</div>
                  <div style={{ fontFamily: "monospace", fontSize: 13, color: h.isStorm?"#ff4444":"#c8dae8" }}>
                    {h.deficit} MW deficit
                  </div>
                  {h.isStorm && <Badge label="STORM" color="#ff4444" />}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* SENSOR + LOSS */}
        {ran && (
          <div className="row-anim" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
            <Card>
              <SectionTitle>Sensor Z-Score Health Monitor</SectionTitle>
              <div style={{ marginBottom: 12, fontSize: 12, color: "#6a8a9e" }}>
                Z = |reading − mean| / std_dev → if Z &gt; {Z_THRESH} sensor row is flagged
              </div>
              {lossResult && (
                <div style={{ background: "#080c10", border: "1px solid #1e2d3d",
                  borderRadius: 3, padding: "10px 14px", marginBottom: 14,
                  display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#6a8a9e" }}>Net sensor correction applied</span>
                  <span style={{ fontFamily: "monospace", fontSize: 16,
                    color: lossResult.faultyCorr!==0?"#ffb020":"#00e878" }}>
                    {lossResult.faultyCorr>0?"+":""}{lossResult.faultyCorr} MW
                  </span>
                </div>
              )}
              {sensors.length === 0
                ? <div style={{ padding: 20, textAlign: "center", fontFamily: "monospace", fontSize: 12, color: "#00e878" }}>
                    ✓ No anomalous sensor rows detected
                  </div>
                : <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #1e2d3d" }}>
                        {["Sensor","Hour Row","Z-Max","Status"].map(h => (
                          <th key={h} style={{ padding: "6px 10px", fontSize: 9,
                            color: "#3a5568", letterSpacing: 2, fontFamily: "monospace",
                            textAlign: "left", textTransform: "uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sensors.map(s => (
                        <tr key={s.id} style={{ borderBottom: "1px solid #111820" }}>
                          <td style={{ padding: "9px 10px", fontFamily: "monospace", fontSize: 12, color: "#c8dae8" }}>{s.id}</td>
                          <td style={{ padding: "9px 10px", fontFamily: "monospace", fontSize: 12, color: "#c8dae8" }}>Row {s.row}</td>
                          <td style={{ padding: "9px 10px", fontFamily: "monospace", fontSize: 12, color: zColor(s.z), fontWeight: 700 }}>{s.z}</td>
                          <td style={{ padding: "9px 10px" }}><Badge label="ANOMALY" color="#ff4444" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </Card>

            {lossResult && (
              <Card>
                <SectionTitle>Loss Minimization — Optimal Action Plan</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                  {[
                    { label: "RAW DEFICIT",      val: `${lossResult.rawDeficit} MW`, color: "#ff4444"  },
                    { label: "AFTER SENSOR FIX", val: `${lossResult.adjDeficit} MW`, color: "#ffb020"  },
                    { label: "TOTAL LOSS/HR",    val: `$${lossResult.totalCost.toLocaleString()}`, color: "#00e878" },
                  ].map(m => (
                    <div key={m.label} style={{ background: "#080c10", border: "1px solid #1e2d3d",
                      borderRadius: 3, padding: "10px 12px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#6a8a9e", letterSpacing: 2, fontFamily: "monospace" }}>{m.label}</div>
                      <div style={{ fontFamily: "monospace", fontSize: 20, color: m.color, marginTop: 4 }}>{m.val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "#6a8a9e", marginBottom: 10 }}>
                  Greedy optimizer — cheapest $/MW first (β = {beta})
                </div>
                {lossResult.plan.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px", marginBottom: 6,
                    background: "#0d1318", border: "1px solid #1e2d3d", borderRadius: 3 }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%",
                      background: p.id==="dgu"?"#7a101033":"#00771033",
                      border: `1px solid ${p.id==="dgu"?"#ff4444":"#00e878"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "monospace", fontSize: 11,
                      color: p.id==="dgu"?"#ff4444":"#00e878" }}>{i+1}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "#c8dae8", fontWeight: 500 }}>
                        {p.id==="dgu"?"Start Diesel Generator (DGU)":`Shed ${p.name}`}
                      </div>
                      <div style={{ fontSize: 11, color: "#6a8a9e", marginTop: 2, fontFamily: "monospace" }}>
                        {p.allocated} MW · ${p.cost.toLocaleString()}/hr
                      </div>
                    </div>
                    <Badge label={p.id==="dgu"?"DIESEL":"SHED"} color={p.id==="dgu"?"#ff4444":"#00e878"} />
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}

        {/* STORM ALERT */}
        {ran && stormEta && (
          <div className="row-anim" style={{ background: "#7a101018",
            border: "1px solid #ff3d3d55", borderRadius: 4, padding: "16px 22px",
            display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%",
                background: "#ff4444", animation: "blink 1s infinite" }} />
              <div>
                <div style={{ fontFamily: "monospace", fontSize: 14, color: "#ff4444", letterSpacing: 2 }}>
                  STORM ALERT — ARRIVING IN +{stormEta.hour} HOUR{stormEta.hour>1?"S":""}
                </div>
                <div style={{ fontSize: 12, color: "#6a8a9e", marginTop: 4 }}>
                  Deficit: <b style={{ color: "#ff4444" }}>{lossResult?.adjDeficit} MW</b>
                  &nbsp;·&nbsp; Window: <b style={{ color: "#ffb020" }}>{stormEta.hour*60-15} min</b>
                  &nbsp;·&nbsp; Cost: <b style={{ color: "#00e878" }}>${lossResult?.totalCost.toLocaleString()}/hr</b>
                </div>
              </div>
            </div>
            <button style={S.pdfBtn} onClick={handlePDF} disabled={pdfLoading}>
              <span>📄</span>{pdfLoading?"GENERATING...":"ESG REPORT PDF"}
            </button>
          </div>
        )}

        {/* EMPTY STATE */}
        {!ran && !running && !apiError && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#3a5568" }}>
            <div style={{ fontFamily: "monospace", fontSize: 13, letterSpacing: 2, marginBottom: 16 }}>
              SET PARAMETERS AND CLICK ▶ RUN AI DISPATCHER
            </div>
            <div style={{ fontSize: 11, marginBottom: 20 }}>
              Or auto-load real weather data first using the button above
            </div>
            <button style={{ ...S.liveBtn, margin: "0 auto" }} onClick={fetchWeather} disabled={weatherLoading}>
              {weatherLoading?"⟳ FETCHING WEATHER...":"🌐 FETCH LIVE WEATHER NOW"}
            </button>
          </div>
        )}
        {running && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#00d4ff",
              letterSpacing: 3, animation: "blink 1s infinite" }}>
              ⟳ CALLING BACKEND · RUNNING LSTM · OPTIMIZING LOSS...
            </div>
          </div>
        )}
      </main>
    </div>
  );
}