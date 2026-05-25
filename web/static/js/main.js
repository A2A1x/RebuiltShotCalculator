// ── Tab navigation ────────────────────────────────────────────────────────────

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
  const sl = document.getElementById(sliderId);
  if (!num || !sl) return;
  sl.addEventListener("input", () => { num.value = sl.value; });
  num.addEventListener("input", () => { sl.value = num.value; });
}

[
  ["sim-dist","sim-dist-sl"], ["sim-speed","sim-speed-sl"], ["sim-angle","sim-angle-sl"],
  ["sim-rv","sim-rv-sl"], ["sim-spin","sim-spin-sl"],
  ["tbl-hood","tbl-hood-sl"], ["tbl-mps","tbl-mps-sl"], ["tbl-spin","tbl-spin-sl"],
  ["lkp-dist","lkp-dist-sl"], ["lkp-rv","lkp-rv-sl"],
].forEach(([n, s]) => bindSlider(n, s));

// ── Chart helpers ─────────────────────────────────────────────────────────────

const DARK_BG = "#181826";
const GRID_COLOR = "rgba(100,100,160,0.15)";
const TEXT_COLOR = "#8888bb";

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: true,
  plugins: { legend: { labels: { color: TEXT_COLOR, font: { size: 11 } } } },
  scales: {
    x: { grid: { color: GRID_COLOR }, ticks: { color: TEXT_COLOR } },
    y: { grid: { color: GRID_COLOR }, ticks: { color: TEXT_COLOR } },
  },
};

function destroyChart(id) {
  const existing = Chart.getChart(id);
  if (existing) existing.destroy();
}

function val(id) { return parseFloat(document.getElementById(id).value); }

// ── Simulate tab ──────────────────────────────────────────────────────────────

function switchChartTab(name) {
  document.querySelectorAll(".chart-tab-btn[data-ctab]").forEach(b => {
    b.classList.toggle("active", b.dataset.ctab === name);
  });
  document.querySelectorAll("#tab-simulate .chart-tab-content").forEach(c => {
    c.classList.toggle("active", c.id === "ctab-" + name);
  });
}

async function runSimulate() {
  const payload = {
    distance: val("sim-dist"), speed: val("sim-speed"),
    angle: val("sim-angle"), radial_vel: val("sim-rv"),
    spin: val("sim-spin"),
    drag: document.getElementById("sim-drag").checked,
    magnus: document.getElementById("sim-magnus").checked,
  };

  const res = await fetch("/api/simulate", {
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
  drawTrajectory(data, payload);
}

function drawTrajectory(data, params) {
  destroyChart("trajectoryChart");
  const ctx = document.getElementById("trajectoryChart").getContext("2d");

  const pathData = data.trajectory_x.map((x, i) => ({ x, y: data.trajectory_y[i] }));

  new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Ball path",
          data: pathData,
          borderColor: "#7b8cde",
          backgroundColor: "transparent",
          showLine: true,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: data.hit ? "Hit ✓" : "Miss ✗",
          data: [{ x: params.distance, y: data.y_final }],
          backgroundColor: data.hit ? "#56e09e" : "#e05667",
          pointRadius: 7,
          pointStyle: "circle",
        },
      ],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        annotation: {},
      },
      scales: {
        x: { ...chartDefaults.scales.x, title: { display: true, text: "Distance (m)", color: TEXT_COLOR } },
        y: { ...chartDefaults.scales.y, title: { display: true, text: "Height (m)", color: TEXT_COLOR } },
      },
    },
  });

  // Draw goal lines via afterDraw plugin is complex; draw as datasets instead
  const goalLo = data.goal_low;
  const goalHi = data.goal_high;
  const xMax = Math.max(...data.trajectory_x);
  const existing = Chart.getChart("trajectoryChart");
  existing.data.datasets.push(
    { label: "Goal window", data: [{x:0,y:(goalLo+goalHi)/2},{x:xMax,y:(goalLo+goalHi)/2}],
      borderColor:"#f2d96a", borderDash:[6,3], showLine:true, pointRadius:0, borderWidth:1 },
    { label: "Upper rim", data: [{x:0,y:goalHi},{x:xMax,y:goalHi}],
      borderColor:"rgba(86,224,158,0.4)", borderDash:[4,4], showLine:true, pointRadius:0, borderWidth:1 },
    { label: "Lower rim", data: [{x:0,y:goalLo},{x:xMax,y:goalLo}],
      borderColor:"rgba(86,224,158,0.4)", borderDash:[4,4], showLine:true, pointRadius:0, borderWidth:1 },
  );
  existing.update();
}

