# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Rebuilt), inspired by frc4414's approach and the [1690 Orbit shoot-on-the-move presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

Fully client-side: the entire physics engine, valid-region sweep, polynomial fit, and visualizations run in the browser. No server, no install.

## Key Design Principles

Instead of empirically tuning a full distance/speed/angle lookup map, this system:

1. **Simulates the full valid shot region** at each (distance, radial velocity) — not just the center of the goal, but every (speed, angle) pair that scores. This gives a direct measure of shot robustness.
2. **Selects the optimal shot** as the one that maximizes the std-normalized margin between exit-velocity and launch-angle error — the shot deepest inside the valid region along its weaker axis. Ties break on centroid proximity so adjacent (distance, rv) cells produce smoothly-varying picks.
3. **Fits degree-2 polynomials** across distance space per radial-velocity level for O(1) real-time lookup.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.
5. **Compensates for robot motion at runtime** using an iterative virtual-target solver (1690 Orbit technique): tangential velocity produces a yaw offset; radial velocity is baked into both the table and the virtual-target distance.

## Physics Model

- **Aerodynamic drag** (`C_d = 0.55` for a textured/seamed game piece): `F = ½ ρ C_d A v²`, applied opposite to velocity.
- **Magnus effect**: `|F| = ½ ρ C_m A v ω R`, applied perpendicular to velocity in the lift direction for backspin. `C_m = 0.20` — tune against measured flight data if needed.
- **Spin decay**: backspin decays exponentially in flight at `SPIN_DECAY_RATE = 0.5 s⁻¹` (ω(t) = ω₀·e^(−k·t)). Tune against real shots.
- **Symplectic (semi-implicit) Euler** integration at `DT = 0.002 s`, `MAX_SIM_TIME = 3.0 s`. Velocity is updated before position, giving better energy conservation than forward Euler.
- Goal geometry: front lip at 1.83 m, opening radius 0.530 m. The **front wall** extends from carpet to `WALL_TOP` — any trajectory crossing it below that height is a miss. The **back wall** sits between rim and `WALL_TOP`; crossing it is also a miss. Both walls are 8" tall.
- Optional **ceiling**: any shot whose arc crosses the chosen height is rejected (useful for arena trusses or scoreboard clearance).

## Shoot-on-the-Move (1690 Orbit Virtual-Target Solver)

When the robot is moving during a shot, the ball carries the robot's velocity. The calculator models this in two parts:

**Radial velocity** (toward/away from goal) is a table parameter — the sweep and polynomial fit are generated across `rv ∈ [−3, 3]` m/s, so the shot command already accounts for the robot closing or opening the range.

**Lateral velocity** (perpendicular to the shot direction) cannot be pre-tabulated; it is compensated at runtime. The calculator uses the iterative virtual-target algorithm:

1. Aim at the actual goal distance; simulate the optimal shot; record time-of-flight `t`.
2. Shift the virtual target: `(dist − v_r · t, −v_l · t)` in the floor plane.
3. Re-simulate to the virtual distance; update `t`. Repeat up to 5 times (converges in ≤3).
4. The converged **virtual distance** is what you query the shot table with.
5. The **yaw offset** = `atan2(−v_l · t, dist − v_r · t)` — how far to rotate the shooter to cancel lateral drift.

The Simulate and Live Lookup tabs display the virtual distance and yaw offset whenever either velocity is non-zero.

## Usage

The UI has three tabs:

- **Shot Simulation** — enter distance, robot radial velocity, robot lateral velocity, spin rate, and optional ceiling. Click **Simulate Shot** and the app sweeps the speed × angle envelope, picks the most error-tolerant shot, and draws its trajectory. When either robot velocity is non-zero, a **Shoot-on-Move** section shows the virtual target distance and required yaw offset. **Valid Region** shows the full fan of scoring trajectories and the filled valid envelope with tolerance crosshairs.
- **Shot Table** — generates the full distance × radial-velocity table by running the valid-region sweep at every cell, then fits a degree-2 polynomial per rv level. Heatmaps show speed, angle, and tolerance. Export/import as JSON.
- **Live Lookup** — query the fitted polynomial at any (distance, radial velocity, lateral velocity) for instant speed/angle/yaw output.

All charts support **scroll to zoom**, **drag to pan**, and **double-click to reset**.

## Valid Region Chart

The Valid Region chart shows the scoring envelope in (launch angle, launch speed) space:

- **Green curve (far rim)** — upper speed boundary at each angle: the fastest shot that still lands inside the far side of the goal.
- **Red curve (close rim)** — lower speed boundary: the slowest shot that clears the near rim.
- **Shaded region** — all valid (angle, speed) combinations.
- **Orange vertical bar** — speed tolerance at the optimal angle: spans exactly from close rim to far rim.
- **Purple horizontal bar** — angle tolerance at the optimal speed: spans exactly the contiguous angle range where the optimal speed falls inside the valid band.
- **Blue star** — the optimal shot (deepest inside the valid region along its weaker axis).

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `hood_angle_offset` | Measure real exit angle from slow-mo video, apply constant offset | Shifts all shot angles by a fixed amount |
| `mps_factor` | Adjust until balls go in at any distance | Scales the entire speed command; one knob fixes all distances |

As balls wear in, a small `mps_factor` adjustment re-aligns the full shot range.

## Running Locally

```bash
cd docs
python -m http.server 8000      # any static file server works
# then open http://localhost:8000
```

A static server is preferred because the shot-table generator uses a Web Worker, which Chrome blocks on `file://` origins. The app falls back to running on the main thread if the worker fails, so opening `index.html` directly still works — just slower and on-thread.

## File Layout

```
docs/
  index.html       # UI: Simulate / Shot Table / Live Lookup tabs
  main.js          # UI glue, chart rendering, inline-table fallback
  physics.js       # Ball flight simulation (drag + Magnus + spin decay + collision)
  shot_table.js    # Polynomial solver (least-squares Vandermonde fit)
  worker.js        # Off-thread shot-table generator
  style.css
```

## Constants to Update

Before deploying, edit the constants at the top of `docs/physics.js`:

| Constant | Default | Notes |
|---|---|---|
| `GOAL_HEIGHT` | 2.36 m | Goal opening center height |
| `GOAL_RADIUS` | 0.530 m | Goal opening radius |
| `WALL_HEIGHT` | 0.2032 m | Rim wall height above each edge (8 in) |
| `BALL_RADIUS` | 0.120 m | Game-piece radius |
| `BALL_MASS` | 0.235 kg | Game-piece mass |
| `SHOOTER_HEIGHT` | 0.546 m | Your shooter exit height above floor |
| `DRAG_COEFF` | 0.55 | 0.47 for smooth sphere; higher for seamed/textured pieces |
| `MAGNUS_COEFF` | 0.20 | Tune against measured flight data |
| `SPIN_DECAY_RATE` | 0.5 s⁻¹ | Exponential spin decay rate; tune against real shots |
