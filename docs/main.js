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

function zoomPluginOptions() {
  return {
    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy' },
    pan:  { enabled: true, mode: 'xy' },
  };
}

// Double-click any chart canvas to reset its zoom.
document.addEventListener('dblclick', e => {
  const canvas = e.target.closest('canvas');
  if (!canvas) return;
  const chart = Chart.getChart(canvas);
  if (chart && chart.resetZoom) chart.resetZoom();
});

// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'surface') {
      const div = $('polySurfacePlot');
      if (tableGenerated) {
        // If Plotly already rendered (e.g. during table gen while tab was hidden),
        // just resize to the now-visible container. Otherwise do a full draw.
        if (div && div._fullLayout) Plotly.Plots.resize(div);
        else drawPolySurface();
      }
    }
    if (btn.dataset.tab === 'overview') {
      const div = $('overviewSurfacePlot');
      if (tableGenerated) {
        if (div && div._fullLayout) Plotly.Plots.resize(div);
        else drawOverviewSurface();
      }
    }
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
  ['sim-rv','sim-rv-sl'],     ['sim-lateral','sim-lateral-sl'], ['sim-spin','sim-spin-sl'],
  ['sim-ceiling','sim-ceiling-sl'],
  ['tbl-hood','tbl-hood-sl'], ['tbl-mps','tbl-mps-sl'],   ['tbl-spin','tbl-spin-sl'],
  ['tbl-ceiling','tbl-ceiling-sl'],
  ['lkp-dist','lkp-dist-sl'], ['lkp-rv','lkp-rv-sl'],     ['lkp-lateral','lkp-lateral-sl'],
  ['ov-spin','ov-spin-sl'], ['ov-ceiling','ov-ceiling-sl'],
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

// Sweep range used by the Simulate tab — full physics envelope so every
// shot that scores is reported. (Shot Table generation passes its own
// settings and is unaffected.)
const SIM_SWEEP = {
  speedRange: [5.0, 20.0],
  angleRange: [10.0, 85.0],
  speedSteps: 150,
  angleSteps: 150,
};

