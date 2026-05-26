# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Rebuilt), inspired by frc4414's approach and the [1690 2022 shot solver presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

Fully client-side: the entire physics engine, valid-region sweep, polynomial fit, and visualizations run in the browser. No server, no install.

## Key Design Principles

Instead of empirically tuning a full distance/speed/angle lookup map, this system:

1. **Simulates the full valid shot region** at each (distance, radial velocity) — not just the center of the goal, but every (speed, angle) pair that scores. This gives a direct measure of shot robustness.
2. **Selects the optimal shot** as the one that maximizes the std-normalized margin between exit-velocity and launch-angle error — the shot deepest inside the valid region along its weaker axis. Ties break on centroid proximity so adjacent (distance, rv) cells produce smoothly-varying picks.
3. **Fits polynomials** across distance space for O(1) real-time lookup.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.

## Physics Model

- Aerodynamic drag (`C_d = 0.47` for a sphere): `F = ½ ρ C_d A v²`, applied opposite to velocity.
- Magnus effect: `|F| = ½ ρ C_m A v ω R`, applied perpendicular to velocity in the lift direction for backspin (linear approximation to the standard `½ ρ v² A C_L` form).
- Forward-Euler integration at `DT = 0.002 s`, `MAX_SIM_TIME = 3.0 s`.
- Goal geometry: front lip at 1.83 m, back lip at the same height, opening radius 0.530 m. The **front wall** extends from carpet to wall-top — any trajectory crossing it below `WALL_TOP` is a miss. The **back wall** sits between rim and wall-top; crossing it is also a miss. Both walls are 8" tall.
- Optional **ceiling**: if enabled, any shot whose arc crosses a chosen height is rejected (useful for modelling arena trusses or scoreboard clearance).

## Usage

The UI has three tabs:

- **Shot Simulation** — enter distance, robot radial velocity, spin rate, optional ceiling. Click **Simulate Shot** and the app sweeps the speed × angle envelope, picks the most error-tolerant shot via the boundary-margin scoring, and draws its trajectory. **Valid Region** shows the entire fan of scoring shots and the filled valid envelope.
- **Shot Table** — generates the full distance × radial-velocity table by running the same valid-region sweep at every cell, then fits a degree-4 polynomial per radial-velocity level. Heatmaps show speed, angle, and tolerance across the operating envelope. Export/import as JSON.
- **Live Lookup** — query the fitted polynomial at any (distance, radial velocity) for instant speed/angle output.

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `hood_angle_offset` | Measure real exit angle from slow-mo video, apply constant offset | Shifts all shot angles by a fixed amount |
| `mps_factor` | "Fudge" until balls go in at any distance | Scales the entire rps→mps conversion; one knob fixes all distances |

As balls wear in, a tiny `mps_factor` adjustment re-aligns the full shot range — far simpler than re-tuning a full empirical map.

## Running it

### Hosted

Open the GitHub Pages site — everything is in `docs/`, served as static files.

### Local

```bash
cd docs
python -m http.server 8000      # any static file server works
# then open http://localhost:8000
```

A static server is preferred because the shot-table generator uses a Web Worker, which Chrome blocks on `file://` origins. The app falls back to running on the main thread if the worker fails to load, so opening `index.html` directly still works — just slower and on-thread.

## File Layout

```
docs/
  index.html       # UI: Simulate / Shot Table / Live Lookup tabs
  main.js          # UI glue, chart rendering, inline-table fallback
  physics.js       # Ball flight simulation (drag + Magnus + collision)
  shot_table.js    # Polynomial solver (least-squares Vandermonde fit)
  worker.js        # Off-thread shot-table generator
  style.css
```

## Constants to Update

Before deploying for your robot, edit the constants at the top of `docs/physics.js`:

- `GOAL_HEIGHT`, `GOAL_RADIUS` — goal opening center height and radius (m)
- `WALL_HEIGHT` — height of the wall above each rim edge (m)
- `BALL_RADIUS` / `BALL_MASS` — 2026 game-piece dimensions
- `SHOOTER_HEIGHT` — your shooter exit height above floor (m)
- `MAGNUS_COEFF` — leave at 0.20 to start; tune against measured flight data if needed
