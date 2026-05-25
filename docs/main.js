// FRC 2026 Shot Calculator — GitHub Pages (fully client-side)

// ── State ─────────────────────────────────────────────────────────────────────
let tableEntries = [];
let solver = null;
let tableGenerated = false;
let activeWorker = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const val = id => parseFloat($(id).value);
const intVal = id => parseInt($(id).value, 10);

const DARK_BG   = '#181826';
const GRID_CLR  = 'rgba(100,100,160,0.15)';
const TEXT_CLR  = '#8888bb';

const chartBase = {
  responsive: true, maintainAspectRatio: true,
  plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 11 } } } },
  scales: {
    x: { grid: { color: GRID_CLR }, ticks: { color: TEXT_CLR } },
    y: { grid: { color: GRID_CLR }, ticks: { color: TEXT_CLR } },
  },
};

function destroyChart(id) {
  const c = Chart.getChart(id); if (c) c.destroy();
}

function axisTitle(label) {
  return { display: true, text: label, color: TEXT_CLR, font: { size: 11 } };
}

// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Slider ↔ number sync ───────────────────────────────────────────────────────
function bindSlider(numId, slId) {
  const num = $(numId), sl = $(slId);
  if (!num || !sl) return;
  sl.addEventListener('input', () => { num.value = parseFloat(sl.value).toFixed(1); });
  num.addEventListener('input', () => { sl.value = num.value; });
}
[
  ['sim-dist','sim-dist-sl'], ['sim-speed','sim-speed-sl'], ['sim-angle','sim-angle-sl'],
  ['sim-rv','sim-rv-sl'],     ['sim-spin','sim-spin-sl'],
  ['tbl-hood','tbl-hood-sl'], ['tbl-mps','tbl-mps-sl'],   ['tbl-spin','tbl-spin-sl'],
  ['lkp-dist','lkp-dist-sl'], ['lkp-rv','lkp-rv-sl'],
].forEach(([n, s]) => bindSlider(n, s));

// ── Chart-tab switching (Simulate tab) ────────────────────────────────────────
function switchChartTab(name) {
  document.querySelectorAll('.chart-tab-btn[data-ctab]').forEach(b =>
    b.classList.toggle('active', b.dataset.ctab === name));
  document.querySelectorAll('#tab-simulate .chart-tab-content').forEach(c =>
    c.classList.toggle('active', c.id === 'ctab-' + name));
}

// ── Chart-tab switching (Table tab) ───────────────────────────────────────────
function switchTableTab(name) {
  document.querySelectorAll('#tab-table .chart-tab-btn[data-ttab]').forEach(b =>
    b.classList.toggle('active', b.dataset.ttab === name));
  document.querySelectorAll('#tab-table .chart-tab-content').forEach(c =>
    c.classList.toggle('active', c.id === 'ttab-' + name));
}

// ── Simulate tab ───────────────────────────────────────────────────────────────
window.runSimulate = function () {
  const result = PHYSICS.simulateShot({
    distance:       val('sim-dist'),
    exitSpeed:      val('sim-speed'),
    launchAngleDeg: val('sim-angle'),
    spinRps:        val('sim-spin'),
    robotRadialVel: val('sim-rv'),
    drag:           $('sim-drag').checked,
    magnus:         $('sim-magnus').checked,
    storeTrajectory: true,
  });

  const box = $('sim-result');
  box.className = 'result-box ' + (result.hit ? 'hit' : 'miss');
  box.innerHTML = `
    <strong>${result.hit ? '✓  HIT' : '✗  MISS'}</strong><br/>
    Y at goal: <strong>${result.yFinal.toFixed(3)} m</strong><br/>
    Goal window: ${PHYSICS.GOAL_LOW.toFixed(3)} – ${PHYSICS.GOAL_HIGH.toFixed(3)} m<br/>
    Time of flight: ${result.tof.toFixed(3)} s
  `;
  box.classList.remove('hidden');

  switchChartTab('trajectory');
  drawTrajectory(result);
};