// ── Simulate tab ───────────────────────────────────────────────────────────────
// Sweeps the valid region for the given distance / radial velocity, picks the
// most error-tolerant shot, and draws its trajectory.
window.runSimulate = function () {
  const dist       = val('sim-dist');
  const lateralVel = val('sim-lateral');
  const params = {
    distance:       dist,
    robotRadialVel: val('sim-rv'),
    spinRps:        val('sim-spin'),
    drag:           $('sim-drag').checked,
    magnus:         $('sim-magnus').checked,
    ceilingHeight:  $('sim-ceiling-on').checked ? val('sim-ceiling') : null,
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

  // Virtual-target section (shown whenever robot is moving)
  if (params.robotRadialVel !== 0 || lateralVel !== 0) {
    const vt = PHYSICS.computeVirtualTarget({
      distance: dist, radialVel: params.robotRadialVel, lateralVel,
      spinRps: params.spinRps, drag: params.drag, magnus: params.magnus,
      ceilingHeight: params.ceilingHeight,
    });
    const yawDir = vt.yawOffsetDeg < -0.05 ? ' (aim right)' :
                   vt.yawOffsetDeg >  0.05 ? ' (aim left)'  : '';
    box.innerHTML += `
      <hr style="border-color:rgba(120,130,200,0.25);margin:7px 0"/>
      <span style="color:#7b8cde;font-size:11px;font-weight:700">&#9654; SHOOT-ON-MOVE (1690 virtual target)</span><br/>
      Virtual target dist: <strong>${vt.virtualDist.toFixed(2)} m</strong>
        <span style="color:#888;font-size:11px">(actual ${dist.toFixed(2)} m)</span><br/>
      Yaw offset: <strong>${vt.yawOffsetDeg >= 0 ? '+' : ''}${vt.yawOffsetDeg.toFixed(1)}°</strong>${yawDir}
    `;
  }

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
    ceilingHeight:  $('sim-ceiling-on').checked ? val('sim-ceiling') : null,
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
        zoom: zoomPluginOptions(),
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
      zoom: zoomPluginOptions(),
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

/** Speed range at optimal angle, angle range at optimal speed.
 *  Derived directly from rimBoundaries so the crosshair endpoints align
 *  exactly with the rim curves on the chart. */
function shotTolerance(valid, optimal) {
  const { lower, upper } = rimBoundaries(valid);
  if (!lower.length) {
    return { speedMin: optimal.speed, speedMax: optimal.speed,
             angleMin: optimal.angle, angleMax: optimal.angle };
  }

  // Speed range: rim bounds at the angle closest to optimal
  const nearIdx = lower.reduce((bi, _, i) =>
    Math.abs(lower[i].x - optimal.angle) < Math.abs(lower[bi].x - optimal.angle) ? i : bi, 0);
  const speedMin = lower[nearIdx].y;
  const speedMax = upper[nearIdx].y;

  // Angle range: every rim data point where optimal.speed is inside [close_rim, far_rim]
  const rimStep = lower.length > 1
    ? (lower[lower.length - 1].x - lower[0].x) / (lower.length - 1) : 1;
  const validAngles = lower
    .filter((lo, i) => optimal.speed >= lo.y && optimal.speed <= upper[i].y)
    .map(lo => lo.x);

  if (!validAngles.length) {
    return { speedMin, speedMax, angleMin: optimal.angle, angleMax: optimal.angle };
  }

  // Keep only the contiguous segment that contains optimal.angle
  const thresh = rimStep * 1.5;
  const ci = validAngles.reduce((bi, a, i) =>
    Math.abs(a - optimal.angle) < Math.abs(validAngles[bi] - optimal.angle) ? i : bi, 0);
  let lo = ci, hi = ci;
  while (lo > 0 && validAngles[lo] - validAngles[lo - 1] < thresh) lo--;
  while (hi < validAngles.length - 1 && validAngles[hi + 1] - validAngles[hi] < thresh) hi++;

  return { speedMin, speedMax, angleMin: validAngles[lo], angleMax: validAngles[hi] };
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
    ceilingHeight: $('tbl-ceiling-on').checked ? val('tbl-ceiling') : null,
  };

  const bar    = $('tbl-progress-bar');
  const label  = $('tbl-progress-label');
  const status = $('tbl-status');

  $('tbl-progress-wrap').classList.remove('hidden');
  bar.style.width = '0%'; label.textContent = '0%';
  status.classList.add('hidden');
  $('tbl-generate-btn').disabled = true;
  if ($('ov-generate-btn')) $('ov-generate-btn').disabled = true;
  if ($('ov-progress-wrap')) $('ov-progress-wrap').classList.remove('hidden');
  if ($('ov-progress-bar'))  { $('ov-progress-bar').style.width = '0%'; }
  if ($('ov-progress-label')) $('ov-progress-label').textContent = '0%';
  if ($('ov-status')) $('ov-status').classList.add('hidden');

  const onProgress = pct => {
    bar.style.width = pct + '%';
    label.textContent = pct + '%';
    if ($('ov-progress-bar'))  $('ov-progress-bar').style.width  = pct + '%';
    if ($('ov-progress-label')) $('ov-progress-label').textContent = pct + '%';
  };
  const onDone = table => {
    bar.style.width = '100%'; label.textContent = '100% — Done';
    tableEntries = table;
    solver = new SHOT_TABLE.ShotPolynomialSolver(3);
    solver.fit(tableEntries);
    tableGenerated = true;
    activeWorker = null;
    $('tbl-generate-btn').disabled = false;
    if ($('ov-generate-btn')) $('ov-generate-btn').disabled = false;
    if ($('ov-progress-bar'))  $('ov-progress-bar').style.width = '100%';
    if ($('ov-progress-label')) $('ov-progress-label').textContent = '100% — Done';
    const validCount = tableEntries.filter(e => e.validCount > 0).length;
    if ($('ov-status')) {
      $('ov-status').className = 'result-box info';
      $('ov-status').innerHTML = `${tableEntries.length} entries · ${validCount} with valid shots · degree 3`;
      $('ov-status').classList.remove('hidden');
    }
    status.className = 'result-box info';
    status.innerHTML = `${tableEntries.length} entries · ${validCount} with valid shots · 2D surface fitted (degree 3)`;
    status.classList.remove('hidden');
    drawTableCharts();
    drawPolyCurves('polyCurvesChart');
    drawPolyCurves('lookupPolyChart');
    renderPolyCoeffs();
    drawPolySurface();
    drawOverviewSurface();
  };
  const onError = (msg, cellsDone) => {
    status.className = 'result-box miss';
    status.textContent = `Generation failed after ${cellsDone ?? 0} cells: ${msg}`;
    status.classList.remove('hidden');
    activeWorker = null;
    $('tbl-generate-btn').disabled = false;
    if ($('ov-generate-btn')) $('ov-generate-btn').disabled = false;
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
            ceilingHeight: cfg.ceilingHeight,
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
      plugins: {
        legend: { labels: { color: TEXT_CLR, font: { size: 10 } } },
        zoom: zoomPluginOptions(),
      },
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
      plugins: {
        legend: { labels: { color: TEXT_CLR, font: { size: 10 } } },
        zoom: zoomPluginOptions(),
      },
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
      plugins: {
        legend: { labels: { color: TEXT_CLR, font: { size: 10 }, boxWidth: 14 } },
        zoom: zoomPluginOptions(),
      },
      scales: {
        x:      { ...scaleBase(), title: axisTitle('Distance (m)') },
        ySpeed: { position:'left',  ...scaleBase(), title: axisTitle('Speed (m/s)') },
        yAngle: { position:'right', grid:{drawOnChartArea:false}, ticks:{color:TEXT_CLR}, title: axisTitle('Angle (°)') },
      },
    },
  });
}

