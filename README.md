# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Rebuilt), inspired by frc4414's approach and the [1690 Orbit shoot-on-the-move presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

Fully client-side: the entire physics engine, valid-region sweep, 2D polynomial fit, and visualizations run in the browser. No server, no install.

---

## Key Design Principles

Instead of empirically tuning a full lookup map, this system:

1. **Simulates the full valid shot region** at every (distance, radial velocity) cell — not just the center of the goal, but every (speed, angle) pair that scores. This gives a direct measure of shot robustness.
2. **Selects the optimal shot** as the one that maximizes the std-normalized margin from the valid-region boundary along both axes. Ties break on centroid proximity so adjacent cells produce smoothly-varying picks.
3. **Fits a single 2D degree-3 polynomial surface** jointly across all (distance, radial velocity) data using least-squares normal equations solved by Gauss-Jordan with partial pivoting. One surface per output — no per-rv interpolation or table switching at runtime.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.
5. **Compensates for robot motion at runtime** using an iterative virtual-target solver (1690 Orbit technique).

---

## Physics Model

- **Aerodynamic drag** (`C_d = 0.55` for a textured/seamed game piece): `F = ½ ρ C_d A v²`, applied opposite to velocity.
- **Magnus effect**: `|F| = ½ ρ C_m A v ω R`, applied perpendicular to velocity in the lift direction for backspin. `C_m = 0.20` — tune against measured flight data.
- **Spin decay**: backspin decays exponentially in flight: `ω(t) = ω₀ · e^(−k·t)`, `k = 0.5 s⁻¹`. Tune against real shots.
- **Symplectic (semi-implicit) Euler** integration at `DT = 0.002 s`, `MAX_SIM_TIME = 3.0 s`. Velocity updated before position for better energy conservation.
- **Goal geometry**: front lip at 1.83 m, opening radius 0.530 m. Front wall (carpet → `WALL_TOP`) and back wall (rim → `WALL_TOP`) are each 8" tall; crossing either is a miss.
- **Ceiling limit**: any arc that crosses the configured height is rejected (arena truss / scoreboard clearance). Forced on when generating from the Overview tab.

---

## 2D Polynomial Surface

The polynomial surface maps `(distance, radialVelocity) → exitSpeed` and `(distance, radialVelocity) → launchAngle` using a single degree-3 fit across all table data simultaneously.

**Basis** — all monomials `d^a · v^b` with `a + b ≤ 3` (10 terms):

```
1,  d,  v,  d²,  d·v,  v²,  d³,  d²·v,  d·v²,  v³
```

**Fit** — least-squares normal equations `(AᵀA) c = Aᵀy`, solved by Gauss-Jordan with partial pivoting. One solve per output (speed, angle).

**Runtime** — `O(1)` evaluation: `f(d,v) = Σ cᵢ · d^aᵢ · v^bᵢ`. Inputs are clamped to the fitted data range.

---

## Shoot-on-the-Move (1690 Orbit Virtual-Target Solver)

When the robot moves during a shot, the ball carries the robot's velocity. The calculator handles this in two parts:

**Radial velocity** (toward/away from goal) is a table input — the polynomial surface is fitted over `rv ∈ [−3, 3]` m/s, so the shot command already accounts for the robot closing or opening the range.

**Tangential velocity** (perpendicular to the shot line) is compensated at runtime using the iterative virtual-target algorithm:

1. Start with the virtual aim point at the actual goal distance.
2. Evaluate the polynomial at that virtual distance (with `rv = 0`); estimate time-of-flight `t` from horizontal kinematics: `t ≈ vDist / (speed · cos(angle))`.
3. Shift the virtual aim point: `vdx = dist − v_r · t`, `vdz = −v_t · t`.
4. Repeat up to 5 iterations; converges in ≤ 3 once `|Δt| < 2 ms`.
5. **Virtual distance** `= √(vdx² + vdz²)` — query the polynomial here for the final shot command.
6. **Yaw offset** `= atan2(−v_t · t, dist − v_r · t)` — how far to rotate the shooter to cancel lateral drift.

---

## Java Code Generation

After generating a table, click **☕ Generate Java** to produce a ready-to-deploy `ShotCalculator.java` with all polynomial coefficients baked in. The generated file contains:

- `ShotParameters` — immutable result object with three fields:
  - `exitSpeed` (m/s, pre-scaled by `MPS_FACTOR`) — convert to flywheel RPM with your wheel radius.
  - `launchAngle` (degrees, `HOOD_OFFSET_DEG` applied) — command directly to the hood/pivot.
  - `yawOffset` (degrees) — add to current heading before firing; `0` when not moving tangentially.
