// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ── Slider ↔ number input sync ────────────────────────────────────────────────
function bindSlider(numberId, sliderId) {
  const num = document.getElementById(numberId);
  const sl  = document.getElementById(sliderId);
  if (!num || !sl) return;
  sl.addEventListener("input", () => { num.value = sl.value; });
  num.addEventListener("input", () => { sl.value = num.value; });
}
[
  ["sim-dist","sim-dist-sl"], ["sim-speed","sim-speed-sl"], ["sim-angle","sim-angle-sl"],
  ["sim-rv","sim-rv-sl"],     ["sim-spin","sim-spin-sl"],
  ["tbl-hood","tbl-hood-sl"], ["tbl-mps","tbl-mps-sl"],   ["tbl-spin","tbl-spin-sl"],
  ["lkp-dist","lkp-dist-sl"], ["lkp-rv","lkp-rv-sl"],
].forEach(([n, s]) => bindSlider(n, s));

// ── Chart helpers ─────────────────────────────────────────────────────────────
const GRID_CLR  = "rgba(100,100,160,0.15)";
const TEXT_CLR  = "#8888bb";
const GOAL_DEPTH_M = 1.059; // hexagonal opening diameter = 41.7 in

function destroyChart(id) {
  const c = Chart.getChart(id); if (c) c.destroy();
}

function val(id) { return parseFloat(document.getElementById(id).value); }

function scaleBase() {
  return { grid: { color: GRID_CLR }, ticks: { color: TEXT_CLR } };
}

function axisTitle(text) {
  return { display: true, text, color: TEXT_CLR, font: { size: 11 } };
}

// ── Chart-tab switching ────────────────────────────────────────────────────────
function switchChartTab(name) {
  document.querySelectorAll(".chart-tab-btn[data-ctab]").forEach(b =>
    b.classList.toggle("active", b.dataset.ctab === name));
  document.querySelectorAll("#tab-simulate .chart-tab-content").forEach(c =>
    c.classList.toggle("active", c.id === "ctab-" + name));
}

function switchTableTab(name) {
  document.querySelectorAll("#tab-table .chart-tab-btn[data-ctab]").forEach(b =>
    b.classList.toggle("active", b.dataset.ctab === name));
  document.querySelectorAll("#tab-table .chart-tab-content").forEach(c =>
    c.classList.toggle("active", c.id === "ttab-" + name));
}

// ── Simulate tab ───────────────────────────────────────────────────────────────
async function runSimulate() {
  const payload = {
    distance: val("sim-dist"), speed: val("sim-speed"),
    angle: val("sim-angle"),   radial_vel: val("sim-rv"),
    spin: val("sim-spin"),
    drag:   document.getElementById("sim-drag").checked,
    magnus: document.getElementById("sim-magnus").checked,
  };

  const res  = await fetch("/api/simulate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  const box = document.getElementById("sim-result");
  box.className = "result-box " + (data.hit ? "hit" : "miss");
  box.innerHTML = `
    <strong>${data.hit ? "✓ HIT" : "✗ MISS"}</strong><br/>
    Y at goal: <strong>${data.y_final} m</strong><br/>
    Goal window: ${data.goal_low} – ${data.goal_high} m<br/>
    Time of flight: ${data.tof} s
  `;
  box.classList.remove("hidden");

  switchChartTab("trajectory");
  drawSingleTrajectory(data, payload.distance);
}

function drawSingleTrajectory(data, dist) {
  destroyChart("trajectoryChart");
  const ctx = document.getElementById("trajectoryChart").getContext("2d");

  const pts = data.trajectory_x.map((x, i) => ({ x, y: data.trajectory_y[i] }));
  const goalH = (data.goal_low + data.goal_high) / 2;
  const xMax  = dist + 0.8;

  new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        goalHeightLine(goalH, xMax),
        goalBar(dist, goalH),
        verticalDrop(dist, data.y_final),
        impactCircle(dist, data.y_final),
        {
          label: data.hit ? "Ball path (HIT ✓)" : "Ball path (MISS ✗)",
          data: pts,
          borderColor: data.hit ? "#4488ee" : "#ee6644",
          showLine: true, pointRadius: 0, borderWidth: 2.5, order: 1,
        },
      ],
    },
    options: trajectoryChartOptions(),
  });
}