// ── Polynomial coefficient helpers ────────────────────────────────────────────

/** Human-readable label for a 2D monomial [d_exp, v_exp]. */
function termLabel(a, b) {
  const dPart = a === 0 ? '' : a === 1 ? 'd' : `d${a === 2 ? '²' : a === 3 ? '³' : '^' + a}`;
  const vPart = b === 0 ? '' : b === 1 ? 'v' : `v${b === 2 ? '²' : b === 3 ? '³' : '^' + b}`;
  if (!dPart && !vPart) return '1';
  if (!dPart) return vPart;
  if (!vPart) return dPart;
  return `${dPart}·${vPart}`;
}

/** Render the 2D polynomial coefficient table into #poly-coeffs-display. */
function renderPolyCoeffs() {
  const display = $('poly-coeffs-display');
  if (!display || !tableGenerated) return;

  const c = solver.getCoefficients();
  if (!c.terms.length) {
    display.innerHTML = '<p class="chart-empty">Not enough data to fit polynomials.</p>';
    return;
  }

  const rows = c.terms.map(([a, b], i) => `
    <tr>
      <td class="poly-term">${termLabel(a, b)}</td>
      <td>[${a},${b}]</td>
      <td class="poly-expr">${c.speedCoeffs[i] >= 0 ? '+' : ''}${c.speedCoeffs[i].toExponential(5)}</td>
      <td class="poly-expr">${c.angleCoeffs[i] >= 0 ? '+' : ''}${c.angleCoeffs[i].toExponential(5)}</td>
    </tr>`).join('');

  display.innerHTML = `
    <div class="coeffs-toolbar">
      <span style="font-size:11px;color:var(--text-muted)">
        Single degree-${c.degree} surface · d = distance (m) · v = radial velocity (m/s)
        · f(d,v) = Σ coeff·dᵃ·vᵇ
      </span>
    </div>
    <div style="overflow-x:auto">
      <table class="poly-coeff-table">
        <thead>
          <tr>
            <th>Term</th>
            <th>[a, b]</th>
            <th>Speed coeff (m/s)</th>
            <th>Angle coeff (°)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Export / Import ────────────────────────────────────────────────────────────
window.exportTable = function () {
  if (!tableGenerated) return;
  const json = JSON.stringify({
    table:       tableEntries,
    polynomials: solver.getCoefficients(),
  }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shot_table.json';
  a.click();
};

window.exportPolynomials = function () {
  if (!tableGenerated) return;
  const json = JSON.stringify(solver.getCoefficients(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shot_polynomials.json';
  a.click();
};

window.copyPolynomials = function (btnEl) {
  if (!tableGenerated) return;
  const json = JSON.stringify(solver.getCoefficients(), null, 2);
  navigator.clipboard.writeText(json).then(() => {
    const btn = btnEl || $('tbl-copy-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }).catch(() => window.prompt('Copy polynomial JSON:', json));
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
        solver = new SHOT_TABLE.ShotPolynomialSolver(3);
        solver.fit(tableEntries);
        tableGenerated = true;
        drawTableCharts();
        drawPolyCurves('polyCurvesChart');
        drawPolyCurves('lookupPolyChart');
        renderPolyCoeffs();
        drawPolySurface();
        drawOverviewSurface();
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

  const dist       = val('lkp-dist');
  const rv         = val('lkp-rv');
  const lateralVel = val('lkp-lateral');
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
    <span class="lbl">Lateral Velocity:</span> <span class="val">${lateralVel >= 0 ? '+' : ''}${lateralVel.toFixed(2)} m/s</span><br/>
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

  // Virtual-target correction (1690-style) — shown whenever robot is moving
  if (rv !== 0 || lateralVel !== 0) {
    const spinRps      = val('tbl-spin');
    const drag         = $('tbl-drag').checked;
    const magnus       = $('tbl-magnus').checked;
    const ceilingHeight = $('tbl-ceiling-on').checked ? val('tbl-ceiling') : null;
    const vt = PHYSICS.computeVirtualTarget({
      distance: dist, radialVel: rv, lateralVel,
      spinRps, drag, magnus, ceilingHeight,
    });
    const yawDir = vt.yawOffsetDeg < -0.05 ? ' (aim right)' :
                   vt.yawOffsetDeg >  0.05 ? ' (aim left)'  : '';
    // Re-query table at virtual distance for the corrected shot command
    const vtResult = solver.predict(vt.virtualDist, 0);
    const vtHtml = vtResult ? `
      <span class="lbl">Virtual speed:</span>    <span class="val">${vtResult.exitSpeed.toFixed(3)} m/s</span><br/>
      <span class="lbl">Virtual angle:</span>    <span class="val">${vtResult.launchAngle.toFixed(2)}°</span><br/>` : '';
    box.innerHTML += `
      <br/>
      <span class="lbl" style="color:#7b8cde">── Shoot-on-Move (1690) ───────</span><br/>
      <span class="lbl">Virtual dist:</span>     <span class="val">${vt.virtualDist.toFixed(2)} m</span><br/>
      <span class="lbl">Yaw offset:</span>       <span class="val">${vt.yawOffsetDeg >= 0 ? '+' : ''}${vt.yawOffsetDeg.toFixed(1)}°${yawDir}</span><br/>
      ${vtHtml}
    `;
  }

  drawPolyCurves('lookupPolyChart');
};

// ── Poly Surface tab (Plotly 3D) ───────────────────────────────────────────────

let polySurfaceMode = 'speed';
let ovSurfaceMode   = 'speed';

window.setPolySurfaceMode = function (mode) {
  polySurfaceMode = mode;
  document.querySelectorAll('.surface-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  if (tableGenerated) drawPolySurface();
};

window.setOvSurfaceMode = function (mode) {
  ovSurfaceMode = mode;
  document.querySelectorAll('.ov-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  if (tableGenerated) drawOverviewSurface();
};

/** Shared Plotly 3D surface renderer. */
function _drawPlotlySurface(divId, emptyId, mode, showPts) {
  const div   = $(divId);
  const empty = $(emptyId);
  if (!div) return;

  if (!tableGenerated) {
    div.style.display = 'none';
    if (empty) empty.classList.remove('hidden');
    return;
  }

  div.style.display = 'block';
  if (empty) empty.classList.add('hidden');

  // Measure the available height from the parent flex container.
  // Plotly's autosize handles width reliably but ignores CSS-computed
  // flex height — we must pass it explicitly via layout.height.
  const plotH = div.parentElement ? div.parentElement.clientHeight - (div.offsetTop - div.parentElement.offsetTop) : 0;

  const valid   = tableEntries.filter(e => e.validCount > 0);
  const dists   = valid.map(e => e.distance);
  const rvs     = valid.map(e => e.radialVelocity);
  const distMin = Math.min(...dists), distMax = Math.max(...dists);
  const rvMin   = Math.min(...rvs),   rvMax   = Math.max(...rvs);

  const NX = 60, NY = 40;
  const xArr = Array.from({ length: NX }, (_, i) =>
    distMin + i * (distMax - distMin) / (NX - 1));
  const yArr = Array.from({ length: NY }, (_, i) =>
    rvMin   + i * (rvMax   - rvMin)   / (NY - 1));
  const zSurf = yArr.map(rv =>
    xArr.map(d => {
      const r = solver.predict(d, rv);
      return mode === 'speed' ? r.exitSpeed : r.launchAngle;
    }));

  const zLabel = mode === 'speed' ? 'Exit Speed (m/s)' : 'Launch Angle (°)';

  const traces = [
    {
      type: 'surface',
      x: xArr, y: yArr, z: zSurf,
      colorscale: 'Plasma',
      opacity: 0.94,
      showscale: true,
      colorbar: {
        title: { text: mode === 'speed' ? 'm/s' : '°', font: { color: '#c7c9c7', size: 11 } },
        tickfont: { color: '#c7c9c7', size: 10 },
        bgcolor: 'rgba(0,0,0,0)',
        bordercolor: 'rgba(60,0,100,0.6)',
        thickness: 14, len: 0.72,
      },
      hovertemplate:
        'dist: %{x:.2f} m<br>rv: %{y:.2f} m/s<br>' +
        (mode === 'speed' ? 'speed: %{z:.3f} m/s' : 'angle: %{z:.2f}°') +
        '<extra></extra>',
    },
  ];

  if (showPts) {
    traces.push({
      type: 'scatter3d',
      x: valid.map(e => e.distance),
      y: valid.map(e => e.radialVelocity),
      z: valid.map(e => mode === 'speed' ? e.exitSpeed : e.launchAngle),
      mode: 'markers',
      marker: { size: 4, color: '#ffffff', opacity: 0.85,
                line: { color: '#101820', width: 1 } },
      name: 'Table data',
      hovertemplate:
        'dist: %{x:.2f} m<br>rv: %{y:.2f} m/s<br>' +
        (mode === 'speed' ? 'speed: %{z:.3f} m/s' : 'angle: %{z:.2f}°') +
        '<extra>table point</extra>',
    });
  }

  const axBase = {
    color: '#c7c9c7',
    gridcolor: 'rgba(124,127,171,0.22)',
    zerolinecolor: 'rgba(124,127,171,0.4)',
    backgroundcolor: 'rgba(24,34,45,0.75)',
    showbackground: true,
    tickfont: { color: '#c7c9c7', size: 10 },
    titlefont: { color: '#c5b4e3', size: 11 },
  };

  const layout = {
    autosize: true,
    height: plotH > 80 ? plotH : undefined,
    paper_bgcolor: '#101820',
    font: { color: '#f6f2f4', family: 'Segoe UI, system-ui, sans-serif', size: 11 },
    title: {
      text: mode === 'speed'
        ? 'Exit Speed — f(distance, radial_vel) [m/s]'
        : 'Launch Angle — f(distance, radial_vel) [°]',
      font: { size: 13, color: '#c5b4e3' },
      pad: { t: 6 }, x: 0.5,
    },
    scene: {
      bgcolor: '#101820',
      xaxis: { ...axBase, title: 'Distance (m)' },
      yaxis: { ...axBase, title: 'Radial Velocity (m/s)' },
      zaxis: { ...axBase, title: zLabel },
      camera: { eye: { x: 1.65, y: -1.75, z: 0.90 }, up: { x: 0, y: 0, z: 1 } },
      aspectratio: { x: 1.5, y: 1.0, z: 0.75 },
    },
    margin: { l: 10, r: 10, t: 52, b: 10 },
    legend: {
      font: { color: '#c7c9c7', size: 10 },
      bgcolor: 'rgba(16,24,32,0.7)',
      bordercolor: '#3c0064', borderwidth: 1,
      x: 0.01, y: 0.98,
    },
    modebar: { bgcolor: 'rgba(0,0,0,0)', color: '#7c7fab', activecolor: '#c5b4e3' },
  };

  const config = {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ['resetCameraLastSave3d'],
  };

  Plotly.react(div, traces, layout, config).then(() => {
    // After the initial render, let the browser finish flex-layout recalculation
    // then resize Plotly to fill any remaining gap.
    requestAnimationFrame(() => Plotly.Plots.resize(div));
  });
}

window.drawPolySurface = function () {
  _drawPlotlySurface(
    'polySurfacePlot', 'surface-empty',
    polySurfaceMode,
    $('surface-show-pts')?.checked ?? true
  );
};

window.drawOverviewSurface = function () {
  _drawPlotlySurface(
    'overviewSurfacePlot', 'ov-surface-empty',
    ovSurfaceMode,
    $('ov-show-pts')?.checked ?? true
  );
};

// ── Overview tab helpers ───────────────────────────────────────────────────────

window.generateFromOverview = function () {
  // Sync overview → table-tab inputs so Shot Table tab stays consistent
  const map = {
    'ov-dmin': 'tbl-dmin', 'ov-dmax': 'tbl-dmax',
    'ov-dsteps': 'tbl-dsteps', 'ov-rvsteps': 'tbl-rvsteps',
    'ov-spin': 'tbl-spin',
    'ov-ceiling': 'tbl-ceiling',
  };
  for (const [src, dst] of Object.entries(map)) {
    const s = $(src), d = $(dst);
    if (s && d) d.value = s.value;
  }
  // Keep spin slider in sync
  const spinSl = $('tbl-spin-sl');
  if (spinSl) spinSl.value = $('ov-spin')?.value;
  // Keep ceiling slider in sync
  const ceilSl = $('tbl-ceiling-sl');
  if (ceilSl) ceilSl.value = $('ov-ceiling')?.value;
  // Ceiling is always forced on when generating from the Overview tab
  if ($('tbl-ceiling-on')) $('tbl-ceiling-on').checked = true;

  generateTable();
};


// ── Java code generation ───────────────────────────────────────────────────────

/** Java expression for a single 2D monomial d^a * v^b (uses pre-computed d2/d3/v2/v3). */
function javaTermExpr(a, b) {
  const d = ['', 'd', 'd2', 'd3'];
  const v = ['', 'v', 'v2', 'v3'];
  const dp = a <= 3 ? d[a] : `Math.pow(d,${a})`;
  const vp = b <= 3 ? v[b] : `Math.pow(v,${b})`;
  if (a === 0 && b === 0) return '1.0';
  if (a === 0) return vp;
  if (b === 0) return dp;
  return `${dp} * ${vp}`;
}

/** Format a coefficient for Java source: fixed-width scientific notation with sign. */
function javaCoeff(c) {
  return (c >= 0 ? ' ' : '') + c.toExponential(10) + (Number.isInteger(c) ? '' : '');
}

window.generateJava = function () {
  if (!tableGenerated) {
    alert('Generate a shot table first.');
    return;
  }

  const c       = solver.getCoefficients();
  const valid   = tableEntries.filter(e => e.validCount > 0);
  const distMin = Math.min(...valid.map(e => e.distance));
  const distMax = Math.max(...valid.map(e => e.distance));
  const rvMin   = Math.min(...valid.map(e => e.radialVelocity));
  const rvMax   = Math.max(...valid.map(e => e.radialVelocity));
  const hood    = val('tbl-hood');
  const mps     = val('tbl-mps');
  const now     = new Date().toISOString().slice(0, 10);

  // Coefficient arrays: one line per term with label comment
  const maxLabelLen = Math.max(...c.terms.map(([a, b]) => termLabel(a, b).length));
  const fmtCoeffLine = (coeffArr) =>
    c.terms.map(([a, b], i) => {
      const lbl = termLabel(a, b).padEnd(maxLabelLen);
      return `        /* ${lbl} */  ${javaCoeff(coeffArr[i])}`;
    }).join(',\n');

  // terms[] initializer used inside evalPolyRaw
  // Comma goes BEFORE the // comment so Java sees it as part of the code, not the comment.
  const termsInit = c.terms.map(([a, b], i) => {
    const expr  = javaTermExpr(a, b);
    const lbl   = termLabel(a, b).padEnd(maxLabelLen);
    const comma = i < c.terms.length - 1 ? ',' : ' ';
    return `            ${expr.padEnd(10)}${comma} // ${lbl}`;
  }).join('\n');

  // Pre-computed powers needed by the polynomial
  const needD2 = c.terms.some(([a])    => a >= 2);
  const needD3 = c.terms.some(([a])    => a >= 3);
  const needV2 = c.terms.some(([, b])  => b >= 2);
  const needV3 = c.terms.some(([, b])  => b >= 3);
  // Emit in dependency order: d2 before d3, v2 before v3
  const precompute = [
    needD2 ? '        double d2 = d * d;'   : '',
    needV2 ? '        double v2 = v * v;'   : '',
    needD3 ? '        double d3 = d2 * d;'  : '',
    needV3 ? '        double v3 = v2 * v;'  : '',
  ].filter(Boolean).join('\n');

  const java =
