# FRC 2026 Rebuilt Shot Calculator

Physics-based shot planning for FRC 2026 (Reefscape), inspired by frc4414's approach and the [1690 2022 shot solver presentation](https://www.youtube.com/watch?v=N6ogT5DjGOk).

## Key Design Principles

Instead of empirically tuning a full distance/speed/angle lookup map, this system:

1. **Simulates the full valid shot region** at each (distance, radial velocity) — not just the center of the goal, but all shots that land between the close and far rim. This gives a measure of shot robustness/tolerance.
2. **Selects the optimal shot** as the one that maximizes the std-normalized margin between exit-velocity and launch-angle error, i.e. the shot deepest inside the valid region along its weaker axis.
3. **Fits polynomials** across distance space for O(1) real-time lookup.
4. **Reduces tuning to two scalar parameters** that correct the entire shot envelope at once.

## Physics Model

- Aerodynamic drag (`C_d = 0.47` for a sphere)
- Magnus effect (backspin produces upward lift, softens the shot)
- Configurable spin rate, ball mass, and ball radius

## Tuning (Two Parameters)

| Parameter | How to tune | Effect |
|---|---|---|
| `hood_angle_offset` | Measure real exit angle from slow-mo video, apply constant offset | Shifts all shot angles by a fixed amount |
| `mps_factor` | "Fudge" until balls go in at any distance | Scales the entire rps→mps conversion; one knob fixes all distances |

As balls wear in, a tiny `mps_factor` adjustment re-aligns the full shot range — far simpler than re-tuning a full empirical map.

## Usage

### GUI App

```bash
pip install -r requirements.txt
python src/app.py
```

### CLI

```bash
# Simulate a single shot
python src/cli.py simulate --dist 5.0 --speed 8.0 --angle 30 --plot traj.png

# Generate and save a shot table
python src/cli.py table --dist-min 1.5 --dist-max 8.0 --steps 20 --output table.json --plot curves.png

# Query a saved table
python src/cli.py lookup --table table.json --dist 4.5 --rv 1.0
```

## File Layout

```
src/
  physics.py      # Ball flight simulation (drag + Magnus)
  shot_table.py   # Table generator + polynomial solver
  app.py          # Tkinter GUI
  cli.py          # Command-line interface
```

## Constants to Update

Before running, update `src/physics.py` with your robot's actual values:

- `GOAL_HEIGHT` — height of goal center above floor (m)
- `GOAL_RADIUS` — goal opening radius (m)
- `BALL_RADIUS` / `BALL_MASS` — 2026 game piece dimensions
- `SHOOTER_HEIGHT` — your shooter exit height above floor (m)
- `SPIN_RATE_RPS` — your shooter's backspin