async function runValidRegion() {
  const payload = {
    distance:    val("sim-dist"),
    radial_vel:  val("sim-rv"),
    spin:        val("sim-spin"),
    drag:        document.getElementById("sim-drag").checked,
    magnus:      document.getElementById("sim-magnus").checked,
  };

  // Fetch valid region data (boundary + optimal) and full fan trajectories in parallel
  const [regionRes, fanRes] = await Promise.all([
    fetch("/api/valid_region", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    fetch("/api/shot_fan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  ]);

  const region = await regionRes.json();
  const fan    = await fanRes.json();

  if (!region.count) {
    const box = document.getElementById("sim-result");
    box.className = "result-box miss";
    box.textContent = "No valid shots found at this distance / velocity.";
    box.classList.remove("hidden");
    return;
  }

  switchChartTab("trajectory");
  drawShotFan(fan);
  drawValidRegionFilled(region.shots, region.optimal);
}

// ── Shot fan (Image 1) ─────────────────────────────────────────────────────────
function drawShotFan(fan) {
  destroyChart("trajectoryChart");
  const ctx = document.getElementById("trajectoryChart").getContext("2d");

  const dist   = fan.distance;
  const goalH  = fan.goal_height;
  const goalLo = fan.goal_low;
  const goalHi = fan.goal_high;
  const xMax   = dist + 0.8;

  const datasets = fan.trajectories.map(s => {
    const t   = Math.max(0, Math.min(1, (s.y_final - goalLo) / (goalHi - goalLo)));
    const hue = Math.round(t * 120);
    return {
      data: s.tx.map((x, i) => ({ x, y: s.ty[i] })),
      borderColor: `hsla(${hue},80%,50%,0.32)`,
      showLine: true, pointRadius: 0, borderWidth: 1, order: 4,
    };
  });

  if (fan.optimal) {
    const o = fan.optimal;
    datasets.push({
      label: `Optimal  ${o.angle.toFixed(1)}° @ ${o.speed.toFixed(2)} m/s`,
      data: o.tx.map((x, i) => ({ x, y: o.ty[i] })),
      borderColor: "#4488ee", showLine: true, pointRadius: 0, borderWidth: 3, order: 1,
    });
    datasets.push(goalBar(dist, goalH));
    datasets.push(verticalDrop(dist, o.y_final));
    datasets.push(impactCircle(dist, o.y_final));
  }

  datasets.push(goalHeightLine(goalH, xMax));

  new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: trajectoryChartOptions(true),
  });
}

// ── Valid region filled (Image 2) ──────────────────────────────────────────────
// shots: [{ speed, angle, y_final }], optimal: { speed, angle }
function drawValidRegionFilled(shots, optimal) {
  if (!shots.length || !optimal) return;

  destroyChart("regionChart");
  const ctx = document.getElementById("regionChart").getContext("2d");

  const { lower, upper } = rimBoundaries(shots);
  const tol = shotTolerance(shots, optimal);

  new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          type: "line", label: "Close rim", data: lower,
          borderColor: "#e05667", backgroundColor: "rgba(50,170,80,0.18)",
          pointBackgroundColor: "#e05667", pointRadius: 4, pointHoverRadius: 6,
          fill: "+1", tension: 0.25, order: 4,
        },
        {
          type: "line", label: "Far rim", data: upper,
          borderColor: "#56e09e", backgroundColor: "transparent",
          pointBackgroundColor: "#56e09e", pointRadius: 4, pointHoverRadius: 6,
          fill: false, tension: 0.25, order: 4,
        },
        {
          type: "line",
          label: `Speed  ${(tol.speedMin - optimal.speed).toFixed(2)} / +${(tol.speedMax - optimal.speed).toFixed(2)} m/s`,
          data: [{ x: optimal.angle, y: tol.speedMin }, { x: optimal.angle, y: tol.speedMax }],
          borderColor: "#f5a623", pointBackgroundColor: "#f5a623",
          pointRadius: 5, borderWidth: 2.5, fill: false, order: 2,
        },
        {
          type: "line",
          label: `Angle  ${(tol.angleMin - optimal.angle).toFixed(1)}° / +${(tol.angleMax - optimal.angle).toFixed(1)}°`,
          data: [{ x: tol.angleMin, y: optimal.speed }, { x: tol.angleMax, y: optimal.speed }],
          borderColor: "#9b59b6", pointBackgroundColor: "#9b59b6",
          pointRadius: 5, borderWidth: 2.5, fill: false, order: 2,
        },
        {
          type: "scatter",
          label: `Optimal  ${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s`,
          data: [{ x: optimal.angle, y: optimal.speed }],
          backgroundColor: "white", borderColor: "#4488ee",
          pointRadius: 10, pointStyle: "star", borderWidth: 2, order: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true, animation: false,
      plugins: {
        legend: { labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14, padding: 10 } },
      },
      scales: {
        x: { ...scaleBase(), title: axisTitle("Launch Angle (°)") },
        y: { ...scaleBase(), title: axisTitle("Launch Speed (m/s)") },
      },
    },
  });

  const box = document.getElementById("sim-result");
  box.className = "result-box info";
  box.innerHTML = `
    <span style="color:#7b8cde;font-weight:700">Optimal: ${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s</span><br/>
    <span style="color:#f5a623">Speed: ${(tol.speedMin-optimal.speed).toFixed(2)}/+${(tol.speedMax-optimal.speed).toFixed(2)} m/s</span><br/>
    <span style="color:#9b59b6">Angle: ${(tol.angleMin-optimal.angle).toFixed(1)}°/+${(tol.angleMax-optimal.angle).toFixed(1)}°</span>
  `;
  box.classList.remove("hidden");
}

