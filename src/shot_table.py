"""
Shot table generator and polynomial solver.
Based on 1690 2022 approach (referenced by frc4414):
  1. Simulate all shots at each (distance, radial_velocity) point
  2. Select optimal shot per point
  3. Fit polynomials for real-time lookup

Tuning parameters:
  - hood_angle_offset: constant degree offset measured from slow-mo video
  - mps_factor: rps -> mps conversion ratio (tune until balls go in)
"""
import numpy as np
from scipy.optimize import curve_fit
from dataclasses import dataclass, field
from typing import Optional
import json

from physics import find_valid_shots, select_optimal_shot


@dataclass
class TuningParams:
    hood_angle_offset: float = 0.0   # degrees, + means aim higher
    mps_factor: float = 1.0          # multiply computed mps by this to get actual
    spin_rps: float = 50.0           # flywheel backspin
    # Optional lookup for non-linear rps->mps (keyed by distance in meters)
    mps_lookup: dict = field(default_factory=dict)


@dataclass
class ShotTableEntry:
    distance: float           # meters
    radial_velocity: float    # m/s (robot moving toward goal)
    exit_speed: float         # m/s
    launch_angle: float       # degrees
    tolerance_speed: float    # valid speed range (std dev meters/s)
    tolerance_angle: float    # valid angle range (std dev degrees)
    valid_count: int          # number of valid shots found


class ShotTableGenerator:
    def __init__(
        self,
        distance_range: tuple = (1.5, 8.0),
        distance_steps: int = 20,
        radial_vel_range: tuple = (-3.0, 3.0),
        radial_vel_steps: int = 7,
        tuning: Optional[TuningParams] = None,
    ):
        self.distance_range = distance_range
        self.distance_steps = distance_steps
        self.radial_vel_range = radial_vel_range
        self.radial_vel_steps = radial_vel_steps
        self.tuning = tuning or TuningParams()
        self.table: list[ShotTableEntry] = []

    def generate(self, verbose: bool = True) -> list[ShotTableEntry]:
        distances = np.linspace(self.distance_range[0], self.distance_range[1], self.distance_steps)
        radial_vels = np.linspace(self.radial_vel_range[0], self.radial_vel_range[1], self.radial_vel_steps)

        total = len(distances) * len(radial_vels)
        done = 0
        self.table = []

        for dist in distances:
            for rv in radial_vels:
                valid = find_valid_shots(
                    distance=dist,
                    robot_radial_vel=rv,
                    spin_rps=self.tuning.spin_rps,
                )
                optimal = select_optimal_shot(valid)

                if optimal:
                    speeds = [s["speed"] for s in valid]
                    angles = [s["angle"] for s in valid]
                    entry = ShotTableEntry(
                        distance=dist,
                        radial_velocity=rv,
                        exit_speed=optimal["speed"] * self.tuning.mps_factor,
                        launch_angle=optimal["angle"] + self.tuning.hood_angle_offset,
                        tolerance_speed=float(np.std(speeds)),
                        tolerance_angle=float(np.std(angles)),
                        valid_count=len(valid),
                    )
                else:
                    entry = ShotTableEntry(
                        distance=dist, radial_velocity=rv,
                        exit_speed=0.0, launch_angle=0.0,
                        tolerance_speed=0.0, tolerance_angle=0.0,
                        valid_count=0,
                    )

                self.table.append(entry)
                done += 1
                if verbose:
                    print(f"\r  Generating table... {done}/{total} ({100*done//total}%)", end="", flush=True)

        if verbose:
            print()

        return self.table

    def save(self, path: str):
        data = [vars(e) for e in self.table]
        with open(path, "w") as f:
            json.dump({"tuning": vars(self.tuning), "table": data}, f, indent=2)

    @classmethod
    def load(cls, path: str) -> tuple["ShotTableGenerator", list[ShotTableEntry]]:
        with open(path) as f:
            raw = json.load(f)
        gen = cls()
        gen.tuning = TuningParams(**raw["tuning"])
        gen.table = [ShotTableEntry(**e) for e in raw["table"]]
        return gen, gen.table


