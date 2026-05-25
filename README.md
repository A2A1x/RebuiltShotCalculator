# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Rebuilt), inspired by frc4414's approach and the [1690 2022 shot solver presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

Fully client-side: the entire physics engine, valid-region sweep, polynomial fit, and visualizations run in the browser. No server, no install.

## Key Design Principles

Instead of empirically tuning a full distance/speed/angle lookup map, this system:

1. **Simulates the full valid shot region** at each (distance, radial velocity) — not just the center of the goal, but all shots that land between the close and far rim. This gives a measure of shot robustness/tolerance.
2. **Selects the optimal shot** as the one that maximizes the std-normalized margin between exit-velocity and launch-angle error, i.e. the shot deepest inside the valid region along its weaker axis.
3. **Fits polynomials** across distance space for O(1) real-time lookup.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.

## Physics Model

- Aerodynamic drag (`C_d = 0.47` for a sphere)
- Magnus effect (backspin produces lift perpendicular to velocity)
- Configurable spin rate, ball mass, and ball radius

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `hood_angle_offset` | Measure real exit angle from slow-mo video, apply constant offset | Shifts all shot angles by a fixed amount |
| `mps_factor` | "Fudge" until balls go in at any distance | Scales the entire rps→mps conversion; one knob fixes all distances |

As balls wear in, a tiny `mps_factor` adjustment re-aligns the full shot range — far simpler than re-tuning a full empirical map.

## Usage

### Hosted

Open the GitHub Pages site — everything is in `docs/`, served as static files.

### Local

```bash
cd docs
python -m http.server 8000      # any static file server works
# then open http://localhost:8000
```

A static server is needed (rather than opening `index.html` directly) because the shot-table generator uses a Web Worker, which Chrome blocks on `file://` origins. The app falls back to running on the main thread if the worker fails to load, but the hosted/local-server path is faster.

## File Layout

```
docs/
  index.html       # UI: Simulate / Shot Table / Live Lookup tabs
  main.js          # UI glue, chart rendering, inline-table fallback
  physics.js       # Ball flight simulation (drag + Magnus)
  shot_table.js    # Polynomial solver
  worker.js        # Off-thread shot-table generator
  style.css
```

## Constants to Update

Before deploying for your robot, edit the constants at the top of `docs/physics.js`:

- `GOAL_HEIGHT` — height of goal center above floor (m)
- `GOAL_RADIUS` — goal opening radius (m)
- `BALL_RADIUS` / `BALL_MASS` — 2026 game piece dimensions
- `SHOOTER_HEIGHT` — your shooter exit height above floor (m)
