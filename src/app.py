"""
FRC 2026 Rebuilt Shot Calculator - Main GUI Application
Physics-based shot planning inspired by frc4414 / 1690 2022 approach.
"""
import sys
import os
import threading
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.figure import Figure
from matplotlib.backends.backend_agg import FigureCanvasAgg
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk

sys.path.insert(0, os.path.dirname(__file__))
from physics import (
    simulate_shot, find_valid_shots, select_optimal_shot,
    GOAL_HEIGHT, GOAL_RADIUS, SHOOTER_HEIGHT, SPIN_RATE_RPS
)
from shot_table import ShotTableGenerator, ShotPolynomialSolver, TuningParams, ShotTableEntry


class ShotCalculatorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("FRC 2026 Rebuilt Shot Calculator")
        self.geometry("1400x900")
        self.configure(bg="#1e1e2e")

        self.tuning = TuningParams()
        self.solver = ShotPolynomialSolver(degree=4)
        self.table: list[ShotTableEntry] = []
        self.table_generated = False

        self._build_ui()

    # ── UI construction ─────────────────────────────────────────────────────

    def _build_ui(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background="#1e1e2e")
        style.configure("TLabel", background="#1e1e2e", foreground="#cdd6f4", font=("Segoe UI", 10))
        style.configure("TButton", background="#89b4fa", foreground="#1e1e2e", font=("Segoe UI", 10, "bold"), padding=6)
        style.configure("TEntry", fieldbackground="#313244", foreground="#cdd6f4")
        style.configure("TLabelframe", background="#1e1e2e", foreground="#89b4fa")
        style.configure("TLabelframe.Label", background="#1e1e2e", foreground="#89b4fa", font=("Segoe UI", 10, "bold"))
        style.configure("TScale", background="#1e1e2e", troughcolor="#313244")
        style.configure("TNotebook", background="#1e1e2e", tabmargins=[2, 5, 2, 0])
        style.configure("TNotebook.Tab", background="#313244", foreground="#cdd6f4", padding=[10, 4])
        style.map("TNotebook.Tab", background=[("selected", "#89b4fa")], foreground=[("selected", "#1e1e2e")])

        # Header
        hdr = ttk.Frame(self)
        hdr.pack(fill="x", padx=12, pady=(10, 0))
        tk.Label(hdr, text="FRC 2026  |  Rebuilt Shot Calculator",
                 font=("Segoe UI", 16, "bold"), bg="#1e1e2e", fg="#89b4fa").pack(side="left")
        tk.Label(hdr, text="Physics: Drag + Magnus  |  Optimizer: frc4414 method  |  Poly solver: 1690 2022",
                 font=("Segoe UI", 9), bg="#1e1e2e", fg="#6c7086").pack(side="right")

        # Main notebook
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=12, pady=10)

        self._build_sim_tab(nb)
        self._build_table_tab(nb)
        self._build_tuning_tab(nb)
        self._build_lookup_tab(nb)

    # ── Tab 1: Single Shot Simulation ────────────────────────────────────────

    def _build_sim_tab(self, nb):
        frame = ttk.Frame(nb)
        nb.add(frame, text="  Shot Simulation  ")

        left = ttk.Frame(frame)
        left.pack(side="left", fill="y", padx=12, pady=10)

        right = ttk.Frame(frame)
        right.pack(side="left", fill="both", expand=True, padx=(0, 12), pady=10)

        # Parameters
        pf = ttk.LabelFrame(left, text="Shot Parameters")
        pf.pack(fill="x", pady=(0, 8))

        self._sim_vars = {}
        params = [
            ("Distance (m)", "distance", "5.0", 1.0, 10.0),
            ("Exit Speed (m/s)", "speed", "12.0", 3.0, 25.0),
            ("Launch Angle (°)", "angle", "45.0", 10.0, 75.0),
            ("Robot Radial Vel (m/s)", "radial_vel", "0.0", -4.0, 4.0),
            ("Spin Rate (rps)", "spin", "50.0", 0.0, 120.0),
        ]
        for label, key, default, lo, hi in params:
            row = ttk.Frame(pf)
            row.pack(fill="x", padx=8, pady=3)
            ttk.Label(row, text=label, width=22).pack(side="left")
            var = tk.StringVar(value=default)
            self._sim_vars[key] = var
            ttk.Entry(row, textvariable=var, width=8).pack(side="left", padx=4)
            sl = ttk.Scale(row, from_=lo, to=hi, orient="horizontal", length=120,
                           command=lambda v, k=key, fmt=".1f": self._sim_vars[k].set(f"{float(v):{fmt}}"))
            sl.set(float(default))
            sl.pack(side="left")

        # Options
        of = ttk.LabelFrame(left, text="Physics Options")
        of.pack(fill="x", pady=(0, 8))
        self._drag_var = tk.BooleanVar(value=True)
        self._magnus_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(of, text="Aerodynamic Drag", variable=self._drag_var).pack(anchor="w", padx=8, pady=2)
        ttk.Checkbutton(of, text="Magnus Effect (backspin)", variable=self._magnus_var).pack(anchor="w", padx=8, pady=2)

        ttk.Button(left, text="Simulate Shot", command=self._run_single_sim).pack(fill="x", pady=4)
        ttk.Button(left, text="Show Valid Shot Region", command=self._run_valid_region).pack(fill="x", pady=4)

        self._sim_info = tk.StringVar(value="Run a simulation to see results.")
        ttk.Label(left, textvariable=self._sim_info, wraplength=260, justify="left",
                  foreground="#a6e3a1").pack(padx=8, pady=8)

        # Plot area
        self._sim_fig = Figure(figsize=(8, 5), facecolor="#1e1e2e")
        self._sim_canvas = FigureCanvasTkAgg(self._sim_fig, master=right)
        self._sim_canvas.get_tk_widget().pack(fill="both", expand=True)
        NavigationToolbar2Tk(self._sim_canvas, right).pack(fill="x")

    # ── Tab 2: Shot Table Generation ─────────────────────────────────────────

    def _build_table_tab(self, nb):
        frame = ttk.Frame(nb)
        nb.add(frame, text="  Shot Table  ")

        left = ttk.Frame(frame)
        left.pack(side="left", fill="y", padx=12, pady=10)

        right = ttk.Frame(frame)
        right.pack(side="left", fill="both", expand=True, padx=(0, 12), pady=10)

        cf = ttk.LabelFrame(left, text="Generation Config")
        cf.pack(fill="x", pady=(0, 8))

        self._tbl_vars = {}
        configs = [
            ("Min Distance (m)", "dist_min", "1.5"),
            ("Max Distance (m)", "dist_max", "8.0"),
            ("Distance Steps", "dist_steps", "20"),
            ("Radial Vel Steps", "rv_steps", "7"),
        ]
        for label, key, default in configs:
            row = ttk.Frame(cf)
            row.pack(fill="x", padx=8, pady=3)
            ttk.Label(row, text=label, width=20).pack(side="left")
            var = tk.StringVar(value=default)
            self._tbl_vars[key] = var
            ttk.Entry(row, textvariable=var, width=8).pack(side="left")

        self._progress_var = tk.StringVar(value="Ready")
        self._progress_bar = ttk.Progressbar(left, orient="horizontal", length=240, mode="indeterminate")
        self._progress_bar.pack(fill="x", padx=8, pady=4)
        ttk.Label(left, textvariable=self._progress_var, foreground="#f9e2af").pack(padx=8)

        ttk.Button(left, text="Generate Shot Table", command=self._generate_table).pack(fill="x", pady=4)
        ttk.Button(left, text="Save Table...", command=self._save_table).pack(fill="x", pady=2)
        ttk.Button(left, text="Load Table...", command=self._load_table).pack(fill="x", pady=2)

        self._table_info = tk.StringVar(value="No table generated yet.")
        ttk.Label(left, textvariable=self._table_info, wraplength=260,
                  foreground="#a6e3a1").pack(padx=8, pady=8)

        # Heatmap area
        self._tbl_fig = Figure(figsize=(8, 5), facecolor="#1e1e2e")
        self._tbl_canvas = FigureCanvasTkAgg(self._tbl_fig, master=right)
        self._tbl_canvas.get_tk_widget().pack(fill="both", expand=True)
        NavigationToolbar2Tk(self._tbl_canvas, right).pack(fill="x")

    # ── Tab 3: Tuning ─────────────────────────────────────────────────────────

    def _build_tuning_tab(self, nb):
        frame = ttk.Frame(nb)
        nb.add(frame, text="  Tuning  ")

        pf = ttk.LabelFrame(frame, text="Tuning Parameters  (adjust until balls go in the goal)")
        pf.pack(fill="x", padx=20, pady=20)

        ttk.Label(pf, text=(
            "1.  Hood Angle Offset: measure actual angle from slow-mo video, set offset as constant\n"
            "2.  MPS Factor: fudge the speed ratio until all shots score — one knob controls the full range\n"
            "3.  Spin Rate: affects Magnus lift, tune if near/far shots differ unexpectedly"
        ), justify="left", foreground="#f9e2af").pack(padx=12, pady=8, anchor="w")

        self._tune_vars = {}
        tune_params = [
            ("Hood Angle Offset (°)", "hood_angle_offset", "0.0", -10.0, 10.0),
            ("MPS Factor (speed multiplier)", "mps_factor", "1.0", 0.5, 2.0),
            ("Spin Rate (rps)", "spin_rps", "50.0", 0.0, 120.0),
        ]
        for label, key, default, lo, hi in tune_params:
            row = ttk.Frame(pf)
            row.pack(fill="x", padx=12, pady=6)
            ttk.Label(row, text=label, width=30).pack(side="left")
            var = tk.StringVar(value=default)
            self._tune_vars[key] = var
            ttk.Entry(row, textvariable=var, width=8).pack(side="left", padx=6)
            ttk.Scale(row, from_=lo, to=hi, orient="horizontal", length=200,
                      command=lambda v, k=key: self._tune_vars[k].set(f"{float(v):.2f}")).pack(side="left")

        ttk.Button(frame, text="Apply Tuning & Re-fit Polynomials",
                   command=self._apply_tuning).pack(padx=20, pady=10)

        self._tune_status = tk.StringVar(value="")
        ttk.Label(frame, textvariable=self._tune_status, foreground="#a6e3a1").pack(padx=20)

        # Explanation box
        ef = ttk.LabelFrame(frame, text="How tuning works (frc4414 method)")
        ef.pack(fill="x", padx=20, pady=10)
        explanation = (
            "The shot solver computes physically ideal exit speed and angle for every distance.\n"
            "Instead of a full distance/speed/angle lookup map, only two scalar values need tuning:\n\n"
            "  • Hood angle offset: measured once from video, stays constant across all distances\n"
            "  • MPS factor: single multiplier on the rps→mps ratio; small change fixes all distances at once\n\n"
            "As balls wear in, a small MPS factor adjustment re-aligns the entire shot envelope.\n"
            "This is far simpler than re-tuning a full empirical lookup table."
        )
        ttk.Label(ef, text=explanation, justify="left", wraplength=900).pack(padx=12, pady=8, anchor="w")

    # ── Tab 4: Real-time Lookup ───────────────────────────────────────────────

    def _build_lookup_tab(self, nb):
        frame = ttk.Frame(nb)
        nb.add(frame, text="  Live Lookup  ")

        top = ttk.Frame(frame)
        top.pack(fill="x", padx=20, pady=20)

        lf = ttk.LabelFrame(top, text="Query Shot Parameters")
        lf.pack(side="left", padx=(0, 20))

        self._lookup_vars = {}
        for label, key, default in [("Distance (m)", "dist", "5.0"), ("Radial Velocity (m/s)", "rv", "0.0")]:
            row = ttk.Frame(lf)
            row.pack(fill="x", padx=10, pady=6)
            ttk.Label(row, text=label, width=22).pack(side="left")
            var = tk.StringVar(value=default)
            self._lookup_vars[key] = var
            ttk.Entry(row, textvariable=var, width=10).pack(side="left")

        ttk.Button(lf, text="Get Shot", command=self._do_lookup).pack(padx=10, pady=8)

        rf = ttk.LabelFrame(top, text="Results")
        rf.pack(side="left", fill="both", expand=True)

        self._result_text = tk.Text(rf, height=12, bg="#313244", fg="#cdd6f4",
                                    font=("Courier New", 11), relief="flat")
        self._result_text.pack(fill="both", expand=True, padx=8, pady=8)

        # Poly curve plot
        bot = ttk.Frame(frame)
        bot.pack(fill="both", expand=True, padx=20, pady=(0, 10))
        self._lookup_fig = Figure(figsize=(12, 3.5), facecolor="#1e1e2e")
        self._lookup_canvas = FigureCanvasTkAgg(self._lookup_fig, master=bot)
        self._lookup_canvas.get_tk_widget().pack(fill="both", expand=True)

    # ── Action handlers ──────────────────────────────────────────────────────

    def _run_single_sim(self):
        try:
            d = float(self._sim_vars["distance"].get())
            spd = float(self._sim_vars["speed"].get())
            ang = float(self._sim_vars["angle"].get())
            rv = float(self._sim_vars["radial_vel"].get())
            spin = float(self._sim_vars["spin"].get())
        except ValueError:
            messagebox.showerror("Input Error", "Please enter valid numbers.")
            return

        result = simulate_shot(
            distance=d, exit_speed=spd, launch_angle_deg=ang,
            spin_rps=spin, robot_radial_vel=rv,
            include_drag=self._drag_var.get(),
            include_magnus=self._magnus_var.get(),
        )

        status = "HIT" if result.hit else "MISS"
        color = "#a6e3a1" if result.hit else "#f38ba8"
        self._sim_info.set(
            f"Result: {status}\n"
            f"Y at goal: {result.y_final:.3f} m\n"
            f"Goal window: {GOAL_HEIGHT - GOAL_RADIUS:.3f} – {GOAL_HEIGHT + GOAL_RADIUS:.3f} m\n"
            f"Time of flight: {result.time_of_flight:.3f} s"
        )

        self._sim_fig.clear()
        ax = self._sim_fig.add_subplot(111, facecolor="#181825")
        ax.plot(result.trajectory_x, result.trajectory_y, color="#89b4fa", linewidth=2, label="Ball path")
        ax.axhline(GOAL_HEIGHT, color="#f9e2af", linestyle="--", alpha=0.6, label="Goal center")
        ax.axhline(GOAL_HEIGHT + GOAL_RADIUS, color="#a6e3a1", linestyle=":", alpha=0.6, label="Goal rim")
        ax.axhline(GOAL_HEIGHT - GOAL_RADIUS, color="#a6e3a1", linestyle=":", alpha=0.6)
        ax.axhline(SHOOTER_HEIGHT, color="#6c7086", linestyle="-.", alpha=0.4, label="Shooter height")
        ax.scatter([d], [result.y_final], s=80,
                   color="#a6e3a1" if result.hit else "#f38ba8", zorder=5, label=status)
        ax.set_xlabel("Distance (m)", color="#cdd6f4")
        ax.set_ylabel("Height (m)", color="#cdd6f4")
        ax.set_title(f"Shot Trajectory  —  {status}  |  d={d}m  v={spd}m/s  α={ang}°  rv={rv}m/s",
                     color="#89b4fa", fontsize=11)
        ax.tick_params(colors="#6c7086")
        ax.legend(facecolor="#313244", edgecolor="#6c7086", labelcolor="#cdd6f4", fontsize=8)
        for spine in ax.spines.values():
            spine.set_edgecolor("#313244")
        self._sim_fig.tight_layout()
        self._sim_canvas.draw()

    def _run_valid_region(self):
        try:
            d = float(self._sim_vars["distance"].get())
            rv = float(self._sim_vars["radial_vel"].get())
            spin = float(self._sim_vars["spin"].get())
        except ValueError:
            messagebox.showerror("Input Error", "Please enter valid numbers.")
            return

        valid = find_valid_shots(distance=d, robot_radial_vel=rv, spin_rps=spin)
        optimal = select_optimal_shot(valid)

        if not valid:
            self._sim_info.set("No valid shots found at this distance/velocity.")
            return

        speeds = [s["speed"] for s in valid]
        angles = [s["angle"] for s in valid]

        self._sim_fig.clear()
        ax = self._sim_fig.add_subplot(111, facecolor="#181825")
        sc = ax.scatter(speeds, angles, c=[s["y_final"] for s in valid],
                        cmap="plasma", s=30, alpha=0.8, zorder=3)
        if optimal:
            ax.scatter([optimal["speed"]], [optimal["angle"]], s=200,
                       color="#a6e3a1", marker="*", zorder=5, label="Optimal shot")
        cb = self._sim_fig.colorbar(sc, ax=ax)
        cb.set_label("Y at goal (m)", color="#cdd6f4")
        cb.ax.yaxis.set_tick_params(color="#6c7086")
        ax.set_xlabel("Exit Speed (m/s)", color="#cdd6f4")
        ax.set_ylabel("Launch Angle (°)", color="#cdd6f4")
        ax.set_title(f"Valid Shot Region  |  d={d}m  rv={rv}m/s  ({len(valid)} valid shots)",
                     color="#89b4fa", fontsize=11)
        ax.tick_params(colors="#6c7086")
        ax.legend(facecolor="#313244", edgecolor="#6c7086", labelcolor="#cdd6f4")
        for spine in ax.spines.values():
            spine.set_edgecolor("#313244")
        self._sim_fig.tight_layout()
        self._sim_canvas.draw()

        if optimal:
            self._sim_info.set(
                f"Valid shots: {len(valid)}\n"
                f"Optimal speed: {optimal['speed']:.2f} m/s\n"
                f"Optimal angle: {optimal['angle']:.1f}°\n"
                f"Speed std: {np.std(speeds):.2f}  Angle std: {np.std(angles):.1f}°"
            )

    def _generate_table(self):
        try:
            cfg = {k: float(v.get()) if k != "dist_steps" and k != "rv_steps"
                   else int(v.get()) for k, v in self._tbl_vars.items()}
        except ValueError:
            messagebox.showerror("Input Error", "Invalid config values.")
            return

        self._progress_var.set("Generating...")
        self._progress_bar.start(10)
        self._table_info.set("Working...")

        def run():
            gen = ShotTableGenerator(
                distance_range=(cfg["dist_min"], cfg["dist_max"]),
                distance_steps=cfg["dist_steps"],
                radial_vel_range=(-3.0, 3.0),
                radial_vel_steps=cfg["rv_steps"],
                tuning=self.tuning,
            )
            table = gen.generate(verbose=False)
            self.after(0, lambda: self._on_table_done(table))

        threading.Thread(target=run, daemon=True).start()

    def _on_table_done(self, table):
        self._progress_bar.stop()
        self.table = table
        self.solver.fit(table)
        self.table_generated = True

        valid_entries = [e for e in table if e.valid_count > 0]
        self._progress_var.set("Done")
        self._table_info.set(
            f"Table: {len(table)} entries\n"
            f"Valid shots found: {len(valid_entries)}\n"
            f"Polynomials fitted: degree {self.solver.degree}"
        )
        self._plot_table_heatmap()
        self._plot_poly_curves()

    def _plot_table_heatmap(self):
        if not self.table:
            return
        valid = [e for e in self.table if e.valid_count > 0]
        if not valid:
            return

        dists = sorted(set(e.distance for e in self.table))
        rvs = sorted(set(e.radial_velocity for e in self.table))
        speed_grid = np.zeros((len(rvs), len(dists)))
        angle_grid = np.zeros((len(rvs), len(dists)))
        tol_grid = np.zeros((len(rvs), len(dists)))

        for e in self.table:
            i = rvs.index(e.radial_velocity)
            j = dists.index(e.distance)
            speed_grid[i, j] = e.exit_speed
            angle_grid[i, j] = e.launch_angle
            tol_grid[i, j] = e.tolerance_speed

        self._tbl_fig.clear()
        gs = gridspec.GridSpec(1, 3, figure=self._tbl_fig)
        axes = [self._tbl_fig.add_subplot(gs[0, i], facecolor="#181825") for i in range(3)]
        data = [(speed_grid, "Exit Speed (m/s)", "plasma"),
                (angle_grid, "Launch Angle (°)", "viridis"),
                (tol_grid, "Speed Tolerance (m/s)", "cool")]

        for ax, (grid, title, cmap) in zip(axes, data):
            im = ax.imshow(grid, aspect="auto", origin="lower", cmap=cmap,
                           extent=[min(dists), max(dists), min(rvs), max(rvs)])
            self._tbl_fig.colorbar(im, ax=ax)
            ax.set_title(title, color="#89b4fa", fontsize=9)
            ax.set_xlabel("Distance (m)", color="#cdd6f4", fontsize=8)
            ax.set_ylabel("Radial Vel (m/s)", color="#cdd6f4", fontsize=8)
            ax.tick_params(colors="#6c7086", labelsize=7)

        self._tbl_fig.suptitle("Shot Table Heatmaps", color="#cdd6f4", fontsize=11)
        self._tbl_fig.tight_layout()
        self._tbl_canvas.draw()

    def _plot_poly_curves(self):
        if not self.table_generated:
            return
        dists = np.linspace(
            min(e.distance for e in self.table if e.valid_count > 0),
            max(e.distance for e in self.table if e.valid_count > 0),
            100
        )
        self._lookup_fig.clear()
        ax1 = self._lookup_fig.add_subplot(121, facecolor="#181825")
        ax2 = self._lookup_fig.add_subplot(122, facecolor="#181825")

        for rv in [-2.0, 0.0, 2.0]:
            speeds = [self.solver.predict(d, rv)[0] for d in dists]
            angles = [self.solver.predict(d, rv)[1] for d in dists]
            label = f"rv={rv:+.0f}m/s"
            ax1.plot(dists, speeds, label=label, linewidth=1.5)
            ax2.plot(dists, angles, label=label, linewidth=1.5)

        for ax, title, ylabel in [
            (ax1, "Exit Speed vs Distance", "Exit Speed (m/s)"),
            (ax2, "Launch Angle vs Distance", "Launch Angle (°)"),
        ]:
            ax.set_title(title, color="#89b4fa", fontsize=9)
            ax.set_xlabel("Distance (m)", color="#cdd6f4", fontsize=8)
            ax.set_ylabel(ylabel, color="#cdd6f4", fontsize=8)
            ax.tick_params(colors="#6c7086", labelsize=7)
            ax.legend(facecolor="#313244", edgecolor="#6c7086", labelcolor="#cdd6f4", fontsize=7)
            for spine in ax.spines.values():
                spine.set_edgecolor("#313244")

        self._lookup_fig.tight_layout()
        self._lookup_canvas.draw()

    def _save_table(self):
        if not self.table:
            messagebox.showwarning("No Table", "Generate a table first.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".json",
                                            filetypes=[("JSON", "*.json")])
        if path:
            gen = ShotTableGenerator(tuning=self.tuning)
            gen.table = self.table
            gen.save(path)
            messagebox.showinfo("Saved", f"Table saved to {path}")

    def _load_table(self):
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if path:
            _, table = ShotTableGenerator.load(path)
            self.table = table
            self.solver.fit(table)
            self.table_generated = True
            self._table_info.set(f"Loaded {len(table)} entries from file.")
            self._plot_table_heatmap()
            self._plot_poly_curves()

    def _apply_tuning(self):
        try:
            self.tuning.hood_angle_offset = float(self._tune_vars["hood_angle_offset"].get())
            self.tuning.mps_factor = float(self._tune_vars["mps_factor"].get())
            self.tuning.spin_rps = float(self._tune_vars["spin_rps"].get())
        except ValueError:
            messagebox.showerror("Input Error", "Invalid tuning values.")
            return

        if self.table_generated:
            # Re-apply tuning offsets to existing table (fast, no re-simulation)
            for e in self.table:
                e.launch_angle = e.launch_angle + self.tuning.hood_angle_offset
                e.exit_speed = e.exit_speed * self.tuning.mps_factor
            self.solver.fit(self.table)
            self._tune_status.set("Tuning applied and polynomials re-fitted.")
            self._plot_poly_curves()
        else:
            self._tune_status.set("Tuning saved. Generate a table to apply.")

    def _do_lookup(self):
        if not self.table_generated:
            self._result_text.delete("1.0", "end")
            self._result_text.insert("end", "No table available.\nGenerate or load a shot table first.\n")
            return
        try:
            dist = float(self._lookup_vars["dist"].get())
            rv = float(self._lookup_vars["rv"].get())
        except ValueError:
            return

        speed, angle = self.solver.predict(dist, rv)
        rpm = self.solver.speed_to_rpm(speed, self.tuning, dist)

        self._result_text.delete("1.0", "end")
        self._result_text.insert("end",
            f"Distance:        {dist:.2f} m\n"
            f"Radial Velocity: {rv:+.2f} m/s\n"
            f"\n"
            f"── Shot Command ──────────────────\n"
            f"Exit Speed:      {speed:.3f} m/s\n"
            f"Launch Angle:    {angle:.2f}°\n"
            f"Flywheel RPM:    {rpm:.0f} RPM\n"
            f"\n"
            f"── Tuning Applied ───────────────\n"
            f"Hood offset:     {self.tuning.hood_angle_offset:+.2f}°\n"
            f"MPS factor:      {self.tuning.mps_factor:.3f}\n"
            f"Spin rate:       {self.tuning.spin_rps:.1f} rps\n"
        )


def main():
    app = ShotCalculatorApp()
    app.mainloop()


if __name__ == "__main__":
    main()