async function runValidRegion() {
  const payload = {
    distance: val("sim-dist"),
    radial_vel: val("sim-rv"),
    spin: val("sim-spin"),
  };

  const res = await fetch("/api/valid_region", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  switchChartTab("region");

  destroyChart("regionChart");
  const ctx = document.getElementById("regionChart").getContext("2d");

  const points = data.shots.map(s => ({ x: s.speed, y: s.angle, r: 4 }));
  const optPoint = data.optimal ? [{ x: data.optimal.speed, y: data.optimal.angle, r: 9 }] : [];

  // Color by y_final (normalized)
  const ys = data.shots.map(s => s.y_final);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const colors = data.shots.map(s => {
    const t = (s.y_final - yMin) / (yMax - yMin + 1e-9);
    const r = Math.round(86 + t * (224 - 86));
    const g = Math.round(60 + t * (158 - 60));
    const b = Math.round(224 - t * (224 - 86));
    return `rgba(${r},${g},${b},0.75)`;
  });

  new Chart(ctx, {
    type: "bubble",
    data: {
      datasets: [
        { label: "Valid shots", data: points, backgroundColor: colors, borderWidth: 0 },
        { label: "Optimal ★", data: optPoint, backgroundColor: "#f2d96a", borderColor: "#fff", borderWidth: 1.5 },
      ],
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, title: { display: true, text: "Exit Speed (m/s)", color: TEXT_COLOR } },
        y: { ...chartDefaults.scales.y, title: { display: true, text: "Launch Angle (°)", color: TEXT_COLOR } },
      },
    },
  });

  const box = document.getElementById("sim-result");
  box.className = "result-box info";
  box.innerHTML = `
    Valid shots: <strong>${data.count}</strong><br/>
    Optimal speed: <strong>${data.optimal?.speed ?? "—"} m/s</strong><br/>
    Optimal angle: <strong>${data.optimal?.angle ?? "—"}°</strong><br/>
    Speed tolerance (σ): ${data.speed_std} m/s &nbsp; Angle tolerance (σ): ${data.angle_std}°
  `;
  box.classList.remove("hidden");
}

// ── Table tab ─────────────────────────────────────────────────────────────────

function switchTableTab(name) {
  document.querySelectorAll(".chart-tab-btn[data-ctab]").forEach(b => {
    b.classList.toggle("active", b.dataset.ctab === name);
  });
  document.querySelectorAll("#tab-table .chart-tab-content").forEach(c => {
    c.classList.toggle("active", c.id === "ttab-" + name);
  });
}

async function generateTable() {
  const payload = {
    dist_min: val("tbl-dmin"), dist_max: val("tbl-dmax"),
    dist_steps: parseInt(document.getElementById("tbl-dsteps").value),
    rv_steps: parseInt(document.getElementById("tbl-rvsteps").value),
    hood_angle_offset: val("tbl-hood"),
    mps_factor: val("tbl-mps"),
    spin_rps: val("tbl-spin"),
  };

  const wrap = document.getElementById("tbl-progress-wrap");
  const bar = document.getElementById("tbl-progress-bar");
  const label = document.getElementById("tbl-progress-label");
  const status = document.getElementById("tbl-status");

  wrap.classList.remove("hidden");
  bar.style.width = "0%";
  label.textContent = "0%";
  status.classList.add("hidden");

  const evtSrc = new EventSource("/api/generate_table?" + new URLSearchParams(payload));

  // EventSource is GET-only; use fetch + ReadableStream for POST SSE
  evtSrc.close();

  const response = await fetch("/api/generate_table", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const reader = response.body.getReader();
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
        bar.style.width = "100%";
        label.textContent = "100% — Done";
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
  const rvs = [...new Set(entries.map(e => e.radial_velocity))].sort((a,b)=>a-b);

  drawHeatmap("heatSpeedChart", "heatspeed-empty", entries, dists, rvs, "exit_speed", "Exit Speed (m/s)", "rgba(123,140,222,");
  drawHeatmap("heatAngleChart", "heatangle-empty", entries, dists, rvs, "launch_angle", "Launch Angle (°)", "rgba(86,204,242,");

  // Hide "empty" messages
  document.getElementById("heatspeed-empty").classList.add("hidden");
  document.getElementById("heatangle-empty").classList.add("hidden");
  document.getElementById("polycurves-empty").classList.add("hidden");

  await loadPolyCurves("polyCurvesChart");
  await loadPolyCurves("lookupPolyChart");
}

function drawHeatmap(canvasId, emptyId, entries, dists, rvs, field, label, colorBase) {
  destroyChart(canvasId);

  // Build one dataset per rv level
  const datasets = rvs.map((rv, i) => {
    const pts = dists.map(d => {
      const e = entries.find(x => Math.abs(x.distance - d) < 0.001 && Math.abs(x.radial_velocity - rv) < 0.001);
      return { x: d, y: e ? e[field] : 0 };
    });
    const alpha = 0.5 + 0.5 * (i / Math.max(rvs.length - 1, 1));
    return {
      label: `rv=${rv > 0 ? "+" : ""}${rv.toFixed(1)}`,
      data: pts,
      borderColor: colorBase + alpha + ")",
      backgroundColor: "transparent",
      showLine: true,
      pointRadius: 3,
      borderWidth: 1.5,
    };
  });

  const ctx = document.getElementById(canvasId).getContext("2d");
  new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, title: { display: true, text: "Distance (m)", color: TEXT_COLOR } },
        y: { ...chartDefaults.scales.y, title: { display: true, text: label, color: TEXT_COLOR } },
      },
    },
  });
}

