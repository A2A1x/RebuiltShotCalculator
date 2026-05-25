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

const GRID_CLR = 'rgba(100,100,160,0.15)';
const TEXT_CLR = '#8888bb';

function destroyChart(id) {
  const c = Chart.getChart(id); if (c) c.destroy();
}

function axisTitle(label) {
  return { display: true, text: label, color: TEXT_CLR, font: { size: 11 } };
}

const scaleBase = () => ({
  grid: { color: GRID_CLR }, ticks: { color: TEXT_CLR },
});

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
  ['sim-dist','sim-dist-sl'],
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

// Sweep range used by the Simulate tab (Shot Table generation uses its own
// broader defaults so it can find shots across all distances).
const SIM_SWEEP = {
  speedRange: [7.5, 15.0],
  angleRange: [35.0, 75.0],
};

// ── Simulate tab ───────────────────────────────────────────────────────────────
// Sweeps the valid region for the given distance / radial velocity, picks the
// most error-tolerant shot, and draws its trajectory.
window.runSimulate = function () {
  const dist   = val('sim-dist');
  const params = {
    distance:       dist,
    robotRadialVel: val('sim-rv'),
    spinRps:        val('sim-spin'),
    drag:           $('sim-drag').checked,
    magnus:         $('sim-magnus').checked,
  };

  const box = $('sim-result');
  const valid   = PHYSICS.findValidShots({ ...params, ...SIM_SWEEP });
  const optimal = PHYSICS.selectOptimalShot(valid);

  if (!optimal) {
    box.className = 'result-box miss';
    box.textContent = 'No valid shots found at this distance / radial velocity.';
    box.classList.remove('hidden');
    return;
  }

  const result = PHYSICS.simulateShot({
    ...params,
    exitSpeed:       optimal.speed,
    launchAngleDeg:  optimal.angle,
    storeTrajectory: true,
  });

  const goalR = PHYSICS.GOAL_RADIUS;
  box.className = 'result-box ' + (result.hit ? 'hit' : 'miss');
  box.innerHTML = `
    <strong>${result.hit ? '✓  HIT (optimal)' : '✗  MISS'}</strong><br/>
    Exit speed: <strong>${optimal.speed.toFixed(2)} m/s</strong><br/>
    Launch angle: <strong>${optimal.angle.toFixed(2)}°</strong><br/>
    Entry x: ${result.xFinal.toFixed(3)} m (goal ${(dist - goalR).toFixed(2)} – ${(dist + goalR).toFixed(2)} m)<br/>
    Time of flight: ${result.tof.toFixed(3)} s · valid shots in region: ${valid.length}
  `;
  box.classList.remove('hidden');

  switchChartTab('trajectory');
  drawSingleTrajectory(result, dist);
};

/**
 * Draw a single ball trajectory (called by Simulate Shot).
 * Shows goal indicator: dashed height line, vertical drop, circle, goal bar.
 */
function drawSingleTrajectory(result, dist) {
  destroyChart('trajectoryChart');
  const ctx = $('trajectoryChart').getContext('2d');

  const step = Math.max(1, Math.floor(result.trajX.length / 300));
  const pts = [];
  for (let i = 0; i < result.trajX.length; i += step) {
    pts.push({ x: result.trajX[i], y: result.trajY[i] });
  }

  const rimH    = PHYSICS.RIM_HEIGHT;
  const wallTop = PHYSICS.WALL_TOP;
  const goalR   = PHYSICS.GOAL_RADIUS;
  const xMax    = dist + goalR + 0.6;

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        rimHeightLine(rimH, xMax),
        goalRimBar(dist, rimH, goalR),
        nearRimLine(dist, rimH, goalR),
        farRimLine(dist, rimH, goalR),
        ...rimWalls(dist, rimH, wallTop, goalR),
        verticalDrop(result.xFinal, result.yFinal),
        impactCircle(result.xFinal, result.yFinal),
        {
          label: result.hit ? 'Ball path (HIT ✓)' : 'Ball path (MISS ✗)',
          data: pts,
          borderColor: result.hit ? '#4488ee' : '#ee6644',
          showLine: true, pointRadius: 0, borderWidth: 2.5, order: 1,
        },
      ],
    },
    options: trajectoryChartOptions(),
  });
}

