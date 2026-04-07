import { useState, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart, ReferenceLine } from "recharts";

// ─── MODEL CONSTANTS (derived from Eshaan's Whoop data analysis) ───
const MODEL = {
  avgSleepNeed: 565,        // minutes
  avgHRV: 71.9,
  avgRHR: 58.4,
  avgDeep: 83,              // minutes
  avgRecovery: 56.2,
  avgSleepOnsetHour: 1.07,  // ~1:04 AM
  avgWakeHour: 8.45,        // ~8:27 AM
  baselineTemp: 72,         // °F user preference
  windDownMinutes: 60,
  blindOpenMinutes: 30,
  // Recovery thresholds from data
  greenRecovery: 67,
  yellowRecovery: 34,
  // Optimal ranges from analysis
  optimalSleepMin: 450,     // 7.5 hrs → avg recovery 74-81%
  optimalDeepMin: 90,       // 90+ min deep → 69% recovery
  optimalOnsetHour: 0.5,    // before 12:30am → 72% recovery
};

// ─── UTILITY FUNCTIONS ───
function formatTime(hours) {
  const totalMin = Math.round(hours * 60);
  let h = Math.floor(totalMin / 60) % 24;
  if (h < 0) h += 24;
  const m = Math.abs(totalMin % 60);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatTimeShort(hours) {
  const totalMin = Math.round(hours * 60);
  let h = Math.floor(totalMin / 60) % 24;
  if (h < 0) h += 24;
  const m = Math.abs(totalMin % 60);
  const ampm = h >= 12 ? "p" : "a";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

// ─── SMART HOME MODEL ───
function computeRecommendations(inputs) {
  const {
    prevSleepScore, recoveryScore, dayStrain, stressScore,
    prevSleepOnset, prevWakeTime,
    recSleepOnset, recWakeTime,
    useCustomWake, customWakeTime
  } = inputs;

  // Determine effective wake time
  const effectiveWake = useCustomWake ? customWakeTime : recWakeTime;
  const effectiveSleep = recSleepOnset;

  // ─── CALCULATE RECOVERY NEEDS ───
  const recoveryNeed = recoveryScore < MODEL.yellowRecovery ? "high"
    : recoveryScore < MODEL.greenRecovery ? "moderate" : "low";

  const strainLevel = dayStrain >= 14 ? "high"
    : dayStrain >= 8 ? "moderate" : "low";

  const sleepQualityNeed = prevSleepScore < 50 ? "high"
    : prevSleepScore < 70 ? "moderate" : "low";

  // Composite need score (0-100, higher = more aggressive intervention)
  let needScore = 0;
  needScore += recoveryScore < MODEL.yellowRecovery ? 35 : recoveryScore < MODEL.greenRecovery ? 20 : 5;
  needScore += dayStrain >= 14 ? 25 : dayStrain >= 8 ? 15 : 5;
  needScore += prevSleepScore < 50 ? 25 : prevSleepScore < 70 ? 15 : 5;
  needScore += stressScore >= 70 ? 15 : stressScore >= 40 ? 8 : 0;
  needScore = clamp(needScore, 0, 100);

  // ─── TEMPERATURE SCHEDULE ───
  // Base: 72°F. Cool room helps recovery (data: lower skin temp → better recovery)
  // On high-need days, drop to 65°F; on low-need, stay at 68-70°F
  const tempBaseline = MODEL.baselineTemp;
  const tempSleep = Math.round(lerp(69, 64, needScore / 100)); // Sleep temp: 64-69°F
  const tempDeepSleep = tempSleep - 1; // Slightly cooler during deep sleep window (first 3 hrs)
  const tempWakeUp = Math.round(lerp(70, 68, needScore / 100)); // Warm slightly before wake

  // ─── LIGHT DIMMING SCHEDULE ───
  // Wind-down starts 60 min before target sleep onset
  const windDownStart = effectiveSleep - (MODEL.windDownMinutes / 60);

  // On higher need days, start dimming a bit earlier and more aggressively
  const extraWindDown = needScore > 60 ? 15 / 60 : 0; // Extra 15 min for high need
  const adjustedWindDownStart = windDownStart - extraWindDown;

  // ─── BLINDS SCHEDULE ───
  // Open gradually over 30 min ending at wake time
  const blindsStartOpen = effectiveWake - (MODEL.blindOpenMinutes / 60);

  // ─── BUILD TIMELINE ───
  const timeline = [];

  // Helper to add event
  const addEvent = (timeHours, light, temp, blinds, label, phase) => {
    timeline.push({
      time: timeHours,
      timeLabel: formatTime(timeHours),
      light: Math.round(light),
      temp: Math.round(temp * 10) / 10,
      blinds: Math.round(blinds),
      label,
      phase
    });
  };

  // Phase 1: Evening / Pre-wind-down (full lights, baseline temp)
  const eveningStart = adjustedWindDownStart - 2;
  addEvent(eveningStart, 100, tempBaseline, 0, "Evening routine", "evening");

  // Start cooling the room 30 min before wind-down
  addEvent(adjustedWindDownStart - 0.5, 100, lerp(tempBaseline, tempSleep, 0.3), 0, "Room cooling begins", "pre-winddown");

  // Phase 2: Wind-down dimming
  const windDownDuration = effectiveSleep - adjustedWindDownStart;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const time = adjustedWindDownStart + t * windDownDuration;
    // Light dims: 100% → 70% → 45% → 25% → 10% → 0%
    // Using exponential curve for natural feeling
    const light = Math.round(100 * Math.pow(1 - t, 2.2));
    const temp = lerp(lerp(tempBaseline, tempSleep, 0.3), tempSleep, t);
    const phase = t < 0.5 ? "winddown-early" : "winddown-late";
    const pct = Math.round(t * 100);

    if (i === 0) {
      addEvent(time, light, temp, 0, "Wind-down begins — lights start dimming", "winddown");
    } else if (i === steps) {
      addEvent(time, 0, tempSleep, 0, "Lights off — sleep onset", "sleep");
    } else {
      addEvent(time, light, temp, 0, `Lights at ${light}%`, phase);
    }
  }

  // Phase 3: Sleep phases
  // Deep sleep window: first ~90 min (coolest temp)
  addEvent(effectiveSleep + 0.25, 0, tempDeepSleep, 0, "Deep sleep begins — coldest temp", "deep-sleep");
  addEvent(effectiveSleep + 1.5, 0, tempDeepSleep, 0, "Deep sleep window", "deep-sleep");

  // Mid-sleep: slight warm up
  addEvent(effectiveSleep + 3, 0, tempSleep, 0, "Mid-sleep — temperature stabilizes", "sleep");

  // Late sleep / REM
  const remStart = effectiveWake - 2;
  addEvent(remStart, 0, lerp(tempSleep, tempWakeUp, 0.3), 0, "REM sleep window", "rem-sleep");

  // Phase 4: Wake-up sequence
  // Blinds start opening 30 min before wake
  addEvent(blindsStartOpen, 0, lerp(tempSleep, tempWakeUp, 0.5), 5, "Blinds begin opening — natural alarm", "waking");

  // Gradual blind opening
  const blindSteps = 4;
  for (let i = 1; i <= blindSteps; i++) {
    const t = i / blindSteps;
    const time = blindsStartOpen + t * (MODEL.blindOpenMinutes / 60);
    const blindPct = Math.round(t * 100);
    const temp = lerp(lerp(tempSleep, tempWakeUp, 0.5), tempWakeUp, t);
    const light = i === blindSteps ? 0 : 0; // Room lights stay off, natural light from blinds

    if (i === blindSteps) {
      addEvent(time, 0, tempWakeUp, 100, "Blinds fully open — wake time", "wake");
    } else {
      addEvent(time, 0, temp, blindPct, `Blinds at ${blindPct}%`, "waking");
    }
  }

  // Post-wake: lights on, comfortable temp
  addEvent(effectiveWake + 0.25, 100, tempBaseline, 100, "Room lights on — day begins", "day");

  // Sort timeline
  timeline.sort((a, b) => {
    const aAdj = a.time < 12 ? a.time + 24 : a.time;
    const bAdj = b.time < 12 ? b.time + 24 : b.time;
    return aAdj - bAdj;
  });

  return {
    timeline,
    summary: {
      needScore,
      recoveryNeed,
      strainLevel,
      sleepQualityNeed,
      tempSleep,
      tempDeepSleep,
      tempWakeUp,
      windDownStart: adjustedWindDownStart,
      blindsStart: blindsStartOpen,
      effectiveSleep,
      effectiveWake,
      recommendedSleepDuration: (effectiveWake - effectiveSleep + 24) % 24,
    }
  };
}

// ─── SLIDER COMPONENT ───
function Slider({ label, value, onChange, min, max, step = 1, unit = "", formatVal }) {
  const displayVal = formatVal ? formatVal(value) : `${value}${unit}`;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 600 }}>{displayVal}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#6366f1" }}
      />
    </div>
  );
}