function drawTrajectory(result) {
  destroyChart('trajectoryChart');
  const ctx = $('trajectoryChart').getContext('2d');
  const path = result.trajX.map((x, i) => ({ x, y: result.trajY[i] }));

  // Downsample to ≤400 points for rendering
  const step = Math.max(1, Math.floor(path.length / 400));
  const sampled = path.filter((_, i) => i % step === 0);

  const xMax = Math.max(...result.trajX);
  const gh   = PHYSICS.GOAL_HEIGHT;
  const gr   = PHYSICS.GOAL_RADIUS;

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Ball path', data: sampled,
          borderColor: '#7b8cde', showLine: true, pointRadius: 0, borderWidth: 2 },
        { label: result.hit ? 'Hit ✓' : 'Miss ✗',
          data: [{ x: sampled[sampled.length - 1].x, y: result.yFinal }],
          backgroundColor: result.hit ? '#56e09e' : '#e05667', pointRadius: 8 },
        { label: 'Goal centre', data: [{x:0,y:gh},{x:xMax,y:gh}],
          borderColor:'#f2d96a', borderDash:[6,3], showLine:true, pointRadius:0, borderWidth:1 },
        { label: 'Upper rim',   data: [{x:0,y:gh+gr},{x:xMax,y:gh+gr}],
          borderColor:'rgba(86,224,158,0.35)', borderDash:[4,4], showLine:true, pointRadius:0, borderWidth:1 },
        { label: 'Lower rim',   data: [{x:0,y:gh-gr},{x:xMax,y:gh-gr}],
          borderColor:'rgba(86,224,158,0.35)', borderDash:[4,4], showLine:true, pointRadius:0, borderWidth:1 },
      ],
    },
    options: {
      ...chartBase,
      scales: {
        x: { ...chartBase.scales.x, title: axisTitle('Distance (m)') },
        y: { ...chartBase.scales.y, title: axisTitle('Height (m)') },
      },
    },
  });
}

window.runValidRegion = function () {
  const valid = PHYSICS.findValidShots({
    distance:       val('sim-dist'),
    robotRadialVel: val('sim-rv'),
    spinRps:        val('sim-spin'),
    drag:   $('sim-drag').checked,
    magnus: $('sim-magnus').checked,
  });
  const optimal = PHYSICS.selectOptimalShot(valid);

  switchChartTab('region');
  drawRegion(valid, optimal);

  const speeds = valid.map(s => s.speed);
  const angles = valid.map(s => s.angle);
  const box = $('sim-result');
  box.className = 'result-box info';
  box.innerHTML = `
    Valid shots: <strong>${valid.length}</strong><br/>
    Optimal speed: <strong>${optimal ? optimal.speed.toFixed(2) + ' m/s' : '—'}</strong><br/>
    Optimal angle: <strong>${optimal ? optimal.angle.toFixed(1) + '°' : '—'}</strong><br/>
    Speed tolerance (σ): ${PHYSICS.std(speeds).toFixed(2)} m/s
    &nbsp;·&nbsp;
    Angle tolerance (σ): ${PHYSICS.std(angles).toFixed(1)}°
  `;
  box.classList.remove('hidden');
};

function drawRegion(valid, optimal) {
  destroyChart('regionChart');
  const ctx = $('regionChart').getContext('2d');

  const ys  = valid.map(s => s.yFinal);
  const min = Math.min(...ys), range = Math.max(...ys) - min + 1e-9;
  const colors = valid.map(s => {
    const t = (s.yFinal - min) / range;
    return `rgba(${Math.round(86 + t*138)},${Math.round(60 + t*98)},${Math.round(224 - t*138)},0.75)`;
  });

  new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [
        { label: 'Valid shots',
          data: valid.map(s => ({ x: s.speed, y: s.angle, r: 4 })),
          backgroundColor: colors, borderWidth: 0 },
        { label: 'Optimal ★',
          data: optimal ? [{ x: optimal.speed, y: optimal.angle, r: 9 }] : [],
          backgroundColor: '#f2d96a', borderColor: '#fff', borderWidth: 1.5 },
      ],
    },
    options: {
      ...chartBase,
      scales: {
        x: { ...chartBase.scales.x, title: axisTitle('Exit Speed (m/s)') },
        y: { ...chartBase.scales.y, title: axisTitle('Launch Angle (°)') },
      },
    },
  });
}