window.runValidRegion = function () {
  const params = {
    distance:       val('sim-dist'),
    robotRadialVel: val('sim-rv'),
    spinRps:        val('sim-spin'),
    drag:           $('sim-drag').checked,
    magnus:         $('sim-magnus').checked,
  };

  const valid   = PHYSICS.findValidShots({ ...params, ...SIM_SWEEP });
  const optimal = PHYSICS.selectOptimalShot(valid);

  if (!valid.length) {
    const box = $('sim-result');
    box.className = 'result-box miss';
    box.textContent = 'No valid shots found at this distance / velocity.';
    box.classList.remove('hidden');
    return;
  }

  // Shot fan goes in the Trajectory tab; filled region in Valid Region tab
  switchChartTab('trajectory');
  drawShotFan(valid, optimal, params);
  drawValidRegionFilled(valid, optimal);
};

// ── Shot fan (Image 1) ─────────────────────────────────────────────────────────
/**
 * Draw ALL valid trajectories colored by landing position in goal window.
 * Red = close rim, green = far rim. Optimal highlighted in blue.
 */
function drawShotFan(valid, optimal, params) {
  destroyChart('trajectoryChart');
  const ctx = $('trajectoryChart').getContext('2d');

  const dist    = params.distance;
  const rimH    = PHYSICS.RIM_HEIGHT;
  const wallTop = PHYSICS.WALL_TOP;
  const goalR   = PHYSICS.GOAL_RADIUS;
  const xMax    = dist + goalR + 0.6;

  // Simulate every valid shot trajectory
  const simulated = valid.map(s => {
    const r = PHYSICS.simulateShot({
      distance: dist, exitSpeed: s.speed, launchAngleDeg: s.angle,
      spinRps: params.spinRps, robotRadialVel: params.robotRadialVel,
      drag: params.drag, magnus: params.magnus, storeTrajectory: true,
    });
    return { ...s, traj: r };
  });

  // Optimal trajectory
  const optSim = optimal ? PHYSICS.simulateShot({
    distance: dist, exitSpeed: optimal.speed, launchAngleDeg: optimal.angle,
    spinRps: params.spinRps, robotRadialVel: params.robotRadialVel,
    drag: params.drag, magnus: params.magnus, storeTrajectory: true,
  }) : null;

  // Color by x position within opening: near rim = red (0°), far rim = green (120°)
  const datasets = simulated.map(s => {
    const t = Math.max(0, Math.min(1, (s.traj.xFinal - (dist - goalR)) / (2 * goalR)));
    const hue = Math.round(t * 120);
    const color = `hsla(${hue}, 80%, 50%, 0.32)`;

    const step = Math.max(1, Math.floor(s.traj.trajX.length / 55));
    const pts = [];
    for (let i = 0; i < s.traj.trajX.length; i += step) {
      pts.push({ x: s.traj.trajX[i], y: s.traj.trajY[i] });
    }
    return { data: pts, borderColor: color, showLine: true, pointRadius: 0, borderWidth: 1, order: 4 };
  });

  // Optimal (blue, thick, on top)
  if (optSim) {
    const step = Math.max(1, Math.floor(optSim.trajX.length / 120));
    const pts = [];
    for (let i = 0; i < optSim.trajX.length; i += step) {
      pts.push({ x: optSim.trajX[i], y: optSim.trajY[i] });
    }
    datasets.push({
      label: `Optimal  ${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s`,
      data: pts,
      borderColor: '#4488ee', showLine: true, pointRadius: 0, borderWidth: 3, order: 1,
    });
  }

  // Goal indicators: horizontal rim bar + walls + impact marker
  datasets.push(rimHeightLine(rimH, xMax));
  datasets.push(goalRimBar(dist, rimH, goalR));
  datasets.push(nearRimLine(dist, rimH, goalR));
  datasets.push(farRimLine(dist, rimH, goalR));
  datasets.push(...rimWalls(dist, rimH, wallTop, goalR));
  if (optSim) {
    datasets.push(verticalDrop(optSim.xFinal, optSim.yFinal));
    datasets.push(impactCircle(optSim.xFinal, optSim.yFinal));
  }

  new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: trajectoryChartOptions(true),
  });
}