// ── Goal indicator dataset factories ─────────────────────────────────────────
function goalHeightLine(goalH, xMax) {
  return {
    label: "Goal height",
    data: [{ x: 0, y: goalH }, { x: xMax, y: goalH }],
    borderColor: "rgba(220,60,60,0.55)", borderDash: [9, 5],
    showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3,
  };
}
function goalBar(dist, goalH) {
  return {
    label: "Goal opening",
    data: [{ x: dist, y: goalH }, { x: dist + GOAL_DEPTH_M, y: goalH }],
    borderColor: "rgba(60,200,80,0.95)",
    showLine: true, pointRadius: 0, borderWidth: 5, order: 2,
  };
}
function verticalDrop(dist, yFinal) {
  return {
    data: [{ x: dist, y: 0 }, { x: dist, y: yFinal }],
    borderColor: "rgba(220,60,60,0.75)",
    showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3,
  };
}
function impactCircle(dist, yFinal) {
  return {
    label: "Impact",
    data: [{ x: dist, y: yFinal }],
    backgroundColor: "rgba(0,0,0,0)", borderColor: "white",
    pointRadius: 7, pointStyle: "circle", borderWidth: 2, showLine: false, order: 1,
  };
}
function trajectoryChartOptions(hideMostLabels = false) {
  return {
    responsive: true, maintainAspectRatio: true, animation: false,
    plugins: {
      legend: {
        labels: {
          color: TEXT_CLR, font: { size: 10 },
          filter: hideMostLabels ? (item => !!item.text) : undefined,
        },
      },
    },
    scales: {
      x: { ...scaleBase(), title: axisTitle("Distance (m)") },
      y: { ...scaleBase(), title: axisTitle("Height (m)"), min: 0 },
    },
  };
}

// ── Boundary / tolerance helpers (shared with docs/main.js) ───────────────────
function rimBoundaries(shots) {
  const map = new Map();
  for (const s of shots) {
    const k = s.angle.toFixed(2);
    if (!map.has(k)) map.set(k, { angle: s.angle, speeds: [] });
    map.get(k).speeds.push(s.speed);
  }
  const sorted = [...map.values()].sort((a, b) => a.angle - b.angle);
  return {
    lower: sorted.map(b => ({ x: b.angle, y: Math.min(...b.speeds) })),
    upper: sorted.map(b => ({ x: b.angle, y: Math.max(...b.speeds) })),
  };
}