// ─── TIME SLIDER ───
function TimeSlider({ label, value, onChange }) {
  return (
    <Slider
      label={label} value={value} onChange={onChange}
      min={-2} max={12} step={0.25}
      formatVal={v => formatTime(v < 0 ? v + 24 : v)}
    />
  );
}

// ─── PHASE BADGE ───
function PhaseBadge({ phase }) {
  const colors = {
    evening: { bg: "#fef3c7", text: "#92400e" },
    "pre-winddown": { bg: "#fde68a", text: "#78350f" },
    winddown: { bg: "#c4b5fd", text: "#4c1d95" },
    "winddown-early": { bg: "#c4b5fd", text: "#4c1d95" },
    "winddown-late": { bg: "#a78bfa", text: "#3b0764" },
    sleep: { bg: "#1e293b", text: "#94a3b8" },
    "deep-sleep": { bg: "#0f172a", text: "#6366f1" },
    "rem-sleep": { bg: "#1e1b4b", text: "#818cf8" },
    waking: { bg: "#fef9c3", text: "#854d0e" },
    wake: { bg: "#fef08a", text: "#713f12" },
    day: { bg: "#fde047", text: "#422006" },
  };
  const c = colors[phase] || { bg: "#334155", text: "#e2e8f0" };
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
      backgroundColor: c.bg, color: c.text, textTransform: "uppercase", letterSpacing: 0.5
    }}>
      {phase.replace(/-/g, " ")}
    </span>
  );
}

