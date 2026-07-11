// FRC 2026 Shot Calculator — GitHub Pages (fully client-side)

// ── State ─────────────────────────────────────────────────────────────────────
let tableEntries = [];
let solver = null;
let tableGenerated = false;
let activeWorker = null;

let feedTableEntries = [];
let feedSolver = null;
let feedTableGenerated = false;
let activeFeedWorker = null;

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
    if (btn.dataset.tab === 'feedsurface') {
      if (feedTableGenerated) drawFeedPolyCurves('feedSurfaceChart');
    }
  });
});

// ── Mode switching (Hub Shot / Feed Shot) ────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    $('hub-tab-bar').classList.toggle('hidden', mode !== 'hub');
    $('feed-tab-bar').classList.toggle('hidden', mode !== 'feed');
    const targetBar = $(mode === 'hub' ? 'hub-tab-bar' : 'feed-tab-bar');
    const activeBtn = targetBar.querySelector('.tab-btn.active') || targetBar.querySelector('.tab-btn');
    if (activeBtn) activeBtn.click();
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
  ['tbl-spin','tbl-spin-sl'],
  ['tbl-ceiling','tbl-ceiling-sl'],
  ['lkp-dist','lkp-dist-sl'], ['lkp-rv','lkp-rv-sl'],     ['lkp-lateral','lkp-lateral-sl'],
  ['ov-spin','ov-spin-sl'], ['ov-ceiling','ov-ceiling-sl'],
  ['feed-spin','feed-spin-sl'],
  ['fsim-dist','fsim-dist-sl'], ['fsim-rv','fsim-rv-sl'],
  ['fsim-spin','fsim-spin-sl'],
  ['flkp-dist','flkp-dist-sl'], ['flkp-rv','flkp-rv-sl'], ['flkp-lateral','flkp-lateral-sl'],
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

// ── Chart-tab switching (Feed Table tab) ──────────────────────────────────────
function switchFeedTab(name) {
  document.querySelectorAll('#tab-feed .chart-tab-btn[data-ftab]').forEach(b =>
    b.classList.toggle('active', b.dataset.ftab === name));
  document.querySelectorAll('#tab-feed .chart-tab-content').forEach(c =>
    c.classList.toggle('active', c.id === 'ftab-' + name));
}