function shotTolerance(shots, optimal) {
  const angles = [...new Set(shots.map(s => s.angle))].sort((a, b) => a - b);
  const speeds = [...new Set(shots.map(s => s.speed))].sort((a, b) => a - b);
  const aStep = angles.length > 1 ? (angles[angles.length-1] - angles[0]) / (angles.length-1) : 1;
  const sStep = speeds.length > 1 ? (speeds[speeds.length-1] - speeds[0]) / (speeds.length-1) : 0.5;

  const atAngle = shots.filter(s => Math.abs(s.angle - optimal.angle) <= aStep * 1.5);
  const atSpeed = shots.filter(s => Math.abs(s.speed - optimal.speed) <= sStep * 1.5);

  return {
    speedMin: atAngle.length ? Math.min(...atAngle.map(s => s.speed)) : optimal.speed,
    speedMax: atAngle.length ? Math.max(...atAngle.map(s => s.speed)) : optimal.speed,
    angleMin: atSpeed.length ? Math.min(...atSpeed.map(s => s.angle)) : optimal.angle,
    angleMax: atSpeed.length ? Math.max(...atSpeed.map(s => s.angle)) : optimal.angle,
  };
}

// ── Table tab ─────────────────────────────────────────────────────────────────
async function generateTable() {
  const payload = {
    dist_min:  val("tbl-dmin"), dist_max: val("tbl-dmax"),
    dist_steps: parseInt(document.getElementById("tbl-dsteps").value),
    rv_steps:   parseInt(document.getElementById("tbl-rvsteps").value),
    hood_angle_offset: val("tbl-hood"),
    mps_factor:        val("tbl-mps"),
    spin_rps:          val("tbl-spin"),
  };

  const bar    = document.getElementById("tbl-progress-bar");
  const label  = document.getElementById("tbl-progress-label");
  const status = document.getElementById("tbl-status");

  document.getElementById("tbl-progress-wrap").classList.remove("hidden");
  bar.style.width = "0%"; label.textContent = "0%";
  status.classList.add("hidden");

  const response = await fetch("/api/generate_table", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const msg = JSON.parse(line.slice(6));
      if (msg.progress !== undefined) {
        bar.style.width = msg.progress + "%";
        label.textContent = msg.progress + "%";
      }
      if (msg.done) {
        bar.style.width = "100%"; label.textContent = "100% — Done";
        await loadTableAndPlot();
        status.className = "result-box info";
        status.innerHTML = "Table generated. Polynomials fitted (degree 4).";
        status.classList.remove("hidden");
      }
    }
  }
}

async function loadTableAndPlot() {
  const res = await fetch("/api/table_data");
  const { entries } = await res.json();

  const dists = [...new Set(entries.map(e => e.distance))].sort((a,b)=>a-b);
  const rvs   = [...new Set(entries.map(e => e.radial_velocity))].sort((a,b)=>a-b);

  drawHeatmap("heatSpeedChart", entries, dists, rvs, "exit_speed",   "Exit Speed (m/s)",  "rgba(123,140,222,");
  drawHeatmap("heatAngleChart", entries, dists, rvs, "launch_angle", "Launch Angle (°)",  "rgba(86,204,242,");

  ["heatspeed-empty","heatangle-empty","polycurves-empty"].forEach(id =>
    document.getElementById(id)?.classList.add("hidden"));

  await loadPolyCurves("polyCurvesChart");
  await loadPolyCurves("lookupPolyChart");
}