// ── Table tab ──────────────────────────────────────────────────────────────────
window.generateTable = function () {
  // Cancel any running worker
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }

  const cfg = {
    distMin: val('tbl-dmin'),   distMax: val('tbl-dmax'),
    distSteps: intVal('tbl-dsteps'), rvSteps: intVal('tbl-rvsteps'),
    hoodAngleOffset: val('tbl-hood'),
    mpsFactor: val('tbl-mps'),
    spinRps: val('tbl-spin'),
    drag:   $('tbl-drag').checked,
    magnus: $('tbl-magnus').checked,
  };

  const bar   = $('tbl-progress-bar');
  const label = $('tbl-progress-label');
  const status = $('tbl-status');

  $('tbl-progress-wrap').classList.remove('hidden');
  bar.style.width = '0%'; label.textContent = '0%';
  status.classList.add('hidden');
  $('tbl-generate-btn').disabled = true;

  activeWorker = new Worker('worker.js');
  activeWorker.postMessage({ type: 'generate', config: cfg });

  activeWorker.onmessage = e => {
    if (e.data.type === 'progress') {
      bar.style.width = e.data.pct + '%';
      label.textContent = e.data.pct + '%';
    } else if (e.data.type === 'done') {
      bar.style.width = '100%'; label.textContent = '100% — Done';
      tableEntries = e.data.table;

      solver = new SHOT_TABLE.ShotPolynomialSolver(4);
      solver.fit(tableEntries);
      tableGenerated = true;
      activeWorker = null;
      $('tbl-generate-btn').disabled = false;

      const validCount = tableEntries.filter(e => e.validCount > 0).length;
      status.className = 'result-box info';
      status.innerHTML = `${tableEntries.length} entries · ${validCount} with valid shots · Polynomials fitted (degree 4)`;
      status.classList.remove('hidden');

      drawTableCharts();
      drawPolyCurves('polyCurvesChart');
      drawPolyCurves('lookupPolyChart');
    }
  };

  activeWorker.onerror = err => {
    status.className = 'result-box miss';
    status.textContent = 'Worker error: ' + err.message;
    status.classList.remove('hidden');
    $('tbl-generate-btn').disabled = false;
  };
};

function drawTableCharts() {
  const valid = tableEntries.filter(e => e.validCount > 0);
  if (!valid.length) return;

  const dists = [...new Set(valid.map(e => +e.distance.toFixed(4)))].sort((a,b)=>a-b);
  const rvs   = [...new Set(valid.map(e => +e.radialVelocity.toFixed(4)))].sort((a,b)=>a-b);

  const palette = makeColorRamp(rvs.length, 'rgba(123,140,222,');
  drawLineMap('heatSpeedChart', dists, rvs, valid, 'exitSpeed',    'Exit Speed (m/s)',  palette);
  drawLineMap('heatAngleChart', dists, rvs, valid, 'launchAngle',  'Launch Angle (°)',  palette);
  drawTolMap ('heatTolChart',   dists, rvs, valid);

  ['heatspeed-empty','heatangle-empty','heattol-empty','polycurves-empty'].forEach(id =>
    $(id)?.classList.add('hidden'));
}

function makeColorRamp(n, base) {
  return Array.from({ length: n }, (_, i) =>
    base + (0.4 + 0.6 * i / Math.max(n - 1, 1)) + ')');
}

function drawLineMap(canvasId, dists, rvs, entries, field, yLabel, palette) {
  destroyChart(canvasId);
  const datasets = rvs.map((rv, i) => ({
    label: `rv ${rv >= 0 ? '+' : ''}${rv.toFixed(1)}`,
    data: dists.map(d => {
      const e = entries.find(x =>
        Math.abs(x.distance - d) < 0.001 && Math.abs(x.radialVelocity - rv) < 0.001);
      return { x: d, y: e ? e[field] : null };
    }),
    borderColor: palette[i], backgroundColor: 'transparent',
    showLine: true, pointRadius: 3, borderWidth: 1.5, spanGaps: true,
  }));

  new Chart($(canvasId).getContext('2d'), {
    type: 'scatter', data: { datasets },
    options: { ...chartBase,
      scales: {
        x: { ...chartBase.scales.x, title: axisTitle('Distance (m)') },
        y: { ...chartBase.scales.y, title: axisTitle(yLabel) },
      },
    },
  });
}

function drawTolMap(canvasId, dists, rvs, entries) {
  // Show speed tolerance (σ) as size, one dataset per rv
  destroyChart(canvasId);
  const palette = makeColorRamp(rvs.length, 'rgba(86,204,242,');
  const datasets = rvs.map((rv, i) => ({
    label: `rv ${rv >= 0 ? '+' : ''}${rv.toFixed(1)}`,
    data: dists.map(d => {
      const e = entries.find(x =>
        Math.abs(x.distance - d) < 0.001 && Math.abs(x.radialVelocity - rv) < 0.001);
      return e ? { x: d, y: e.toleranceSpeed } : null;
    }).filter(Boolean),
    borderColor: palette[i], backgroundColor: 'transparent',
    showLine: true, pointRadius: 3, borderWidth: 1.5,
  }));

  new Chart($(canvasId).getContext('2d'), {
    type: 'scatter', data: { datasets },
    options: { ...chartBase,
      scales: {
        x: { ...chartBase.scales.x, title: axisTitle('Distance (m)') },
        y: { ...chartBase.scales.y, title: axisTitle('Speed Tolerance σ (m/s)') },
      },
    },
  });
}