- `getShotParams(distance, radialVelocity, tangentialVelocity)` — runs the full virtual-target iteration and returns a `ShotParameters`.
- `getShotParams(distance, radialVelocity)` — convenience overload with `tangentialVelocity = 0`.
- `evalPolyRaw(distance, radialVel)` — private helper used by the solver loop and for the final answer.

**Example usage:**

```java
ShotParameters shot = ShotCalculator.getShotParams(distance, radialVel, tangentialVel);
flywheel.setRPM(shot.exitSpeed / wheelCircumference * 60);
hood.setAngle(shot.launchAngle);
drivetrain.addYawOffset(shot.yawOffset);
```

---

## UI Overview

The app opens on the **Overview** tab, which is the primary workflow page.

### Overview (default)
The main workflow page. Left sidebar for configuration; right column is the interactive 3D polynomial surface.

| Sidebar section | What it does |
|---|---|
| Table Generation | Distance range, step counts, spin rate |
| Ceiling | Ceiling height slider — always enabled when generating from this tab |
| Export | Export/import JSON table or polynomial JSON; copy to clipboard; generate Java |
| ▶ Generate Shot Table | Runs the full sweep and polynomial fit; progress bar updates live |

The 3D surface auto-updates after generation. Toggle between **Exit Speed** and **Launch Angle** views; optionally overlay raw table data points.

### Shot Simulation
Single-shot analysis. Sweeps the valid region, picks the optimal shot, draws:
- **Trajectory** view — single ball path or full shot fan (all valid trajectories colored near-to-far rim).
- **Valid Region** view — filled valid envelope in (angle, speed) space with tolerance crosshairs at the optimal shot and shoot-on-move correction when robot is moving.

### Shot Table
Generate and inspect the full table. Charts: Speed Map, Angle Map, Tolerance, Poly Curves (rv slices at −2 / 0 / +2 m/s), and Coefficients (full 2D basis term table). Export/import and Java generation also available here.

### Live Lookup
Query the fitted polynomial at any (distance, radial velocity, lateral velocity) for instant speed/angle/RPM output, including shoot-on-move virtual-target and yaw correction.

### Poly Surface
Standalone full-screen 3D surface viewer with orbit/zoom controls.

**All Chart.js charts**: scroll to zoom · drag to pan · double-click to reset.  
**3D surface**: drag to orbit · scroll to zoom · double-click to reset.

---

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `hood_angle_offset` (°) | Measure real exit angle from slow-mo video; apply constant offset | Shifts every shot angle by a fixed amount |
| `mps_factor` | Adjust until shots go in at any distance | Scales the entire speed command; one knob re-aligns all distances |

Both values are baked into the generated Java at export time.

---

## Running Locally

```bash
cd docs
python -m http.server 8000      # any static file server works
# open http://localhost:8000
```

A static server is required for the Web Worker (Chrome blocks workers on `file://` origins). The app falls back to running on the main thread if the worker is unavailable — slower on large tables but fully functional.

---

## File Layout

```
docs/
  index.html      # 5-tab UI: Overview / Shot Simulation / Shot Table / Live Lookup / Poly Surface
  main.js         # UI logic, chart rendering, Plotly 3D surface, Java code generation
  physics.js      # Ball flight simulation (drag + Magnus + spin decay + wall/ceiling collision)
  shot_table.js   # 2D polynomial solver (least-squares Gauss-Jordan fit + ShotPolynomialSolver)
  worker.js       # Off-thread shot-table generator
  style.css       # Dark blue/purple theme (CSS custom properties)
```

---

## Constants to Update (`physics.js`)

| Constant | Default | Notes |
|---|---|---|
| `GOAL_HEIGHT` | 2.36 m | Goal opening centre height |
| `GOAL_RADIUS` | 0.530 m | Goal opening radius |
| `WALL_HEIGHT` | 0.2032 m | Rim wall height above each edge (8 in) |
| `BALL_RADIUS` | 0.120 m | Game-piece radius |
| `BALL_MASS` | 0.235 kg | Game-piece mass |
| `SHOOTER_HEIGHT` | 0.546 m | Shooter exit height above floor |
| `DRAG_COEFF` | 0.55 | 0.47 for smooth sphere; increase for seamed/textured pieces |
| `MAGNUS_COEFF` | 0.20 | Tune against measured flight data |
| `SPIN_DECAY_RATE` | 0.5 s⁻¹ | Exponential spin decay rate; tune against real shots |