// ─── NEED INDICATOR ───
function NeedIndicator({ score }) {
  const color = score >= 60 ? "#ef4444" : score >= 35 ? "#f59e0b" : "#22c55e";
  const label = score >= 60 ? "High Recovery Need" : score >= 35 ? "Moderate Need" : "Low Need";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
      backgroundColor: `${color}15`, borderRadius: 10, border: `1px solid ${color}30`
    }}>
      <div style={{ width: 10, height: 10, borderRadius: 99, backgroundColor: color }} />
      <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
      <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>Score: {score}/100</span>
    </div>
  );
}

// ─── MAIN APP ───
export default function SmartHomeSleepApp() {
  // Input states
  const [prevSleepScore, setPrevSleepScore] = useState(75);
  const [recoveryScore, setRecoveryScore] = useState(56);
  const [dayStrain, setDayStrain] = useState(8);
  const [stressScore, setStressScore] = useState(40);
  const [prevSleepOnset, setPrevSleepOnset] = useState(1);     // 1 AM
  const [prevWakeTime, setPrevWakeTime] = useState(8.5);        // 8:30 AM
  const [recSleepOnset, setRecSleepOnset] = useState(0);       // midnight
  const [recWakeTime, setRecWakeTime] = useState(8);            // 8 AM
  const [useCustomWake, setUseCustomWake] = useState(false);
  const [customWakeTime, setCustomWakeTime] = useState(7);      // 7 AM

  const inputs = useMemo(() => ({
    prevSleepScore, recoveryScore, dayStrain, stressScore,
    prevSleepOnset, prevWakeTime, recSleepOnset, recWakeTime,
    useCustomWake, customWakeTime
  }), [prevSleepScore, recoveryScore, dayStrain, stressScore,
    prevSleepOnset, prevWakeTime, recSleepOnset, recWakeTime,
    useCustomWake, customWakeTime]);

  const result = useMemo(() => computeRecommendations(inputs), [inputs]);
  const { timeline, summary } = result;

  // Chart data
  const chartData = useMemo(() => {
    return timeline.map(t => ({
      ...t,
      timeSort: t.time < 12 ? t.time + 24 : t.time,
    })).sort((a, b) => a.timeSort - b.timeSort);
  }, [timeline]);

  const recoveryColor = recoveryScore >= 67 ? "#22c55e" : recoveryScore >= 34 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{
      minHeight: "100vh", backgroundColor: "#0f172a", color: "#e2e8f0",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: 0
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e293b 100%)",
        padding: "28px 24px 20px", borderBottom: "1px solid #334155"
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 22 }}>🌙</span>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "#f8fafc" }}>
              Smart Sleep Environment
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "#a5b4fc", margin: 0, marginTop: 4 }}>
            Personalized lighting, temperature & blinds automation powered by your Whoop data
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px" }}>
        {/* Input Panel */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24
        }}>
          {/* Left: Scores */}
          <div style={{
            backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
            border: "1px solid #334155"
          }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
              Today's Metrics
            </h2>
            <Slider label="Previous Night's Sleep Score" value={prevSleepScore} onChange={setPrevSleepScore} min={0} max={100} unit="%" />
            <Slider label="Recovery Score" value={recoveryScore} onChange={setRecoveryScore} min={0} max={100} unit="%" />
            <Slider label="Day Strain" value={dayStrain} onChange={setDayStrain} min={0} max={21} step={0.5} />
            <Slider label="Stress Score" value={stressScore} onChange={setStressScore} min={0} max={100} unit="%" />
          </div>

          {/* Right: Times */}
          <div style={{
            backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
            border: "1px solid #334155"
          }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
              Sleep Times
            </h2>
            <TimeSlider label="Previous Sleep Onset" value={prevSleepOnset} onChange={setPrevSleepOnset} />
            <TimeSlider label="Previous Wake Time" value={prevWakeTime} onChange={setPrevWakeTime} />
            <TimeSlider label="Recommended Sleep Onset" value={recSleepOnset} onChange={setRecSleepOnset} />
            <TimeSlider label="Recommended Wake Time" value={recWakeTime} onChange={setRecWakeTime} />

            <div style={{ marginTop: 12, padding: "12px 14px", backgroundColor: "#0f172a", borderRadius: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                <input
                  type="checkbox" checked={useCustomWake}
                  onChange={e => setUseCustomWake(e.target.checked)}
                  style={{ accentColor: "#6366f1" }}
                />
                <span style={{ color: "#a5b4fc", fontWeight: 500 }}>Override: I need to wake up at a specific time</span>
              </label>
              {useCustomWake && (
                <div style={{ marginTop: 10 }}>
                  <TimeSlider label="Custom Wake Time" value={customWakeTime} onChange={setCustomWakeTime} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Need Score */}
        <NeedIndicator score={summary.needScore} />

        {/* Key Recommendations */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16, marginBottom: 24
        }}>
          {[
            { icon: "🌡️", label: "Sleep Temp", value: `${summary.tempSleep}°F`, sub: `Deep sleep: ${summary.tempDeepSleep}°F` },
            { icon: "💡", label: "Wind-down", value: formatTime(summary.windDownStart), sub: `${MODEL.windDownMinutes + (summary.needScore > 60 ? 15 : 0)} min before bed` },
            { icon: "🪟", label: "Blinds Open", value: formatTime(summary.blindsStart), sub: `30 min gradual open` },
            { icon: "⏱️", label: "Sleep Duration", value: `${summary.recommendedSleepDuration.toFixed(1)} hrs`, sub: `${formatTime(summary.effectiveSleep)} → ${formatTime(summary.effectiveWake)}` },
          ].map((card, i) => (
            <div key={i} style={{
              backgroundColor: "#1e293b", borderRadius: 12, padding: "14px 16px",
              border: "1px solid #334155", textAlign: "center"
            }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{card.icon}</div>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{card.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc", marginTop: 2 }}>{card.value}</div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{card.sub}</div>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div style={{
          backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
          border: "1px solid #334155", marginBottom: 16
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
            Lighting & Blinds Timeline
          </h2>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="timeLabel" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "#e2e8f0" }}
              />
              <Area type="stepAfter" dataKey="light" stroke="#fbbf24" fill="#fbbf2420" name="Light %" strokeWidth={2} />
              <Area type="stepAfter" dataKey="blinds" stroke="#38bdf8" fill="#38bdf820" name="Blinds %" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={{
          backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
          border: "1px solid #334155", marginBottom: 16
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
            Temperature Timeline
          </h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="timeLabel" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
              <YAxis domain={[60, 75]} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "#e2e8f0" }}
                formatter={(value) => [`${value}°F`, "Temp"]}
              />
              <Line type="monotone" dataKey="temp" stroke="#f472b6" strokeWidth={2.5} dot={{ r: 3, fill: "#f472b6" }} name="Room Temp °F" />
              <ReferenceLine y={MODEL.baselineTemp} stroke="#475569" strokeDasharray="3 3" label={{ value: "Baseline", fill: "#475569", fontSize: 10 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Timeline Table */}
        <div style={{
          backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
          border: "1px solid #334155", marginBottom: 24
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>
            Full Automation Schedule
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #334155" }}>
                  {["Time", "Phase", "Lights", "Temp", "Blinds", "Action"].map(h => (
                    <th key={h} style={{
                      padding: "8px 10px", textAlign: "left", fontSize: 11,
                      color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chartData.map((row, i) => (
                  <tr key={i} style={{
                    borderBottom: "1px solid #1e293b",
                    backgroundColor: row.phase === "sleep" || row.phase === "deep-sleep" || row.phase === "rem-sleep" ? "#0f172a" : "transparent"
                  }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600, color: "#f8fafc", fontVariantNumeric: "tabular-nums" }}>
                      {row.timeLabel}
                    </td>
                    <td style={{ padding: "8px 10px" }}><PhaseBadge phase={row.phase} /></td>
                    <td style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{
                          width: 24, height: 8, borderRadius: 4,
                          backgroundColor: `rgba(251, 191, 36, ${row.light / 100})`,
                          border: "1px solid #334155"
                        }} />
                        <span style={{ color: row.light > 0 ? "#fbbf24" : "#475569" }}>{row.light}%</span>
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", color: row.temp <= summary.tempDeepSleep ? "#6366f1" : row.temp >= MODEL.baselineTemp ? "#f59e0b" : "#94a3b8" }}>
                      {row.temp}°F
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{
                          width: 24, height: 8, borderRadius: 4,
                          backgroundColor: `rgba(56, 189, 248, ${row.blinds / 100})`,
                          border: "1px solid #334155"
                        }} />
                        <span style={{ color: row.blinds > 0 ? "#38bdf8" : "#475569" }}>{row.blinds}%</span>
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", color: "#cbd5e1", fontSize: 12 }}>{row.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Model Insights */}
        <div style={{
          backgroundColor: "#1e293b", borderRadius: 14, padding: 20,
          border: "1px solid #334155", marginBottom: 24
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginTop: 0, marginBottom: 14, textTransform: "uppercase", letterSpacing: 1 }}>
            Model Insights (from your Whoop data)
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[
              { title: "Sleep Before 12:30 AM", stat: "72% avg recovery", detail: "vs 44% when sleeping after 2 AM. Earlier sleep onset is your strongest recovery lever." },
              { title: "7.5+ Hours Sleep", stat: "74-81% avg recovery", detail: "Under 5 hours drops to 21% recovery. Your body needs 9.4 hrs (Whoop baseline)." },
              { title: "90+ Min Deep Sleep", stat: "69% avg recovery", detail: "vs 19% with <60 min deep sleep. Cold room temps help maximize deep sleep." },
              { title: "Lower Skin Temp", stat: "57% recovery at <33.8°C", detail: "vs 52% at >34.3°C. Cooler rooms improve thermoregulation during sleep." },
              { title: "HRV > 75ms", stat: "72% avg recovery", detail: "Your avg HRV is 71.9ms. Consistent sleep timing and cool temps boost HRV." },
              { title: "Sleep Consistency 80%+", stat: "75% avg recovery", detail: "Your avg consistency is 58%. Same bed/wake times dramatically help." },
            ].map((insight, i) => (
              <div key={i} style={{
                padding: "12px 14px", backgroundColor: "#0f172a", borderRadius: 10,
                border: "1px solid #1e293b"
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", marginBottom: 2 }}>{insight.title}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#a5b4fc", marginBottom: 4 }}>{insight.stat}</div>
                <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>{insight.detail}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ textAlign: "center", padding: "12px 0 24px", color: "#475569", fontSize: 11 }}>
          Model built from {282} days of Whoop data (May 2025 – Apr 2026) · Baseline temp: 72°F · Wind-down: 60 min · Blind opening: 30 min
        </div>
      </div>
    </div>
  );
}
