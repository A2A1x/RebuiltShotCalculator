"""
Ball flight physics engine.
Simulates projectile with aerodynamic drag and Magnus (spin) effect.
Based on frc4414 2026 approach - simulate all shots hitting close/far rim.
"""
import numpy as np
from dataclasses import dataclass
from typing import Optional


# ── 2026 Reefscape game geometry (meters) ──────────────────────────────────
# NOTE: Update these constants to match your robot's actual shooter geometry
# and the 2026 game's goal dimensions.

GOAL_HEIGHT = 2.36          # Height of goal opening center above floor (m)
                            # = front lip (1.83 m) + half opening diameter (0.530 m)
GOAL_DEPTH = 1.059          # Front-to-back depth of hexagonal opening (m) = 41.7 in
GOAL_RADIUS = 0.530         # Radius of hexagonal opening (m) = 41.7 in / 2
RIM_HEIGHT  = GOAL_HEIGHT - GOAL_RADIUS  # Front lip height = 1.83 m (72 in); ball must descend through this
WALL_HEIGHT = 4 * 0.0254                # 4 in rim walls above each rim edge = 0.1016 m
WALL_TOP    = RIM_HEIGHT + WALL_HEIGHT  # Top of rim walls = 1.9316 m
BALL_RADIUS = 0.120         # Ball radius (m) - adjust for 2026 game piece
BALL_MASS = 0.235           # Ball mass (kg)
BALL_MOMENT_INERTIA = 0.4 * BALL_MASS * BALL_RADIUS**2  # Solid sphere approx

# Aerodynamic constants
AIR_DENSITY = 1.225         # kg/m³ at sea level
DRAG_COEFF = 0.47           # Sphere drag coefficient
MAGNUS_COEFF = 0.20         # Magnus lift coefficient (tunable)
BALL_CROSS_SECTION = np.pi * BALL_RADIUS**2

# Shooter geometry
SHOOTER_HEIGHT = 0.546      # Height of shooter exit above floor (m) = 21.5 in
SPIN_RATE_RPS = 50.0        # Default backspin (rev/s) - tune empirically

GRAVITY = 9.81              # m/s²
DT = 0.001                  # Simulation timestep (s)
MAX_SIM_TIME = 3.0          # Max flight time (s)


@dataclass
class BallState:
    x: float       # Horizontal distance from shooter (m)
    y: float       # Height above floor (m)
    vx: float      # Horizontal velocity (m/s)
    vy: float      # Vertical velocity (m/s)


@dataclass
class ShotResult:
    hit: bool
    x_final: float
    y_final: float
    time_of_flight: float
    trajectory_x: np.ndarray
    trajectory_y: np.ndarray