// ── Valid region filled (Image 2) ──────────────────────────────────────────────
/**
 * Show the valid shot region as a filled band bounded by close-rim (red)
 * and far-rim (green) curves, with tolerance crosshairs at the optimal shot.
 */
function drawValidRegionFilled(valid, optimal) {
  if (!valid.length || !optimal) return;

  destroyChart('regionChart');
  const ctx = $('regionChart').getContext('2d');

  const { lower, upper } = rimBoundaries(valid);
  const tol = shotTolerance(valid, optimal);

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        // Lower boundary fills toward upper
        {
          type: 'line',
          label: 'Close rim',
          data: lower,
          borderColor: '#e05667',
          backgroundColor: 'rgba(50,170,80,0.18)',
          pointBackgroundColor: '#e05667',
          pointRadius: 4, pointHoverRadius: 6,
          fill: '+1', tension: 0.25, order: 4,
        },
        // Upper boundary
        {
          type: 'line',
          label: 'Far rim',
          data: upper,
          borderColor: '#56e09e',
          backgroundColor: 'transparent',
          pointBackgroundColor: '#56e09e',
          pointRadius: 4, pointHoverRadius: 6,
          fill: false, tension: 0.25, order: 4,
        },
        // Speed tolerance — vertical orange segment at optimal angle
        {
          type: 'line',
          label: `Speed  ${(tol.speedMin - optimal.speed).toFixed(2)} / +${(tol.speedMax - optimal.speed).toFixed(2)} m/s`,
          data: [{ x: optimal.angle, y: tol.speedMin }, { x: optimal.angle, y: tol.speedMax }],
          borderColor: '#f5a623',
          pointBackgroundColor: '#f5a623',
          pointRadius: 5, borderWidth: 2.5,
          fill: false, order: 2,
        },
        // Angle tolerance — horizontal purple segment at optimal speed
        {
          type: 'line',
          label: `Angle  ${(tol.angleMin - optimal.angle).toFixed(1)}° / +${(tol.angleMax - optimal.angle).toFixed(1)}°`,
          data: [{ x: tol.angleMin, y: optimal.speed }, { x: tol.angleMax, y: optimal.speed }],
          borderColor: '#9b59b6',
          pointBackgroundColor: '#9b59b6',
          pointRadius: 5, borderWidth: 2.5,
          fill: false, order: 2,
        },
        // Optimal star
        {
          type: 'scatter',
          label: `Optimal  ${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s`,
          data: [{ x: optimal.angle, y: optimal.speed }],
          backgroundColor: 'white',
          borderColor: '#4488ee',
          pointRadius: 10, pointStyle: 'star', borderWidth: 2, order: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true, animation: false,
      plugins: {
        legend: {
          labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14, padding: 10 },
        },
      },
      scales: {
        x: { ...scaleBase(), title: axisTitle('Launch Angle (°)') },
        y: { ...scaleBase(), title: axisTitle('Launch Speed (m/s)') },
      },
    },
  });

  // Stats in result box (matches reference image layout)
  $('sim-result').className = 'result-box info';
  $('sim-result').innerHTML = `
    <span style="color:#7b8cde;font-weight:700">Optimal: ${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s</span><br/>
    <span style="color:#f5a623">Speed: ${(tol.speedMin-optimal.speed).toFixed(2)}/+${(tol.speedMax-optimal.speed).toFixed(2)} m/s</span><br/>
    <span style="color:#9b59b6">Angle: ${(tol.angleMin-optimal.angle).toFixed(1)}°/+${(tol.angleMax-optimal.angle).toFixed(1)}°</span>
  `;
  $('sim-result').classList.remove('hidden');
}

