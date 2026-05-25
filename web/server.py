"""
Flask web server for the FRC 2026 Shot Calculator.
Run: python web/server.py
"""
import sys
import os
import json
import queue
import threading
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from physics import simulate_shot, find_valid_shots, select_optimal_shot, GOAL_HEIGHT, GOAL_RADIUS, RIM_HEIGHT, WALL_TOP, SHOOTER_HEIGHT
from shot_table import ShotTableGenerator, ShotPolynomialSolver, TuningParams

# Sweep range used by the Simulate tab. The shot-table generator keeps the
# broader physics defaults so it can find valid shots at any distance.
SIM_SPEED_RANGE = (7.5, 15.0)
SIM_ANGLE_RANGE = (35.0, 75.0)

app = Flask(__name__, template_folder="templates", static_folder="static")

# Server-side state (one table/solver instance per session is fine for a team tool)
_state = {
    "table": [],
    "solver": None,
    "tuning": TuningParams(),
    "table_generated": False,
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    """Simulate a shot. If speed/angle are omitted, auto-picks the optimal."""
    data = request.json
    dist   = float(data["distance"])
    rv     = float(data.get("radial_vel", 0.0))
    spin   = float(data.get("spin", 50.0))
    drag   = bool(data.get("drag", True))
    magnus = bool(data.get("magnus", True))

    speed_in = data.get("speed")
    angle_in = data.get("angle")
    auto = speed_in is None or angle_in is None
    valid_count = None

    if auto:
        valid = find_valid_shots(
            distance=dist, robot_radial_vel=rv, spin_rps=spin,
            speed_range=SIM_SPEED_RANGE, angle_range=SIM_ANGLE_RANGE,
        )
        valid_count = len(valid)
        optimal = select_optimal_shot(valid)
        if not optimal:
            return jsonify({
                "no_valid_shots": True,
                "rim_height":  round(RIM_HEIGHT, 4),
                "wall_top":    round(WALL_TOP, 4),
                "goal_x_near": round(dist - GOAL_RADIUS, 4),
                "goal_x_far":  round(dist + GOAL_RADIUS, 4),
            })
        speed = float(optimal["speed"])
        angle = float(optimal["angle"])
    else:
        speed = float(speed_in)
        angle = float(angle_in)

    result = simulate_shot(
        distance=dist, exit_speed=speed, launch_angle_deg=angle,
        spin_rps=spin, robot_radial_vel=rv,
        include_drag=drag, include_magnus=magnus,
    )
    return jsonify({
        "hit": bool(result.hit),
        "x_final": round(float(result.x_final), 4),
        "y_final": round(float(result.y_final), 4),
        "tof": round(float(result.time_of_flight), 4),
        "exit_speed":  round(speed, 3),
        "launch_angle": round(angle, 2),
        "auto":        auto,
        "valid_count": valid_count,
        "rim_height":  round(RIM_HEIGHT, 4),
        "wall_top":    round(WALL_TOP, 4),
        "goal_x_near": round(dist - GOAL_RADIUS, 4),
        "goal_x_far":  round(dist + GOAL_RADIUS, 4),
        "trajectory_x": result.trajectory_x.tolist()[::3],
        "trajectory_y": result.trajectory_y.tolist()[::3],
    })


@app.route("/api/valid_region", methods=["POST"])
def api_valid_region():
    data = request.json
    valid = find_valid_shots(
        distance=float(data["distance"]),
        robot_radial_vel=float(data.get("radial_vel", 0.0)),
        spin_rps=float(data.get("spin", 50.0)),
        speed_range=SIM_SPEED_RANGE,
        angle_range=SIM_ANGLE_RANGE,
    )
    optimal = select_optimal_shot(valid)
    speeds = [s["speed"] for s in valid]
    angles = [s["angle"] for s in valid]
    return jsonify({
        "count": len(valid),
        "shots": [{"speed": round(s["speed"], 3), "angle": round(s["angle"], 2),
                   "y_final": round(s["y_final"], 4)} for s in valid],
        "optimal": {
            "speed": round(optimal["speed"], 3),
            "angle": round(optimal["angle"], 2),
        } if optimal else None,
        "speed_std": round(float(np.std(speeds)), 3) if speeds else 0,
        "angle_std": round(float(np.std(angles)), 2) if angles else 0,
    })


@app.route("/api/shot_fan", methods=["POST"])
def api_shot_fan():
    """Return full trajectory for every valid shot (downsampled) + optimal trajectory."""
    data = request.json
    dist = float(data["distance"])
    rv   = float(data.get("radial_vel", 0.0))
    spin = float(data.get("spin", 50.0))
    drag   = bool(data.get("drag", True))
    magnus = bool(data.get("magnus", True))

    valid   = find_valid_shots(
        distance=dist, robot_radial_vel=rv, spin_rps=spin,
        speed_range=SIM_SPEED_RANGE, angle_range=SIM_ANGLE_RANGE,
    )
    optimal = select_optimal_shot(valid)

    def traj_for(speed, angle):
        r = simulate_shot(
            distance=dist, exit_speed=speed, launch_angle_deg=angle,
            spin_rps=spin, robot_radial_vel=rv,
            include_drag=drag, include_magnus=magnus,
        )
        step = max(1, len(r.trajectory_x) // 60)
        return {
            "tx": r.trajectory_x[::step].tolist(),
            "ty": r.trajectory_y[::step].tolist(),
            "x_final": round(float(r.x_final), 4),
            "y_final": round(float(r.y_final), 4),
        }

    trajectories = []
    for s in valid:
        t = traj_for(s["speed"], s["angle"])
        trajectories.append({
            "speed": round(s["speed"], 3),
            "angle": round(s["angle"], 2),
            **t,
        })

    opt_traj = None
    if optimal:
        t = traj_for(optimal["speed"], optimal["angle"])
        opt_traj = {
            "speed": round(optimal["speed"], 3),
            "angle": round(optimal["angle"], 2),
            **t,
        }

    return jsonify({
        "trajectories": trajectories,
        "optimal": opt_traj,
        "rim_height":  round(RIM_HEIGHT, 4),
        "wall_top":    round(WALL_TOP, 4),
        "goal_x_near": round(dist - GOAL_RADIUS, 4),
        "goal_x_far":  round(dist + GOAL_RADIUS, 4),
        "distance": dist,
    })


@app.route("/api/generate_table", methods=["POST"])
def api_generate_table():
    data = request.json
    tuning = TuningParams(
        hood_angle_offset=float(data.get("hood_angle_offset", 0.0)),
        mps_factor=float(data.get("mps_factor", 1.0)),
        spin_rps=float(data.get("spin_rps", 50.0)),
    )
    _state["tuning"] = tuning

    q: queue.Queue = queue.Queue()

    def run():
        gen = ShotTableGenerator(
            distance_range=(float(data.get("dist_min", 1.5)), float(data.get("dist_max", 8.0))),
            distance_steps=int(data.get("dist_steps", 20)),
            radial_vel_range=(-3.0, 3.0),
            radial_vel_steps=int(data.get("rv_steps", 7)),
            tuning=tuning,
        )

        # Patch generate to emit progress
        total_cells = gen.distance_steps * gen.radial_vel_steps
        done = [0]
        original_generate = gen.generate

        import numpy as _np
        from physics import find_valid_shots as fvs, select_optimal_shot as sos
        from shot_table import ShotTableEntry
        distances = _np.linspace(gen.distance_range[0], gen.distance_range[1], gen.distance_steps)
        radial_vels = _np.linspace(gen.radial_vel_range[0], gen.radial_vel_range[1], gen.radial_vel_steps)
        table = []
        for dist in distances:
            for rv in radial_vels:
                valid = fvs(distance=dist, robot_radial_vel=rv, spin_rps=tuning.spin_rps)
                optimal = sos(valid)
                if optimal:
                    sp = [s["speed"] for s in valid]
                    an = [s["angle"] for s in valid]
                    entry = ShotTableEntry(
                        distance=dist, radial_velocity=rv,
                        exit_speed=optimal["speed"] * tuning.mps_factor,
                        launch_angle=optimal["angle"] + tuning.hood_angle_offset,
                        tolerance_speed=float(_np.std(sp)),
                        tolerance_angle=float(_np.std(an)),
                        valid_count=len(valid),
                    )
                else:
                    entry = ShotTableEntry(
                        distance=dist, radial_velocity=rv,
                        exit_speed=0.0, launch_angle=0.0,
                        tolerance_speed=0.0, tolerance_angle=0.0,
                        valid_count=0,
                    )
                table.append(entry)
                done[0] += 1
                q.put({"progress": round(100 * done[0] / total_cells)})

        _state["table"] = table
        solver = ShotPolynomialSolver(degree=4)
        solver.fit(table)
        _state["solver"] = solver
        _state["table_generated"] = True
        q.put({"done": True})

    threading.Thread(target=run, daemon=True).start()

    def stream():
        while True:
            item = q.get()
            yield f"data: {json.dumps(item)}\n\n"
            if item.get("done"):
                break

    return Response(stream_with_context(stream()), mimetype="text/event-stream")


@app.route("/api/table_data", methods=["GET"])
def api_table_data():
    if not _state["table_generated"]:
        return jsonify({"error": "No table generated yet"}), 400
    table = _state["table"]
    return jsonify({
        "entries": [
            {
                "distance": round(e.distance, 3),
                "radial_velocity": round(e.radial_velocity, 3),
                "exit_speed": round(e.exit_speed, 3),
                "launch_angle": round(e.launch_angle, 3),
                "tolerance_speed": round(e.tolerance_speed, 3),
                "tolerance_angle": round(e.tolerance_angle, 3),
                "valid_count": e.valid_count,
            }
            for e in table
        ]
    })


@app.route("/api/lookup", methods=["POST"])
def api_lookup():
    if not _state["table_generated"]:
        return jsonify({"error": "No table. Generate one first."}), 400
    data = request.json
    dist = float(data["distance"])
    rv = float(data.get("radial_vel", 0.0))
    solver = _state["solver"]
    tuning = _state["tuning"]
    speed, angle = solver.predict(dist, rv)
    rpm = solver.speed_to_rpm(speed, tuning, dist)
    return jsonify({
        "exit_speed": round(speed, 3),
        "launch_angle": round(angle, 2),
        "flywheel_rpm": round(rpm),
        "tuning": {
            "hood_angle_offset": tuning.hood_angle_offset,
            "mps_factor": tuning.mps_factor,
            "spin_rps": tuning.spin_rps,
        },
    })


@app.route("/api/poly_curves", methods=["GET"])
def api_poly_curves():
    if not _state["table_generated"]:
        return jsonify({"error": "No table"}), 400
    table = _state["table"]
    valid = [e for e in table if e.valid_count > 0]
    if not valid:
        return jsonify({"error": "No valid entries"}), 400

    dist_min = min(e.distance for e in valid)
    dist_max = max(e.distance for e in valid)
    dists = np.linspace(dist_min, dist_max, 80).tolist()
    solver = _state["solver"]
    curves = {}
    for rv in [-2.0, 0.0, 2.0]:
        speeds = [round(solver.predict(d, rv)[0], 3) for d in dists]
        angles = [round(solver.predict(d, rv)[1], 2) for d in dists]
        curves[str(rv)] = {"speeds": speeds, "angles": angles}
    return jsonify({"distances": [round(d, 3) for d in dists], "curves": curves})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