async function loadPolyCurves(canvasId) {
  const res = await fetch("/api/poly_curves");
  if (!res.ok) return;
  const { distances, curves } = await res.json();

  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId).getContext("2d");

  const palette = { "-2.0": "#e05667", "0.0": "#56ccf2", "2.0": "#56e09e" };
  const rvLabels = { "-2.0": "rv=−2 m/s", "0.0": "rv=0 m/s", "2.0": "rv=+2 m/s" };

  const datasets = Object.entries(curves).flatMap(([rv, { speeds, angles }]) => [
    {
      label: rvLabels[rv] + " speed",
      data: distances.map((d, i) => ({ x: d, y: speeds[i] })),
      borderColor: palette[rv] || "#aaa",
      backgroundColor: "transparent",
      showLine: true, pointRadius: 0, borderWidth: 2,
      yAxisID: "ySpeed",
    },
    {
      label: rvLabels[rv] + " angle",
      data: distances.map((d, i) => ({ x: d, y: angles[i] })),
      borderColor: palette[rv] || "#aaa",
      borderDash: [5, 3],
      backgroundColor: "transparent",
      showLine: true, pointRadius: 0, borderWidth: 1.5,
      yAxisID: "yAngle",
    },
  ]);

  new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: TEXT_COLOR, font: { size: 10 }, boxWidth: 14 } } },
      scales: {
        x: { grid: { color: GRID_COLOR }, ticks: { color: TEXT_COLOR },
             title: { display: true, text: "Distance (m)", color: TEXT_COLOR } },
        ySpeed: { position: "left", grid: { color: GRID_COLOR }, ticks: { color: TEXT_COLOR },
                  title: { display: true, text: "Speed (m/s)", color: TEXT_COLOR } },
        yAngle: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: TEXT_COLOR },
                  title: { display: true, text: "Angle (°)", color: TEXT_COLOR } },
      },
    },
  });
}

// ── Lookup tab ────────────────────────────────────────────────────────────────

async function doLookup() {
  const payload = {
    distance: val("lkp-dist"),
    radial_vel: val("lkp-rv"),
  };

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
    <span class="lbl">Distance:</span> <span class="val">${payload.distance.toFixed(2)} m</span><br/>
    <span class="lbl">Radial Velocity:</span> <span class="val">${payload.radial_vel >= 0 ? "+" : ""}${payload.radial_vel.toFixed(2)} m/s</span><br/>
    <br/>
    <span class="lbl">── Shot Command ──────────────</span><br/>
    <span class="lbl">Exit Speed:</span> <span class="val">${d.exit_speed} m/s</span><br/>
    <span class="lbl">Launch Angle:</span> <span class="val">${d.launch_angle}°</span><br/>
    <span class="lbl">Flywheel RPM:</span> <span class="val">${d.flywheel_rpm} RPM</span><br/>
    <br/>
    <span class="lbl">── Tuning ────────────────────</span><br/>
    <span class="lbl">Hood offset:</span> <span class="val">${d.tuning.hood_angle_offset >= 0 ? "+" : ""}${d.tuning.hood_angle_offset}°</span><br/>
    <span class="lbl">MPS factor:</span> <span class="val">${d.tuning.mps_factor}</span><br/>
    <span class="lbl">Spin rate:</span> <span class="val">${d.tuning.spin_rps} rps</span>
  `;

  await loadPolyCurves("lookupPolyChart");
}