class ShotPolynomialSolver:
    """
    Fits polynomials to the shot table so the robot can do O(1) lookup.
    Mirrors the 1690 2022 approach: poly(distance, radial_vel) -> (speed, angle).
    """
    def __init__(self, degree: int = 4):
        self.degree = degree
        self._speed_coeffs: Optional[np.ndarray] = None
        self._angle_coeffs: Optional[np.ndarray] = None
        self._rv_levels: Optional[np.ndarray] = None
        # One poly per radial velocity level
        self._speed_polys: dict = {}
        self._angle_polys: dict = {}

    def fit(self, table: list[ShotTableEntry]):
        # Group by radial_velocity
        rv_map: dict[float, list[ShotTableEntry]] = {}
        for entry in table:
            rv_map.setdefault(round(entry.radial_velocity, 4), []).append(entry)

        self._rv_levels = np.array(sorted(rv_map.keys()))
        self._speed_polys = {}
        self._angle_polys = {}

        for rv, entries in rv_map.items():
            entries = [e for e in entries if e.valid_count > 0]
            if len(entries) < self.degree + 1:
                continue
            entries.sort(key=lambda e: e.distance)
            dists = np.array([e.distance for e in entries])
            speeds = np.array([e.exit_speed for e in entries])
            angles = np.array([e.launch_angle for e in entries])

            speed_c = np.polyfit(dists, speeds, self.degree)
            angle_c = np.polyfit(dists, angles, self.degree)
            rv_key = round(rv, 4)
            self._speed_polys[rv_key] = speed_c
            self._angle_polys[rv_key] = angle_c

    def predict(self, distance: float, radial_vel: float = 0.0) -> tuple[float, float]:
        """
        Returns (exit_speed_mps, launch_angle_deg) for given distance and radial velocity.
        Interpolates between the two nearest radial velocity polynomials.
        """
        if not self._speed_polys:
            raise RuntimeError("Model not fitted yet. Call fit() first.")

        rvs = self._rv_levels
        # Clamp to fitted range
        rv_clamped = float(np.clip(radial_vel, rvs.min(), rvs.max()))

        # Find bracketing rv levels
        idx = np.searchsorted(rvs, rv_clamped)
        if idx == 0:
            rv_lo = rv_hi = rvs[0]
        elif idx >= len(rvs):
            rv_lo = rv_hi = rvs[-1]
        else:
            rv_lo = rvs[idx - 1]
            rv_hi = rvs[idx]

        rv_lo_key = round(rv_lo, 4)
        rv_hi_key = round(rv_hi, 4)

        speed_lo = np.polyval(self._speed_polys[rv_lo_key], distance)
        angle_lo = np.polyval(self._angle_polys[rv_lo_key], distance)

        if rv_lo_key == rv_hi_key:
            return float(speed_lo), float(angle_lo)

        speed_hi = np.polyval(self._speed_polys[rv_hi_key], distance)
        angle_hi = np.polyval(self._angle_polys[rv_hi_key], distance)

        frac = (rv_clamped - rv_lo) / (rv_hi - rv_lo + 1e-12)
        speed = speed_lo + frac * (speed_hi - speed_lo)
        angle = angle_lo + frac * (angle_hi - angle_lo)

        return float(speed), float(angle)

    def speed_to_rpm(self, speed_mps: float, tuning: TuningParams, distance: float = 0.0) -> float:
        """
        Convert exit speed (m/s) to flywheel RPM using tunable mps_factor.
        Uses distance-keyed lookup if populated, otherwise linear ratio.
        """
        if tuning.mps_lookup:
            # Find nearest distance key
            keys = sorted(tuning.mps_lookup.keys())
            nearest = min(keys, key=lambda k: abs(k - distance))
            ratio = tuning.mps_lookup[nearest]
        else:
            ratio = tuning.mps_factor

        # ratio is mps per RPS; RPM = (speed_mps / ratio) * 60
        rps = speed_mps / (ratio + 1e-12)
        return rps * 60.0