// ── Goal indicator dataset factories (top-loading opening) ────────────────────

function rimHeightLine(rimH, xMax) {
  return {
    label: 'Rim height',
    data: [{ x: 0, y: rimH }, { x: xMax, y: rimH }],
    borderColor: 'rgba(220,60,60,0.30)', borderDash: [9, 5],
    showLine: true, pointRadius: 0, borderWidth: 1, order: 5,
  };
}

function goalRimBar(dist, rimH, goalR) {
  return {
    label: 'Goal opening',
    data: [{ x: dist - goalR, y: rimH }, { x: dist + goalR, y: rimH }],
    borderColor: 'rgba(60,200,80,0.95)',
    showLine: true, pointRadius: 0, borderWidth: 6, order: 2,
  };
}

function nearRimLine(dist, rimH, goalR) {
  return {
    data: [{ x: dist - goalR, y: 0 }, { x: dist - goalR, y: rimH }],
    borderColor: 'rgba(60,200,80,0.40)',
    showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3,
  };
}

function farRimLine(dist, rimH, goalR) {
  return {
    data: [{ x: dist + goalR, y: 0 }, { x: dist + goalR, y: rimH }],
    borderColor: 'rgba(60,200,80,0.40)',
    showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3,
  };
}

// 8-inch walls above each rim edge — both red = miss
function rimWalls(dist, rimH, wallTop, goalR) {
  return [
    {
      label: 'Front wall (miss)',
      data: [{ x: dist - goalR, y: rimH }, { x: dist - goalR, y: wallTop }],
      borderColor: 'rgba(220,60,60,0.90)',
      showLine: true, pointRadius: 0, borderWidth: 5, order: 2,
    },
    {
      label: 'Back wall (miss)',
      data: [{ x: dist + goalR, y: rimH }, { x: dist + goalR, y: wallTop }],
      borderColor: 'rgba(220,60,60,0.90)',
      showLine: true, pointRadius: 0, borderWidth: 5, order: 2,
    },
  ];
}

function verticalDrop(xFinal, rimH) {
  return {
    data: [{ x: xFinal, y: 0 }, { x: xFinal, y: rimH }],
    borderColor: 'rgba(220,60,60,0.75)',
    showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3,
  };
}

function impactCircle(xFinal, rimH) {
  return {
    label: 'Impact',
    data: [{ x: xFinal, y: rimH }],
    backgroundColor: 'rgba(0,0,0,0)', borderColor: 'white',
    pointRadius: 7, pointStyle: 'circle', borderWidth: 2, showLine: false, order: 1,
  };
}

function trajectoryChartOptions(hideLegend = false) {
  return {
    responsive: true, maintainAspectRatio: true, animation: false,
    plugins: {
      legend: hideLegend
        ? { labels: { color: TEXT_CLR, font: { size: 10 },
            filter: item => !!item.text } }
        : { labels: { color: TEXT_CLR, font: { size: 10 } } },
    },
    scales: {
      x: { ...scaleBase(), title: axisTitle('Distance (m)') },
      y: { ...scaleBase(), title: axisTitle('Height (m)'), min: 0 },
    },
  };
}

// ── Boundary / tolerance helpers ───────────────────────────────────────────────