def simulate_shot(
    distance: float,
    exit_speed: float,
    launch_angle_deg: float,
    spin_rps: float = SPIN_RATE_RPS,
    robot_radial_vel: float = 0.0,
    include_magnus: bool = True,
    include_drag: bool = True,
) -> ShotResult:
    """
    Simulate a single ball trajectory.

    Args:
        distance: Horizontal distance to goal center (m)
        exit_speed: Ball speed at shooter exit (m/s)
        launch_angle_deg: Launch angle above horizontal (degrees)
        spin_rps: Backspin on ball (rev/s, positive = backspin)
        robot_radial_vel: Robot velocity toward goal (m/s), added to vx
        include_magnus: Enable Magnus effect
        include_drag: Enable aerodynamic drag

    Returns:
        ShotResult with hit detection and trajectory
    """
    angle_rad = np.radians(launch_angle_deg)
    vx = exit_speed * np.cos(angle_rad) + robot_radial_vel
    vy = exit_speed * np.sin(angle_rad)

    x = 0.0
    y = SHOOTER_HEIGHT
    t = 0.0

    traj_x = [x]
    traj_y = [y]

    omega = 2 * np.pi * spin_rps

    # Track when the ball descends back through the rim plane.
    # SHOOTER_HEIGHT (0.546 m) < RIM_HEIGHT (1.83 m), so starts False.
    was_above_rim = y >= RIM_HEIGHT
    prev_x, prev_y = x, y

    front_wall_x = distance - GOAL_RADIUS
    back_wall_x  = distance + GOAL_RADIUS

    while t < MAX_SIM_TIME:
        v = np.sqrt(vx**2 + vy**2)

        if include_drag and v > 0:
            drag_force = 0.5 * AIR_DENSITY * DRAG_COEFF * BALL_CROSS_SECTION * v**2
            ax_drag = -(drag_force / BALL_MASS) * (vx / v)
            ay_drag = -(drag_force / BALL_MASS) * (vy / v)
        else:
            ax_drag = ay_drag = 0.0

        if include_magnus and v > 0:
            magnus_force = 0.5 * AIR_DENSITY * MAGNUS_COEFF * BALL_CROSS_SECTION * omega * BALL_RADIUS * v
            ay_magnus = magnus_force / BALL_MASS
        else:
            ay_magnus = 0.0

        vx += (ax_drag) * DT
        vy += (-GRAVITY + ay_drag + ay_magnus) * DT
        prev_x, prev_y = x, y
        x += vx * DT
        y += vy * DT
        t += DT

        traj_x.append(x)
        traj_y.append(y)

        # Front wall: x-crossing at near rim while y in wall range → miss
        if prev_x < front_wall_x <= x:
            frac = (front_wall_x - prev_x) / (x - prev_x + 1e-12)
            y_at_wall = prev_y + frac * (y - prev_y)
            if RIM_HEIGHT <= y_at_wall <= WALL_TOP:
                return ShotResult(
                    hit=False, x_final=front_wall_x, y_final=y_at_wall,
                    time_of_flight=t,
                    trajectory_x=np.array(traj_x),
                    trajectory_y=np.array(traj_y),
                )

        # Back wall: x-crossing at far rim while y in wall range → hit
        if prev_x < back_wall_x <= x:
            frac = (back_wall_x - prev_x) / (x - prev_x + 1e-12)
            y_at_wall = prev_y + frac * (y - prev_y)
            if RIM_HEIGHT <= y_at_wall <= WALL_TOP:
                return ShotResult(
                    hit=True, x_final=back_wall_x, y_final=y_at_wall,
                    time_of_flight=t,
                    trajectory_x=np.array(traj_x),
                    trajectory_y=np.array(traj_y),
                )

        # Detect downward crossing of rim height — ball entering the top-loading opening
        now_above_rim = y >= RIM_HEIGHT
        if was_above_rim and not now_above_rim:
            # Interpolate exact x where ball crossed y = RIM_HEIGHT
            frac = (prev_y - RIM_HEIGHT) / (prev_y - y + 1e-12)
            x_crossing = prev_x + frac * (x - prev_x)

            x_near = distance - GOAL_RADIUS + BALL_RADIUS
            x_far  = distance + GOAL_RADIUS - BALL_RADIUS
            hit = x_near <= x_crossing <= x_far

            return ShotResult(
                hit=hit,
                x_final=x_crossing,
                y_final=RIM_HEIGHT,
                time_of_flight=t,
                trajectory_x=np.array(traj_x),
                trajectory_y=np.array(traj_y),
            )
        was_above_rim = now_above_rim

        if y < 0:
            return ShotResult(
                hit=False, x_final=x, y_final=y,
                time_of_flight=t,
                trajectory_x=np.array(traj_x),
                trajectory_y=np.array(traj_y),
            )

    return ShotResult(
        hit=False, x_final=x, y_final=y,
        time_of_flight=t,
        trajectory_x=np.array(traj_x),
        trajectory_y=np.array(traj_y),
    )


def find_valid_shots(
    distance: float,
    robot_radial_vel: float = 0.0,
    speed_range: tuple = (5.0, 20.0),
    angle_range: tuple = (20.0, 70.0),
    speed_steps: int = 60,
    angle_steps: int = 60,
    spin_rps: float = SPIN_RATE_RPS,
) -> list[dict]:
    """
    Sweep speed/angle space and return all shots that score.
    This is the core of the frc4414 approach: find the full valid region,
    not just the single center-of-goal shot.
    """
    speeds = np.linspace(speed_range[0], speed_range[1], speed_steps)
    angles = np.linspace(angle_range[0], angle_range[1], angle_steps)
    valid_shots = []

    for speed in speeds:
        for angle in angles:
            result = simulate_shot(
                distance=distance,
                exit_speed=speed,
                launch_angle_deg=angle,
                spin_rps=spin_rps,
                robot_radial_vel=robot_radial_vel,
            )
            if result.hit:
                valid_shots.append({
                    "speed": speed,
                    "angle": angle,
                    "x_final": result.x_final,
                    "y_final": result.y_final,
                    "tof": result.time_of_flight,
                })

    return valid_shots


def select_optimal_shot(valid_shots: list[dict]) -> Optional[dict]:
    """
    From the valid shot region, select the most robust shot.
    Strategy: find the shot closest to the centroid of the valid region
    (maximizes tolerance margin), weighted by minimizing sensitivity to
    speed/angle error (std of neighbors).
    """
    if not valid_shots:
        return None

    speeds = np.array([s["speed"] for s in valid_shots])
    angles = np.array([s["angle"] for s in valid_shots])

    center_speed = np.mean(speeds)
    center_angle = np.mean(angles)
    speed_std = np.std(speeds) + 1e-9
    angle_std = np.std(angles) + 1e-9

    best = None
    best_score = float("inf")

    for shot in valid_shots:
        # Normalized distance from centroid - prefer center of valid region
        ds = (shot["speed"] - center_speed) / speed_std
        da = (shot["angle"] - center_angle) / angle_std
        score = ds**2 + da**2
        if score < best_score:
            best_score = score
            best = shot

    return best