// Sweep range used by the Simulate tab — full physics envelope so every
// shot that scores is reported. (Shot Table generation passes its own
// settings and is unaffected.)
const SIM_SWEEP = {
  speedRange: [5.0, 20.0],
  angleRange: [40.68, 81.0],
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
    hoodAngleOffset: 0,
    mpsFactor: 1,
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
            speedRange: [5.0, 20.0], angleRange: [40.68, 81.0],
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

  const rpm = solver.speedToRpm(result.exitSpeed, 1);

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


/** Builds the PolyModel record definition + one named model constant, ready to paste into a robot class. */
function buildPolyModelSnippet({ c, distMin, distMax, rvMin, rvMax, constName, modelName, modelComment }) {
  const maxLabelLen = Math.max(...c.terms.map(([a, b]) => termLabel(a, b).length));
  const basisList   = c.terms.map(([a, b]) => termLabel(a, b)).join(', ');

  const fmtCoeffBlock = (coeffArr) =>
    c.terms.map(([a, b], i) => {
      const lbl   = termLabel(a, b).padEnd(maxLabelLen);
      const val   = coeffArr[i].toExponential(10);
      const comma = i < c.terms.length - 1 ? ',' : '';
      return `                        /* ${lbl} */ ${val}${comma}`;
    }).join('\n');

  return `\
    /**
     * A fitted degree-${c.degree} polynomial surface plus its input domain and normalisation. Inputs are
     * mapped to zero-mean unit-variance before evaluation, so the coefficients live in normalised
     * space and must not be applied to raw (metres / m/s) inputs directly.
     *
     * @param name        descriptive name for telemetry
     * @param distMin     fitted distance lower bound (metres); inputs clamped, shots outside flagged invalid
     * @param distMax     fitted distance upper bound (metres)
     * @param rvMin       fitted radial-velocity lower bound (m/s)
     * @param rvMax       fitted radial-velocity upper bound (m/s)
     * @param dMean       distance normalisation mean
     * @param dStd        distance normalisation standard deviation
     * @param vMean       radial-velocity normalisation mean
     * @param vStd        radial-velocity normalisation standard deviation
     * @param speedCoeffs exit-speed coefficients in the monomial basis ${basisList}
     * @param angleCoeffs launch-angle coefficients in the same basis
     */
    private record PolyModel(
            String name,
            double distMin,
            double distMax,
            double rvMin,
            double rvMax,
            double dMean,
            double dStd,
            double vMean,
            double vStd,
            double[] speedCoeffs,
            double[] angleCoeffs) {}

    /** ${modelComment} */
    private static final PolyModel ${constName} =
            new PolyModel(
                    "${modelName}",
                    ${distMin.toFixed(1)}, // distMin (m)
                    ${distMax.toFixed(1)}, // distMax (m)
                    ${rvMin.toFixed(1)}, // rvMin (m/s)
                    ${rvMax.toFixed(1)}, // rvMax (m/s)
                    ${c.dMean.toFixed(10)}, // dMean
                    ${c.dStd.toFixed(10)}, // dStd
                    ${c.vMean.toFixed(10)}, // vMean
                    ${c.vStd.toFixed(10)}, // vStd
                    new double[] {
${fmtCoeffBlock(c.speedCoeffs)}
                    },
                    new double[] {
${fmtCoeffBlock(c.angleCoeffs)}
                    });`;
}

window.generateJava = function () {
  if (!tableGenerated) { alert('Generate a shot table first.'); return; }

  const c       = solver.getCoefficients();
  const valid   = tableEntries.filter(e => e.validCount > 0);
  const distMin = Math.min(...valid.map(e => e.distance));
  const distMax = Math.max(...valid.map(e => e.distance));
  const rvMin   = Math.min(...valid.map(e => e.radialVelocity));
  const rvMax   = Math.max(...valid.map(e => e.radialVelocity));

  showCodeModal(buildPolyModelSnippet({
    c, distMin, distMax, rvMin, rvMax,
    constName:    'HUB_MODEL',
    modelName:    'Hub Shot Model',
    modelComment: 'Hub-shot model — used when the robot is in a scoring zone.',
  }), 'ShotCalculator.java');
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

// ── Feed Table ────────────────────────────────────────────────────────────────

// Inline fallback for feed table generation (used when Web Workers are unavailable).
function runFeedTableInline(cfg, onProgress, onDone, onError) {
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
          const valid = PHYSICS.findValidFeedShots({
            distance: dist, robotRadialVel: rv, spinRps: cfg.spinRps,
            drag: cfg.drag, magnus: cfg.magnus,
            speedRange: [3.0, 18.0], angleRange: [40.68, 81.0],
            speedSteps: 40, angleSteps: 40,
          });
          const optimal = PHYSICS.selectOptimalFeedShot(valid, dist);
          let entry;
          if (optimal) {
            entry = {
              distance: dist, radialVelocity: rv,
              exitSpeed:      optimal.speed,
              launchAngle:    optimal.angle,
              toleranceSpeed: PHYSICS.std(valid.map(s => s.speed)),
              toleranceAngle: PHYSICS.std(valid.map(s => s.angle)),
              validCount:     valid.length,
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
      console.error('feed inline generation error', err);
      onError(err);
    }
  }

  setTimeout(tick, 0);
  return { cancel: () => { cancelled = true; } };
}

window.generateFeedTable = function () {
  if (activeFeedWorker) {
    if (typeof activeFeedWorker.terminate === 'function') activeFeedWorker.terminate();
    else if (typeof activeFeedWorker.cancel === 'function') activeFeedWorker.cancel();
    activeFeedWorker = null;
  }

  const distMin  = parseFloat($('feed-dmin').value);
  const distMax  = parseFloat($('feed-dmax').value);
  const distSteps = parseInt($('feed-dsteps').value, 10);
  const rvSteps  = parseInt($('feed-rvsteps').value, 10);
  const spinRps  = parseFloat($('feed-spin').value);
  const drag     = $('feed-drag').checked;
  const magnus   = $('feed-magnus').checked;
  const cfg = { distMin, distMax, distSteps, rvSteps, spinRps, drag, magnus };

  const status = $('feed-status');
  const bar    = $('feed-progress-bar');
  const label  = $('feed-progress-label');
  const wrap   = $('feed-progress-wrap');

  status.classList.add('hidden');
  wrap.classList.remove('hidden');
  bar.style.width = '0%';
  label.textContent = '0%';
  $('feed-generate-btn').disabled = true;

  const onProgress = pct => {
    bar.style.width = pct + '%';
    label.textContent = pct + '%';
  };

  const onDone = table => {
    bar.style.width = '100%';
    label.textContent = '100% — Done';
    feedTableEntries = table;
    feedSolver = new SHOT_TABLE.ShotPolynomialSolver(3);
    feedSolver.fit(feedTableEntries);
    feedTableGenerated = true;
    activeFeedWorker = null;
    $('feed-generate-btn').disabled = false;

    const validCount = feedTableEntries.filter(e => e.validCount > 0).length;
    status.className = 'result-box info';
    status.innerHTML = `${feedTableEntries.length} entries · ${validCount} with valid shots · degree 3`;
    status.classList.remove('hidden');

    drawFeedTableCharts();
    drawFeedPolyCurves('feedPolyCurvesChart');
    drawFeedPolyCurves('feedLookupPolyChart');
    renderFeedPolyCoeffs();
  };

  const onError = err => {
    $('feed-generate-btn').disabled = false;
    status.className = 'result-box error';
    status.textContent = 'Error: ' + (err.message || String(err));
    status.classList.remove('hidden');
    activeFeedWorker = null;
  };

  try {
    const worker = new Worker('worker.js');
    worker.postMessage({ type: 'generate_feed', config: cfg });
    worker.onmessage = e => {
      if (e.data.type === 'progress') onProgress(e.data.pct);
      else if (e.data.type === 'done')  onDone(e.data.table);
      else if (e.data.type === 'error') onError(new Error(e.data.message));
    };
    worker.onerror = err => onError(err);
    activeFeedWorker = worker;
  } catch (_) {
    activeFeedWorker = runFeedTableInline(cfg, onProgress, onDone, onError);
  }
};

function drawFeedTableCharts() {
  const valid = feedTableEntries.filter(e => e.validCount > 0);
  if (!valid.length) return;

  const dists = [...new Set(valid.map(e => +e.distance.toFixed(4)))].sort((a, b) => a - b);
  const rvs   = [...new Set(valid.map(e => +e.radialVelocity.toFixed(4)))].sort((a, b) => a - b);

  const palette = makeColorRamp(rvs.length, 'rgba(123,140,222,');
  drawLineMap('feedSpeedChart', dists, rvs, valid, 'exitSpeed',   'Exit Speed (m/s)', palette);
  drawLineMap('feedAngleChart', dists, rvs, valid, 'launchAngle', 'Launch Angle (°)', palette);

  ['feedspeed-empty', 'feedangle-empty'].forEach(id => $(id)?.classList.add('hidden'));
}

function drawFeedPolyCurves(canvasId = 'feedPolyCurvesChart') {
  if (!feedTableGenerated) return;
  const valid = feedTableEntries.filter(e => e.validCount > 0);
  if (!valid.length) return;

  const distMin = Math.min(...valid.map(e => e.distance));
  const distMax = Math.max(...valid.map(e => e.distance));
  const { distances, curves } = feedSolver.sampleCurves(distMin, distMax, 80);

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
        ySpeed: { position: 'left',  ...scaleBase(), title: axisTitle('Speed (m/s)') },
        yAngle: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: TEXT_CLR }, title: axisTitle('Angle (°)') },
      },
    },
  });
  if (canvasId === 'feedPolyCurvesChart') $('feedpolycurves-empty')?.classList.add('hidden');
}