`// Generated by FRC 2026 Shot Calculator — ${now}
// 2D degree-${c.degree} polynomial surface: f(distance_m, radialVel_ms) → {exitSpeed_ms, launchAngle_deg}
// Monomials in order: ${c.terms.map(([a,b]) => termLabel(a,b)).join(', ')}

public class ShotCalculator {

    // ── Tuning (baked in at generation time) ─────────────────────────────────
    private static final double HOOD_OFFSET_DEG = ${hood.toFixed(4)};   // degrees, added to angle
    private static final double MPS_FACTOR      = ${mps.toFixed(6)};   // scales exit speed

    // ── Fitted range — inputs are clamped to these bounds ────────────────────
    private static final double DIST_MIN = ${distMin.toFixed(4)};  // metres
    private static final double DIST_MAX = ${distMax.toFixed(4)};
    private static final double RV_MIN   = ${rvMin.toFixed(4)};  // m/s
    private static final double RV_MAX   = ${rvMax.toFixed(4)};

    // ── Polynomial coefficients ───────────────────────────────────────────────
    // Both arrays share the same monomial basis.
    // f(d, v) = Σ COEFFS[i] · d^a[i] · v^b[i]
    private static final double[] SPEED_COEFFS = {
${fmtCoeffLine(c.speedCoeffs)}
    };

    private static final double[] ANGLE_COEFFS = {
${fmtCoeffLine(c.angleCoeffs)}
    };

    // ── Result type ───────────────────────────────────────────────────────────

    /** Immutable shot command returned by {@link #getShotParams}. */
    public static final class ShotParameters {
        /** Ball exit speed in m/s, pre-scaled by MPS_FACTOR. */
        public final double exitSpeed;
        /** Shooter launch angle in degrees, with HOOD_OFFSET_DEG applied. */
        public final double launchAngle;
        /**
         * Yaw correction to apply before firing (degrees).
         * Positive = aim left, negative = aim right.
         * Zero when robot is not moving tangentially.
         */
        public final double yawOffset;

        public ShotParameters(double exitSpeed, double launchAngle, double yawOffset) {
            this.exitSpeed   = exitSpeed;
            this.launchAngle = launchAngle;
            this.yawOffset   = yawOffset;
        }

        @Override
        public String toString() {
            return String.format("ShotParameters{exitSpeed=%.3f m/s, launchAngle=%.2f°, yawOffset=%.2f°}",
                                 exitSpeed, launchAngle, yawOffset);
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Compute shooter exit speed, launch angle, and yaw correction from robot state.
     *
     * Applies the 1690 Orbit iterative virtual-target algorithm for shoot-on-the-move:
     * each pass looks up the polynomial at the current virtual aim point, estimates
     * time-of-flight from horizontal kinematics, shifts the aim point by how far the
     * robot moves during that flight, and repeats until TOF converges (≤ 5 passes,
     * typically 2–3).
     *
     * @param distance           horizontal distance to goal centre (metres)
     * @param radialVelocity     robot velocity toward/away from goal (m/s);
     *                           positive = closing on goal
     * @param tangentialVelocity robot velocity perpendicular to the robot–goal line (m/s)
     * @return {@link ShotParameters} containing exitSpeed, launchAngle, and yawOffset.
     *         exitSpeed   — convert to flywheel RPM: RPM = (exitSpeed / wheelCircumference) * 60.
     *         launchAngle — command directly to the hood/pivot mechanism.
     *         yawOffset   — add to current heading before firing.
     */
    public static ShotParameters getShotParams(double distance, double radialVelocity,
                                               double tangentialVelocity) {
        // ── 1690 iterative virtual-target solver ──────────────────────────────
        double vdx = distance;  // virtual aim point — radial component (m)
        double vdz = 0.0;       // virtual aim point — lateral component (m)
        double tof  = 0.0;      // converged time-of-flight estimate (s)

        for (int iter = 0; iter < 5; iter++) {
            double vDist = Math.sqrt(vdx * vdx + vdz * vdz);
            if (vDist < 0.1) break;

            // Evaluate polynomial at virtual distance with rv = 0.
            // Robot motion is already encoded in the shifted aim point.
            double[] raw   = evalPolyRaw(vDist, 0.0);
            double   speed = raw[0] * MPS_FACTOR;
            double   angle = raw[1] + HOOD_OFFSET_DEG;

            // Approximate TOF from horizontal kinematics (~5 % error, sufficient for correction)
            double cosA    = Math.cos(angle * Math.PI / 180.0);
            double prevTof = tof;
            tof = vDist / Math.max(speed * cosA, 0.5);  // 0.5 guards div-by-zero

            // Shift virtual aim point: where the goal will be when the ball arrives
            vdx = distance - radialVelocity    * tof;
            vdz =          - tangentialVelocity * tof;

            if (iter > 0 && Math.abs(tof - prevTof) < 0.002) break;
        }

        // ── Final shot parameters at converged virtual aim point ──────────────
        double virtualDist  = Math.sqrt(vdx * vdx + vdz * vdz);

        // Yaw: angle from radial axis to virtual aim point
        double yawOffsetDeg = Math.atan2(-tangentialVelocity * tof,
                                          distance - radialVelocity * tof)
                              * (180.0 / Math.PI);

        double[] raw = evalPolyRaw(virtualDist, 0.0);
        return new ShotParameters(
            raw[0] * MPS_FACTOR,
            raw[1] + HOOD_OFFSET_DEG,
            yawOffsetDeg
        );
    }

    /** Convenience overload — use when robot is not moving laterally. */
    public static ShotParameters getShotParams(double distance, double radialVelocity) {
        return getShotParams(distance, radialVelocity, 0.0);
    }

    // ── Polynomial evaluation ─────────────────────────────────────────────────

    /**
     * Evaluates the raw (un-tuned) polynomial surface at (distance, radialVel).
     * Inputs are clamped to the fitted data range.
     *
     * @return double[] { rawExitSpeed_ms, rawLaunchAngle_deg }
     *         Multiply exitSpeed by MPS_FACTOR and add HOOD_OFFSET_DEG to angle
     *         to obtain the final tuned values.
     */
    private static double[] evalPolyRaw(double distance, double radialVel) {
        double d = Math.max(DIST_MIN, Math.min(DIST_MAX, distance));
        double v = Math.max(RV_MIN,   Math.min(RV_MAX,   radialVel));

${precompute}

        double[] terms = {
${termsInit}
        };

        double exitSpeed = 0.0, launchAngle = 0.0;
        for (int i = 0; i < terms.length; i++) {
            exitSpeed   += SPEED_COEFFS[i] * terms[i];
            launchAngle += ANGLE_COEFFS[i] * terms[i];
        }
        return new double[]{ exitSpeed, launchAngle };
    }
}`;

  showCodeModal(java, 'ShotCalculator.java');
};

// ── Code modal helpers ─────────────────────────────────────────────────────────
let _modalCode     = '';
let _modalFilename = '';

function showCodeModal(code, filename) {
  _modalCode     = code;
  _modalFilename = filename;
  $('java-modal-code').textContent     = code;
  $('java-modal-filename').textContent = filename;
  $('java-modal').classList.remove('hidden');
}

window.closeCodeModal = function () {
  $('java-modal').classList.add('hidden');
};

window.onModalOverlayClick = function (e) {
  if (e.target === $('java-modal')) closeCodeModal();
};

window.copyModalCode = function () {
  navigator.clipboard.writeText(_modalCode).then(() => {
    const btn = $('java-copy-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => window.prompt('Copy Java code:', _modalCode));
};

window.downloadModalCode = function () {
  const blob = new Blob([_modalCode], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _modalFilename;
  a.click();
};

// Close modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCodeModal();
});
