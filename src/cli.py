"""
CLI interface for the shot calculator.
Usage examples:
  python cli.py simulate --dist 5.0 --speed 12 --angle 45
  python cli.py table --dist-min 1.5 --dist-max 8.0 --steps 20 --output table.json
  python cli.py lookup --table table.json --dist 4.5 --rv 1.0
"""
import argparse
import sys
import os
import json
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from physics import simulate_shot, find_valid_shots, select_optimal_shot, GOAL_HEIGHT, GOAL_RADIUS
from shot_table import ShotTableGenerator, ShotPolynomialSolver, TuningParams


def cmd_simulate(args):
    print(f"\nSimulating shot: dist={args.dist}m  speed={args.speed}m/s  angle={args.angle}°  rv={args.rv}m/s")
    result = simulate_shot(
        distance=args.dist,
        exit_speed=args.speed,
        launch_angle_deg=args.angle,
        robot_radial_vel=args.rv,
    )
    status = "HIT" if result.hit else "MISS"
    print(f"Result:          {status}")
    print(f"Y at goal:       {result.y_final:.4f} m")
    print(f"Goal window:     {GOAL_HEIGHT - GOAL_RADIUS:.4f} – {GOAL_HEIGHT + GOAL_RADIUS:.4f} m")
    print(f"Time of flight:  {result.time_of_flight:.3f} s")

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.figure(figsize=(10, 4))
        plt.plot(result.trajectory_x, result.trajectory_y)
        plt.axhline(GOAL_HEIGHT, color="orange", linestyle="--", label="Goal center")
        plt.axhline(GOAL_HEIGHT + GOAL_RADIUS, color="green", linestyle=":", label="Goal rim")
        plt.axhline(GOAL_HEIGHT - GOAL_RADIUS, color="green", linestyle=":")
        plt.xlabel("Distance (m)")
        plt.ylabel("Height (m)")
        plt.title(f"Trajectory — {status}")
        plt.legend()
        plt.tight_layout()
        out = args.plot
        plt.savefig(out, dpi=120)
        print(f"Plot saved to:   {out}")


def cmd_table(args):
    tuning = TuningParams(
        hood_angle_offset=args.hood_offset,
        mps_factor=args.mps_factor,
        spin_rps=args.spin,
    )
    gen = ShotTableGenerator(
        distance_range=(args.dist_min, args.dist_max),
        distance_steps=args.steps,
        radial_vel_range=(-3.0, 3.0),
        radial_vel_steps=args.rv_steps,
        tuning=tuning,
    )
    print(f"\nGenerating shot table: {args.dist_min}–{args.dist_max}m, {args.steps} steps...")
    table = gen.generate(verbose=True)
    valid = [e for e in table if e.valid_count > 0]
    print(f"Entries: {len(table)} total, {len(valid)} with valid shots")

    if args.output:
        gen.save(args.output)
        print(f"Saved to: {args.output}")

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        dists = sorted(set(e.distance for e in valid))
        speeds = [next(e.exit_speed for e in valid if abs(e.distance - d) < 0.01 and abs(e.radial_velocity) < 0.01) for d in dists]
        angles = [next(e.launch_angle for e in valid if abs(e.distance - d) < 0.01 and abs(e.radial_velocity) < 0.01) for d in dists]
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4))
        ax1.plot(dists, speeds, "o-")
        ax1.set_xlabel("Distance (m)")
        ax1.set_ylabel("Exit Speed (m/s)")
        ax1.set_title("Speed vs Distance (rv=0)")
        ax2.plot(dists, angles, "o-", color="orange")
        ax2.set_xlabel("Distance (m)")
        ax2.set_ylabel("Launch Angle (°)")
        ax2.set_title("Angle vs Distance (rv=0)")
        plt.tight_layout()
        plt.savefig(args.plot, dpi=120)
        print(f"Plot saved to: {args.plot}")


def cmd_lookup(args):
    _, table = ShotTableGenerator.load(args.table)
    solver = ShotPolynomialSolver(degree=4)
    solver.fit(table)
    tuning = TuningParams()

    speed, angle = solver.predict(args.dist, args.rv)
    rpm = solver.speed_to_rpm(speed, tuning, args.dist)

    print(f"\nShot lookup: dist={args.dist}m  rv={args.rv:+.2f}m/s")
    print(f"  Exit speed:   {speed:.3f} m/s")
    print(f"  Launch angle: {angle:.2f}°")
    print(f"  Flywheel RPM: {rpm:.0f}")


def main():
    parser = argparse.ArgumentParser(description="FRC 2026 Shot Calculator CLI")
    sub = parser.add_subparsers(dest="command")

    # simulate
    p = sub.add_parser("simulate", help="Simulate a single shot")
    p.add_argument("--dist", type=float, default=5.0)
    p.add_argument("--speed", type=float, default=12.0)
    p.add_argument("--angle", type=float, default=45.0)
    p.add_argument("--rv", type=float, default=0.0, help="Robot radial velocity (m/s)")
    p.add_argument("--plot", metavar="FILE", help="Save trajectory plot to file")

    # table
    p = sub.add_parser("table", help="Generate shot table")
    p.add_argument("--dist-min", type=float, default=1.5)
    p.add_argument("--dist-max", type=float, default=8.0)
    p.add_argument("--steps", type=int, default=20)
    p.add_argument("--rv-steps", type=int, default=7)
    p.add_argument("--hood-offset", type=float, default=0.0)
    p.add_argument("--mps-factor", type=float, default=1.0)
    p.add_argument("--spin", type=float, default=50.0)
    p.add_argument("--output", metavar="FILE", help="Save table to JSON")
    p.add_argument("--plot", metavar="FILE", help="Save plot to file")

    # lookup
    p = sub.add_parser("lookup", help="Query a saved shot table")
    p.add_argument("--table", required=True, metavar="FILE")
    p.add_argument("--dist", type=float, required=True)
    p.add_argument("--rv", type=float, default=0.0)

    args = parser.parse_args()
    if args.command == "simulate":
        cmd_simulate(args)
    elif args.command == "table":
        cmd_table(args)
    elif args.command == "lookup":
        cmd_lookup(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