function drawHeatmap(canvasId, entries, dists, rvs, field, yLabel, colorBase) {
  destroyChart(canvasId);
  const datasets = rvs.map((rv, i) => {
    const alpha = 0.4 + 0.6 * (i / Math.max(rvs.length - 1, 1));
    return {
      label: `rv=${rv >= 0 ? "+" : ""}${rv.toFixed(1)}`,
      data: dists.map(d => {
        const e = entries.find(x => Math.abs(x.distance - d) < 0.001 && Math.abs(x.radial_velocity - rv) < 0.001);
        return { x: d, y: e ? e[field] : null };
      }),
      borderColor: colorBase + alpha + ")",
      backgroundColor: "transparent",
      showLine: true, pointRadius: 3, borderWidth: 1.5, spanGaps: true,
    };
  });

  new Chart(document.getElementById(canvasId).getContext("2d"), {
    type: "scatter", data: { datasets },
    options: { responsive: true, maintainAspectRatio: true, animation: false,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 } } } },
      scales: {
        x: { ...scaleBase(), title: axisTitle("Distance (m)") },
        y: { ...scaleBase(), title: axisTitle(yLabel) },
      },
    },
  });
}

async function loadPolyCurves(canvasId) {
  const res = await fetch("/api/poly_curves");
  if (!res.ok) return;
  const { distances, curves } = await res.json();

  destroyChart(canvasId);
  const pal = { "-2.0": "#e05667", "0.0": "#56ccf2", "2.0": "#56e09e" };
  const lbl = { "-2.0": "rv=−2 m/s", "0.0": "rv=0 m/s", "2.0": "rv=+2 m/s" };

  const datasets = Object.entries(curves).flatMap(([rv, { speeds, angles }]) => [
    { label: lbl[rv] + " speed",
      data: distances.map((d, i) => ({ x: d, y: speeds[i] })),
      borderColor: pal[rv] || "#aaa", backgroundColor: "transparent",
      showLine: true, pointRadius: 0, borderWidth: 2, yAxisID: "ySpeed" },
    { label: lbl[rv] + " angle",
      data: distances.map((d, i) => ({ x: d, y: angles[i] })),
      borderColor: pal[rv] || "#aaa", borderDash: [5, 3],
      backgroundColor: "transparent",
      showLine: true, pointRadius: 0, borderWidth: 1.5, yAxisID: "yAngle" },
  ]);

  new Chart(document.getElementById(canvasId).getContext("2d"), {
    type: "scatter", data: { datasets },
    options: { responsive: true, maintainAspectRatio: true, animation: false,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14 } } },
      scales: {
        x:      { ...scaleBase(), title: axisTitle("Distance (m)") },
        ySpeed: { position: "left",  ...scaleBase(), title: axisTitle("Speed (m/s)") },
        yAngle: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: TEXT_CLR },
                  title: axisTitle("Angle (°)") },
      },
    },
  });
}

// ── Lookup tab ─────────────────────────────────────────────────────────────────
async function doLookup() {
  const payload = { distance: val("lkp-dist"), radial_vel: val("lkp-rv") };
  const res = await fetch("/api/lookup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const box = document.getElementById("lookup-result");

  if (!res.ok) {
    const err = await res.json();
    box.innerHTML = `<span style="color:#e05667">${err.error}</span>`;
    return;
  }

  const d = await res.json();
  box.innerHTML = `
    <span class="lbl">Distance:</span>        <span class="val">${payload.distance.toFixed(2)} m</span><br/>
    <span class="lbl">Radial Velocity:</span>  <span class="val">${payload.radial_vel >= 0 ? "+" : ""}${payload.radial_vel.toFixed(2)} m/s</span><br/>
    <br/>
    <span class="lbl">── Shot Command ───────────────</span><br/>
    <span class="lbl">Exit Speed:</span>       <span class="val">${d.exit_speed} m/s</span><br/>
    <span class="lbl">Launch Angle:</span>     <span class="val">${d.launch_angle}°</span><br/>
    <span class="lbl">Flywheel RPM:</span>     <span class="val">${d.flywheel_rpm} RPM</span><br/>
    <br/>
    <span class="lbl">── Tuning ─────────────────────</span><br/>
    <span class="lbl">Hood offset:</span>      <span class="val">${d.tuning.hood_angle_offset >= 0 ? "+" : ""}${d.tuning.hood_angle_offset}°</span><br/>
    <span class="lbl">MPS factor:</span>       <span class="val">${d.tuning.mps_factor}</span><br/>
    <span class="lbl">Spin rate:</span>        <span class="val">${d.tuning.spin_rps} rps</span>
  `;

  await loadPolyCurves("lookupPolyChart");
}