function renderFeedPolyCoeffs() {
  const display = $('feed-coeffs-display');
  if (!display || !feedTableGenerated) return;

  const c = feedSolver.getCoefficients();
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
            <th>Term</th><th>[a, b]</th>
            <th>Speed coeff (m/s)</th><th>Angle coeff (°)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

window.exportFeedTable = function () {
  if (!feedTableGenerated) { alert('Generate a feed table first.'); return; }
  const blob = new Blob([JSON.stringify(feedTableEntries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'feed_table.json';
  a.click();
};

window.importFeedTable = function () {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json';
  inp.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        feedTableEntries = JSON.parse(ev.target.result);
        feedSolver = new SHOT_TABLE.ShotPolynomialSolver(3);
        feedSolver.fit(feedTableEntries);
        feedTableGenerated = true;
        const validCount = feedTableEntries.filter(e => e.validCount > 0).length;
        const status = $('feed-status');
        status.className = 'result-box info';
        status.innerHTML = `Imported ${feedTableEntries.length} entries · ${validCount} valid`;
        status.classList.remove('hidden');
        drawFeedTableCharts();
        drawFeedPolyCurves('feedPolyCurvesChart');
        drawFeedPolyCurves('feedLookupPolyChart');
        renderFeedPolyCoeffs();
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  inp.click();
};

// ── Feed Simulation ───────────────────────────────────────────────────────────

window.runFeedSimulate = function () {
  const dist       = val('fsim-dist');
  const rv         = val('fsim-rv');
  const spinRps    = val('fsim-spin');
  const drag       = $('fsim-drag').checked;
  const magnus     = $('fsim-magnus').checked;
  const box        = $('fsim-result');

  const valid = PHYSICS.findValidFeedShots({
    distance: dist, robotRadialVel: rv, spinRps,
    drag, magnus,
    speedRange: [3.0, 18.0], angleRange: [40.68, 81.0],
    speedSteps: 80, angleSteps: 80,
  });
  const optimal = PHYSICS.selectOptimalFeedShot(valid, dist);

  if (!optimal) {
    box.className = 'result-box miss';
    box.textContent = 'No valid shots found.';
    box.classList.remove('hidden');
    return;
  }

  const result = PHYSICS.simulateFeedShot({
    exitSpeed: optimal.speed, launchAngleDeg: optimal.angle,
    spinRps, robotRadialVel: rv, drag, magnus, storeTrajectory: true,
  });

  const err = result.xLanding - dist;
  box.className = 'result-box hit';
  box.innerHTML = `
    <strong>&#10003; Optimal feed shot (maximum robustness)</strong><br/>
    Exit speed: <strong>${optimal.speed.toFixed(2)} m/s</strong><br/>
    Launch angle: <strong>${optimal.angle.toFixed(2)}°</strong><br/>
    Landing x: ${result.xLanding.toFixed(3)} m
      <span style="color:#888;font-size:11px">(target ${dist.toFixed(2)} m, error ${err >= 0 ? '+' : ''}${err.toFixed(3)} m)</span><br/>
    Time of flight: ${result.tof.toFixed(3)} s · valid shots: ${valid.length}
  `;
  box.classList.remove('hidden');

  $('feedtraj-empty')?.classList.add('hidden');
  drawFeedTrajectory(result, dist, optimal);
};

function drawFeedTrajectory(result, targetDist, optimal) {
  destroyChart('feedTrajChart');
  const ctx = $('feedTrajChart').getContext('2d');

  const step = Math.max(1, Math.floor(result.trajX.length / 300));
  const pts = [];
  for (let i = 0; i < result.trajX.length; i += step) {
    pts.push({ x: result.trajX[i], y: result.trajY[i] });
  }

  const xMax = Math.max(targetDist + 0.5, result.xLanding + 0.3);

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        // Floor line
        { label: 'Floor', data: [{ x: 0, y: 0 }, { x: xMax, y: 0 }],
          borderColor: 'rgba(100,200,100,0.35)', borderDash: [8, 4],
          showLine: true, pointRadius: 0, borderWidth: 1.5, order: 5 },
        // Target marker (single point on floor)
        { label: 'Target',
          data: [{ x: targetDist, y: 0 }],
          borderColor: 'rgba(60,200,80,0.95)', backgroundColor: 'rgba(60,200,80,0.95)',
          pointRadius: 6, pointStyle: 'crossRot', order: 2 },
        // Target centre tick
        { data: [{ x: targetDist, y: 0 }, { x: targetDist, y: 0.25 }],
          borderColor: 'rgba(60,200,80,0.60)',
          showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3 },
        // Landing drop
        { data: [{ x: result.xLanding, y: 0 }, { x: result.xLanding, y: PHYSICS.SHOOTER_HEIGHT * 0.3 }],
          borderColor: 'rgba(220,60,60,0.75)',
          showLine: true, pointRadius: 0, borderWidth: 1.5, order: 3 },
        // Landing circle
        { label: 'Landing', data: [{ x: result.xLanding, y: 0 }],
          backgroundColor: 'rgba(0,0,0,0)', borderColor: 'white',
          pointRadius: 7, pointStyle: 'circle', borderWidth: 2, showLine: false, order: 1 },
        // Ball path
        { label: `${optimal.angle.toFixed(1)}° @ ${optimal.speed.toFixed(2)} m/s`,
          data: pts, borderColor: '#4488ee',
          showLine: true, pointRadius: 0, borderWidth: 2.5, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true, animation: false,
      plugins: {
        legend: { labels: { color: TEXT_CLR, font: { size: 10 },
          filter: item => !!item.text } },
        zoom: zoomPluginOptions(),
      },
      scales: {
        x: { ...scaleBase(), title: axisTitle('Distance (m)'), min: 0 },
        y: { ...scaleBase(), title: axisTitle('Height (m)'), min: -0.05 },
      },
    },
  });
}

// ── Feed Lookup ───────────────────────────────────────────────────────────────

window.doFeedLookup = function () {
  const box = $('feedlookup-result');
  if (!feedTableGenerated) {
    box.innerHTML = '<span style="color:#e05667">No feed table loaded. Generate or import one first.</span>';
    return;
  }

  const dist       = val('flkp-dist');
  const rv         = val('flkp-rv');
  const lateralVel = val('flkp-lateral');

  const result = feedSolver.predict(dist, rv);
  if (!result) {
    box.innerHTML = '<span style="color:#e05667">No polynomial data at this distance.</span>';
    return;
  }

  const rpm = feedSolver.speedToRpm(result.exitSpeed, 1);

  box.innerHTML = `
    <span class="lbl">Distance:</span>        <span class="val">${dist.toFixed(2)} m</span><br/>
    <span class="lbl">Radial Velocity:</span>  <span class="val">${rv >= 0 ? '+' : ''}${rv.toFixed(2)} m/s</span><br/>
    <span class="lbl">Lateral Velocity:</span> <span class="val">${lateralVel >= 0 ? '+' : ''}${lateralVel.toFixed(2)} m/s</span><br/>
    <br/>
    <span class="lbl">── Shot Command ───────────────</span><br/>
    <span class="lbl">Exit Speed:</span>       <span class="val">${result.exitSpeed.toFixed(3)} m/s</span><br/>
    <span class="lbl">Launch Angle:</span>     <span class="val">${result.launchAngle.toFixed(2)}°</span><br/>
    <span class="lbl">Flywheel RPM:</span>     <span class="val">${Math.round(rpm)} RPM</span>
  `;

  // Polynomial-based virtual target — mirrors FeedCalculator.java getShotParams exactly
  if (rv !== 0 || lateralVel !== 0) {
    let vdx = dist, vdz = 0, tof = 0;
    for (let iter = 0; iter < 5; iter++) {
      const vDist = Math.sqrt(vdx * vdx + vdz * vdz);
      if (vDist < 0.1) break;
      const res = feedSolver.predict(vDist, 0);
      if (!res) break;
      const cosA   = Math.cos(res.launchAngle * Math.PI / 180);
      const prevTof = tof;
      tof = vDist / Math.max(res.exitSpeed * cosA, 0.5);
      vdx = dist - rv * tof;
      vdz = -lateralVel * tof;
      if (iter > 0 && Math.abs(tof - prevTof) < 0.002) break;
    }
    const virtualDist  = Math.sqrt(vdx * vdx + vdz * vdz);
    const yawOffsetDeg = Math.atan2(-lateralVel * tof, dist - rv * tof) * 180 / Math.PI;
    const vtResult = feedSolver.predict(virtualDist, 0);
    const yawDir = yawOffsetDeg < -0.05 ? ' (aim right)' :
                   yawOffsetDeg >  0.05 ? ' (aim left)'  : '';
    const vtHtml = vtResult
      ? `<span class="lbl">Virtual speed:</span>    <span class="val">${vtResult.exitSpeed.toFixed(3)} m/s</span><br/>
         <span class="lbl">Virtual angle:</span>    <span class="val">${vtResult.launchAngle.toFixed(2)}°</span><br/>`
      : '';
    box.innerHTML += `
      <br/>
      <span class="lbl" style="color:#7b8cde">── Shoot-on-Move (1690) ───────</span><br/>
      <span class="lbl">Virtual dist:</span>     <span class="val">${virtualDist.toFixed(2)} m</span><br/>
      <span class="lbl">Yaw offset:</span>       <span class="val">${yawOffsetDeg >= 0 ? '+' : ''}${yawOffsetDeg.toFixed(1)}°${yawDir}</span><br/>
      ${vtHtml}
    `;
  }

  drawFeedPolyCurves('feedLookupPolyChart');
};

window.generateFeedJava = function () {
  if (!feedTableGenerated) { alert('Generate a feed table first.'); return; }

  const c       = feedSolver.getCoefficients();
  const valid   = feedTableEntries.filter(e => e.validCount > 0);
  const distMin = Math.min(...valid.map(e => e.distance));
  const distMax = Math.max(...valid.map(e => e.distance));
  const rvMin   = Math.min(...valid.map(e => e.radialVelocity));
  const rvMax   = Math.max(...valid.map(e => e.radialVelocity));

  showCodeModal(buildPolyModelSnippet({
    c, distMin, distMax, rvMin, rvMax,
    constName:    'FEED_MODEL',
    modelName:    'Feed Shot Model',
    modelComment: 'Feed-shot model — floor target, optimised for maximum robustness.',
  }), 'FeedCalculator.java');
};
