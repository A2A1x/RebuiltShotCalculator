# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Rebuilt), inspired by frc4414's approach and the [1690 Orbit shoot-on-the-move presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

Fully client-side: the entire physics engine, valid-region sweep, 2D polynomial fit, and visualizations run in the browser. No server, no install.

---

## Modes

The app has two independent shot modes, selectable from the top mode bar:

| Mode | Target | Distance range |
|---|---|---|
| **Hub Shot** | Goal at height (rim-to-rim) | Configurable, typically 1.5 – 8 m |
| **Feed Shot** | Floor (ball lands at a specified distance) | Configurable, typically 5 – 10 m |

Each mode has four tabs: **Shot Table · Shot Simulation · Shot Lookup · Poly Surface**.

---

## Key Design Principles

Instead of empirically tuning a full lookup map, this system:

1. **Simulates the full valid shot region** at every (distance, radial velocity) cell: every (speed, angle) pair that scores or lands on target. Gives a direct measure of shot robustness.
2. **Selects the optimal shot** using a mode-specific criterion (see below).
3. **Fits a single 2D degree-3 polynomial surface** jointly across all (distance, radial velocity) data using least-squares normal equations solved by Gauss-Jordan with partial pivoting. One surface per output (exit speed, launch angle, time of flight); no per-rv interpolation or table switching at runtime.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.
5. **Compensates for robot motion at runtime** using an iterative virtual-target solver (1690 Orbit technique) that reads flight time off the fitted TOF surface, so the robot never simulates or estimates a trajectory.

### Hub Shot Optimal Selection
Picks the shot that maximizes the std-normalised margin from the valid-region boundary along both speed and angle axes, with centroid proximity as a tiebreak. Produces smooth variation across adjacent cells.

### Feed Shot Optimal Selection
1. Finds the minimum achievable landing error across the full speed x angle sweep.
2. Keeps the pool of shots landing within 0.15 m of that minimum (best-achievable accuracy gate).
3. Among those, picks the shot with the most neighbors within +/-0.5 m/s and +/-2 deg in speed x angle space: the shot deepest inside the valid region, maximising tolerance for motor and hood error.

---

## Physics Model

- **Aerodynamic drag** (`C_d = 0.47`): `F = 1/2 * rho * C_d * A * v^2`, applied opposite to velocity.
- **Magnus effect**: `|F| = 1/2 * rho * C_m * A * v * omega * R`, applied perpendicular to velocity in the lift direction for backspin. `C_m = 0.20`; tune against measured flight data.
- **Spin decay**: backspin decays exponentially in flight: `omega(t) = omega_0 * exp(-k*t)`, `k = 0.5 s^-1`.
- **Symplectic (semi-implicit) Euler** integration at `DT = 0.002 s`, `MAX_SIM_TIME = 3.0 s`.
- **Hub geometry**: front lip at 1.83 m, opening radius 0.530 m. Front and back walls each 8 in tall; crossing either is a miss.
- **Feed geometry**: ball lands when `y <= 0`; landing x is interpolated linearly between the last two physics steps for precision.
- **Ceiling limit** (hub only): arcs crossing the configured height are rejected.
- **Launch angle sweep**: both modes use 40.68 deg – 81.0 deg.

---

## 2D Polynomial Surface

Maps `(distance, radialVelocity)` to `exitSpeed`, `launchAngle`, and `timeOfFlight` using a single degree-3 fit across all table data simultaneously.

**Basis**: all monomials `d^a * v^b` with `a + b <= 3` (10 terms):

```
1,  d,  v,  d^2,  d*v,  v^2,  d^3,  d^2*v,  d*v^2,  v^3
```

**Fit**: least-squares normal equations `(A^T A) c = A^T y`, solved by Gauss-Jordan with partial pivoting. One solve per output (speed, angle, TOF). Inputs are zero-mean unit-variance normalised before fitting.

**Runtime**: `O(1)` evaluation: `f(d,v) = sum(c_i * d^a_i * v^b_i)`. Inputs are clamped to the fitted data range before normalisation.

### Time-of-Flight Surface

The optimal shot at each cell also yields its simulated flight time, fitted as a third surface. Reading flight time from this map removes the only runtime step that still needed a trajectory: the shoot-on-the-move iteration.

The fit smooths the raw TOF column much as it smooths speed and angle, since the grid-optimal shot jumps between neighbouring solutions from cell to cell. What matters is not agreement with that jittery column but agreement with the shot the surfaces actually command: at the default settings the predicted TOF is within **16 ms rms (130 ms worst case)** of simulating the polynomial's own speed/angle output. `docs/check.html` asserts this.

Tables generated before this surface existed still import and fit; `predict()` then returns a null `timeOfFlight` and the virtual-target solver falls back to the old ballistic estimate `vDist / (speed * cos(angle))`.

---

## Shoot-on-the-Move (1690 Orbit Virtual-Target Solver)

**Radial velocity** (toward/away from goal) is a table input; the polynomial surface is fitted over `rv in [-3, 3]` m/s, so the shot command already accounts for the robot closing or opening the range.

**Tangential velocity** (perpendicular to the shot line) is compensated at runtime:

1. Start with the virtual aim point at the actual target distance.
2. Evaluate the polynomial at that virtual distance (`rv = 0`); read TOF straight off the fitted TOF surface.
3. Shift: `vdx = dist - v_r * t`, `vdz = -v_t * t`.
4. Repeat up to 5 iterations; converges in <= 3 once `|delta_t| < 2 ms`.
5. **Virtual distance** `= sqrt(vdx^2 + vdz^2)`: final polynomial query.
6. **Yaw offset** `= atan2(-v_t * t, dist - v_r * t)`: rotate shooter to cancel lateral drift.

---

## Java Code Generation

After generating a table, click **Generate Java** to produce a `PolyModel` record definition plus a named model constant, ready to paste into your robot class.

```java
private record PolyModel(
        String name,
        double distMin, double distMax,
        double rvMin,   double rvMax,
        double dMean,   double dStd,
        double vMean,   double vStd,
        double[] speedCoeffs,
        double[] angleCoeffs,
        double[] tofCoeffs) {}

private static final PolyModel HUB_MODEL =
        new PolyModel(
                "Hub Shot Model",
                1.5, 8.0,   // dist range (m)
                -3.0, 3.0,  // rv range (m/s)
                4.7946224256, 1.9514199579,  // dMean, dStd
                -0.0434782609, 1.9813242725, // vMean, vStd
                new double[] { /* 10 speed coefficients */ },
                new double[] { /* 10 angle coefficients */ },
                new double[] { /* 10 TOF coefficients (s) */ });
```

`tofCoeffs` is omitted from both the record and the constant when the table carries no TOF data (an import from an older run).

The feed table generates an equivalent `FEED_MODEL` constant. Both models share the same `PolyModel` record; declare it once and keep both constants.

---

## UI Overview

### Hub Shot mode

| Tab | What it does |
|---|---|
| **Shot Table** | Generate the full (distance x rv) sweep and polynomial fit. Charts: Speed Map, Angle Map, Tolerance, Poly Curves (rv slices), Coefficients. Export/import JSON; generate Java. |
| **Shot Simulation** | Single-distance analysis: trajectory view and valid-region view with tolerance crosshairs and shoot-on-move correction. |
| **Shot Lookup** | Query the fitted polynomial at any (distance, rv, lateral velocity). Returns exit speed, launch angle, RPM estimate, flight time, yaw offset. |
| **Poly Surface** | Full-screen 3D surface (Plotly). Toggle between Exit Speed, Launch Angle, and Flight Time; overlay raw data points. |

### Feed Shot mode

| Tab | What it does |
|---|---|
| **Shot Table** | Generate the full (distance x rv) sweep and polynomial fit for floor targets. Same chart sub-tabs as hub. Export/import; generate Java. |
| **Shot Simulation** | Simulate a feed shot at a chosen distance: trajectory with target marker and landing point. |
| **Shot Lookup** | Query the feed polynomial at any (distance, rv, lateral velocity). Same virtual-target iteration as hub. |
| **Poly Surface** | Polynomial curves for the feed model. |

**All Chart.js charts**: scroll to zoom, drag to pan, double-click to reset.
**3D surface**: drag to orbit, scroll to zoom, double-click to reset.

---

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `HOOD_OFFSET_DEG` (deg) | Measure real exit angle from slow-mo video; apply constant offset | Shifts every shot angle by a fixed amount |
| `MPS_FACTOR` | Adjust until shots go in at all distances | Scales the entire speed command; one knob re-aligns all distances |

Both values default to neutral (`0` and `1.0`) at generation time and are applied by the robot-side evaluation code.

---

## Running Locally

```bash
cd docs
python -m http.server 8000      # any static file server works
# open http://localhost:8000
```

A static server is required for the Web Worker (Chrome blocks workers on `file://` origins). The app falls back to the main thread if the worker is unavailable; slower on large tables but fully functional.

---

## File Layout

```
docs/
  index.html      # Two-mode UI (Hub Shot / Feed Shot), 4 tabs each
  main.js         # UI logic, chart rendering, Plotly 3D surface, Java generation
  physics.js      # Ball flight simulation (drag + Magnus + spin decay + wall/ceiling/floor)
  shot_table.js   # 2D polynomial solver (least-squares Gauss-Jordan + ShotPolynomialSolver)
  worker.js       # Off-thread table generator (hub and feed)
  check.html      # Self-check for the TOF surface and virtual-target solve
  style.css       # Dark blue/purple theme (CSS custom properties)
```

Open `check.html` on the same static server to run the self-check; it prints one line per assertion.

---

## Constants to Update (`physics.js`)

| Constant | Default | Notes |
|---|---|---|
| `GOAL_HEIGHT` | 2.36 m | Goal opening centre height |
| `GOAL_RADIUS` | 0.530 m | Goal opening radius |
| `WALL_HEIGHT` | 0.2032 m | Rim wall height above each edge (8 in) |
| `BALL_RADIUS` | 0.075 m | Game-piece radius |
| `BALL_MASS` | 0.215 kg | Game-piece mass |
| `SHOOTER_HEIGHT` | 0.546 m | Shooter exit height above floor |
| `DRAG_COEFF` | 0.47 | Smooth-sphere baseline; increase for seamed/textured pieces |
| `MAGNUS_COEFF` | 0.20 | Tune against measured flight data |
| `SPIN_DECAY_RATE` | 0.5 | Exponential spin decay rate (s^-1); tune against real shots |