function drawPolyCurves(canvasId) {
  if (!tableGenerated) return;
  const valid = tableEntries.filter(e => e.validCount > 0);
  if (!valid.length) return;

  const distMin = Math.min(...valid.map(e => e.distance));
  const distMax = Math.max(...valid.map(e => e.distance));
  const { distances, curves } = solver.sampleCurves(distMin, distMax, 80);

  destroyChart(canvasId);
  const pal = { '-2': '#e05667', '0': '#56ccf2', '2': '#56e09e' };
  const lbl = { '-2': 'rv=−2 m/s', '0': 'rv=0 m/s', '2': 'rv=+2 m/s' };

  const datasets = Object.entries(curves).flatMap(([rv, { speeds, angles }]) => [
    { label: lbl[rv] + ' speed',
      data: distances.map((d, i) => ({ x: +d.toFixed(3), y: speeds[i] })),
      borderColor: pal[rv], showLine: true, pointRadius: 0, borderWidth: 2,
      yAxisID: 'ySpeed' },
    { label: lbl[rv] + ' angle',
      data: distances.map((d, i) => ({ x: +d.toFixed(3), y: angles[i] })),
      borderColor: pal[rv], borderDash: [5, 3], showLine: true, pointRadius: 0,
      borderWidth: 1.5, yAxisID: 'yAngle' },
  ]);

  new Chart($(canvasId).getContext('2d'), {
    type: 'scatter', data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14 } } },
      scales: {
        x:      { grid:{color:GRID_CLR}, ticks:{color:TEXT_CLR}, title: axisTitle('Distance (m)') },
        ySpeed: { position:'left',  grid:{color:GRID_CLR}, ticks:{color:TEXT_CLR}, title: axisTitle('Speed (m/s)') },
        yAngle: { position:'right', grid:{drawOnChartArea:false}, ticks:{color:TEXT_CLR}, title: axisTitle('Angle (°)') },
      },
    },
  });
}

// ── Export / Import ────────────────────────────────────────────────────────────
window.exportTable = function () {
  if (!tableGenerated) return;
  const json = JSON.stringify({ table: tableEntries }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shot_table.json';
  a.click();
};

window.importTable = function () {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        tableEntries = data.table || data;
        solver = new SHOT_TABLE.ShotPolynomialSolver(4);
        solver.fit(tableEntries);
        tableGenerated = true;
        drawTableCharts();
        drawPolyCurves('polyCurvesChart');
        drawPolyCurves('lookupPolyChart');
        const status = $('tbl-status');
        status.className = 'result-box info';
        status.textContent = `Loaded ${tableEntries.length} entries from file.`;
        status.classList.remove('hidden');
      } catch (err) {
        alert('Failed to parse table file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
};

// ── Live Lookup tab ────────────────────────────────────────────────────────────
window.doLookup = function () {
  const box = $('lookup-result');
  if (!tableGenerated) {
    box.innerHTML = '<span style="color:#e05667">No table loaded. Generate or import one first.</span>';
    return;
  }

  const dist = val('lkp-dist');
  const rv   = val('lkp-rv');
  const result = solver.predict(dist, rv);
  if (!result) {
    box.innerHTML = '<span style="color:#e05667">No polynomial data at this distance.</span>';
    return;
  }

  const mpsFactor = val('tbl-mps');
  const rpm = solver.speedToRpm(result.exitSpeed, mpsFactor);

  box.innerHTML = `
    <span class="lbl">Distance:</span>        <span class="val">${dist.toFixed(2)} m</span><br/>
    <span class="lbl">Radial Velocity:</span>  <span class="val">${rv >= 0 ? '+' : ''}${rv.toFixed(2)} m/s</span><br/>
    <br/>
    <span class="lbl">── Shot Command ───────────────</span><br/>
    <span class="lbl">Exit Speed:</span>       <span class="val">${result.exitSpeed.toFixed(3)} m/s</span><br/>
    <span class="lbl">Launch Angle:</span>     <span class="val">${result.launchAngle.toFixed(2)}°</span><br/>
    <span class="lbl">Flywheel RPM:</span>     <span class="val">${Math.round(rpm)} RPM</span><br/>
    <br/>
    <span class="lbl">── Active Tuning ──────────────</span><br/>
    <span class="lbl">Hood offset:</span>      <span class="val">${val('tbl-hood') >= 0 ? '+' : ''}${val('tbl-hood').toFixed(1)}°</span><br/>
    <span class="lbl">MPS factor:</span>       <span class="val">${mpsFactor.toFixed(3)}</span><br/>
    <span class="lbl">Spin rate:</span>        <span class="val">${val('tbl-spin').toFixed(0)} rps</span>
  `;

  drawPolyCurves('lookupPolyChart');
};