/** For each unique angle in valid shots, find min and max speed (close/far rim). */
function rimBoundaries(valid) {
  const map = new Map();
  for (const s of valid) {
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

/** Speed range at optimal angle, angle range at optimal speed. */
function shotTolerance(valid, optimal) {
  const angles = [...new Set(valid.map(s => s.angle))].sort((a, b) => a - b);
  const speeds = [...new Set(valid.map(s => s.speed))].sort((a, b) => a - b);
  const aStep = angles.length > 1 ? (angles[angles.length-1] - angles[0]) / (angles.length-1) : 1;
  const sStep = speeds.length > 1 ? (speeds[speeds.length-1] - speeds[0]) / (speeds.length-1) : 0.5;

  const atAngle = valid.filter(s => Math.abs(s.angle - optimal.angle) <= aStep * 1.5);
  const atSpeed = valid.filter(s => Math.abs(s.speed - optimal.speed) <= sStep * 1.5);

  return {
    speedMin: atAngle.length ? Math.min(...atAngle.map(s => s.speed)) : optimal.speed,
    speedMax: atAngle.length ? Math.max(...atAngle.map(s => s.speed)) : optimal.speed,
    angleMin: atSpeed.length ? Math.min(...atSpeed.map(s => s.angle)) : optimal.angle,
    angleMax: atSpeed.length ? Math.max(...atSpeed.map(s => s.angle)) : optimal.angle,
  };
}

// ── Table tab ──────────────────────────────────────────────────────────────────
window.generateTable = function () {
  if (activeWorker) {
    if (typeof activeWorker.terminate === 'function') activeWorker.terminate();
    else if (typeof activeWorker.cancel === 'function') activeWorker.cancel();
    activeWorker = null;
  }

  const cfg = {
    distMin: val('tbl-dmin'),   distMax: val('tbl-dmax'),
    distSteps: intVal('tbl-dsteps'), rvSteps: intVal('tbl-rvsteps'),
    hoodAngleOffset: val('tbl-hood'),
    mpsFactor: val('tbl-mps'),
    spinRps: val('tbl-spin'),
    drag:   $('tbl-drag').checked,
    magnus: $('tbl-magnus').checked,
  };

  const bar    = $('tbl-progress-bar');
  const label  = $('tbl-progress-label');
  const status = $('tbl-status');

  $('tbl-progress-wrap').classList.remove('hidden');
  bar.style.width = '0%'; label.textContent = '0%';
  status.classList.add('hidden');
  $('tbl-generate-btn').disabled = true;

  const onProgress = pct => {
    bar.style.width = pct + '%';
    label.textContent = pct + '%';
  };
  const onDone = table => {
    bar.style.width = '100%'; label.textContent = '100% — Done';
    tableEntries = table;
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
  };
  const onError = (msg, cellsDone) => {
    status.className = 'result-box miss';
    status.textContent = `Generation failed after ${cellsDone ?? 0} cells: ${msg}`;
    status.classList.remove('hidden');
    activeWorker = null;
    $('tbl-generate-btn').disabled = false;
  };

  // Try Web Worker; if unavailable (e.g. file:// origin), fall back to inline.
  let worker = null;
  try { worker = new Worker('worker.js'); } catch (_) {}

  if (worker) {
    activeWorker = worker;
    worker.postMessage({ type: 'generate', config: cfg });
    worker.onmessage = e => {
      if (e.data.type === 'progress') onProgress(e.data.pct);
      else if (e.data.type === 'error') {
        worker.terminate();
        onError(e.data.message, e.data.cellsDone);
        console.error('worker error', e.data);
      } else if (e.data.type === 'done') onDone(e.data.table);
    };
    worker.onerror = err => {
      const msg = err.message || err.filename || 'unknown (check console)';
      onError(`${msg} @ ${err.filename || '?'}:${err.lineno || '?'}`);
      console.error('worker onerror', err);
    };
  } else {
    // Inline fallback: same logic, run on main thread with periodic yields.
    activeWorker = runTableInline(cfg, onProgress, onDone,
      (err) => onError((err && err.message) || String(err)));
  }
};

// Inline shot-table generator — used when Web Workers are unavailable
// (notably file:// origin in Chrome). Yields every ~50ms so the UI stays
// responsive. Returns an object with .cancel() that aborts the run.
function runTableInline(cfg, onProgress, onDone, onError) {
  const linspace = (lo, hi, n) =>
    Array.from({ length: n }, (_, i) => lo + i * (hi - lo) / (n - 1));
  const distances  = linspace(cfg.distMin, cfg.distMax, cfg.distSteps);
  const radialVels = linspace(-3.0, 3.0, cfg.rvSteps);
  const total = distances.length * radialVels.length;
  const table = [];
  let i = 0, j = 0, done = 0, cancelled = false;

  onProgress(0);

  function tick() {
    if (cancelled) return;
    const t0 = performance.now();
    try {
      while (i < distances.length) {
        while (j < radialVels.length) {
          const dist = distances[i], rv = radialVels[j];
          const valid = PHYSICS.findValidShots({
            distance: dist, robotRadialVel: rv, spinRps: cfg.spinRps,
            drag: cfg.drag, magnus: cfg.magnus,
            speedSteps: 45, angleSteps: 45,
          });
          const optimal = PHYSICS.selectOptimalShot(valid);
          let entry;
          if (optimal) {
            const speeds = valid.map(s => s.speed);
            const angles = valid.map(s => s.angle);
            entry = {
              distance: dist, radialVelocity: rv,
              exitSpeed:   optimal.speed * cfg.mpsFactor,
              launchAngle: optimal.angle + cfg.hoodAngleOffset,
              toleranceSpeed: PHYSICS.std(speeds),
              toleranceAngle: PHYSICS.std(angles),
              validCount: valid.length,
            };
          } else {
            entry = {
              distance: dist, radialVelocity: rv,
              exitSpeed: 0, launchAngle: 0,
              toleranceSpeed: 0, toleranceAngle: 0, validCount: 0,
            };
          }
          table.push(entry);
          done++; j++;
          if (performance.now() - t0 > 50) {
            onProgress(Math.round(100 * done / total));
            setTimeout(tick, 0);
            return;
          }
        }
        j = 0; i++;
      }
      onProgress(100);
      onDone(table);
    } catch (err) {
      console.error('inline generation error', err);
      onError(err);
    }
  }

  setTimeout(tick, 0);
  return { cancel: () => { cancelled = true; } };
}

function drawTableCharts() {
  const valid = tableEntries.filter(e => e.validCount > 0);
  if (!valid.length) return;

  const dists = [...new Set(valid.map(e => +e.distance.toFixed(4)))].sort((a,b)=>a-b);
  const rvs   = [...new Set(valid.map(e => +e.radialVelocity.toFixed(4)))].sort((a,b)=>a-b);

  const palette = makeColorRamp(rvs.length, 'rgba(123,140,222,');
  drawLineMap('heatSpeedChart', dists, rvs, valid, 'exitSpeed',   'Exit Speed (m/s)', palette);
  drawLineMap('heatAngleChart', dists, rvs, valid, 'launchAngle', 'Launch Angle (°)', palette);
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
    options: { responsive: true, maintainAspectRatio: true, animation: false,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 } } } },
      scales: {
        x: { ...scaleBase(), title: axisTitle('Distance (m)') },
        y: { ...scaleBase(), title: axisTitle(yLabel) },
      },
    },
  });
}

function drawTolMap(canvasId, dists, rvs, entries) {
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
    options: { responsive: true, maintainAspectRatio: true, animation: false,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 } } } },
      scales: {
        x: { ...scaleBase(), title: axisTitle('Distance (m)') },
        y: { ...scaleBase(), title: axisTitle('Speed Tolerance σ (m/s)') },
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
      borderColor: pal[rv], showLine: true, pointRadius: 0, borderWidth: 2, yAxisID: 'ySpeed' },
    { label: lbl[rv] + ' angle',
      data: distances.map((d, i) => ({ x: +d.toFixed(3), y: angles[i] })),
      borderColor: pal[rv], borderDash: [5, 3], showLine: true, pointRadius: 0,
      borderWidth: 1.5, yAxisID: 'yAngle' },
  ]);

  new Chart($(canvasId).getContext('2d'), {
    type: 'scatter', data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: true, animation: false,
      plugins: { legend: { labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14 } } },
      scales: {
        x:      { ...scaleBase(), title: axisTitle('Distance (m)') },
        ySpeed: { position:'left',  ...scaleBase(), title: axisTitle('Speed (m/s)') },
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
