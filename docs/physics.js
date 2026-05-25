// Physics engine — JS port of src/physics.py
// Ball flight with aerodynamic drag and Magnus (backspin) effect.

const PHYSICS = (() => {
  // ── 2026 game geometry (meters) ─────────────────────────────────────────
  // Front lip of hexagonal hub opening: 72 in = 1.83 m
  // Opening diameter: 41.7 in = 1.059 m  →  radius = 0.530 m
  // Goal center height = lip + radius = 1.83 + 0.530 = 2.36 m
  // Shooter exit height: 21.5 in = 0.546 m
  const GOAL_HEIGHT    = 2.36;
  const GOAL_RADIUS    = 0.530;
  const RIM_HEIGHT     = GOAL_HEIGHT - GOAL_RADIUS;  // = 1.83 m, front lip (72 in)
  const WALL_HEIGHT    = 4 * 0.0254;                 // 4 in rim walls above each rim edge = 0.1016 m
  const WALL_TOP       = RIM_HEIGHT + WALL_HEIGHT;   // top of rim walls = 1.9316 m
  const BALL_RADIUS    = 0.120;
  const BALL_MASS      = 0.235;
  const SHOOTER_HEIGHT = 0.546;

  // Aerodynamic constants
  const AIR_DENSITY    = 1.225;
  const DRAG_COEFF     = 0.47;
  const MAGNUS_COEFF   = 0.20;
  const BALL_XSECTION  = Math.PI * BALL_RADIUS * BALL_RADIUS;

  const GRAVITY      = 9.81;
  const DT           = 0.002;   // timestep (s) — 2ms keeps error small, runs fast
  const MAX_SIM_TIME = 3.0;

  /**
   * Simulate one shot.
   * @param {object} p
   *   distance       - horizontal distance to goal (m)
   *   exitSpeed      - ball speed at shooter exit (m/s)
   *   launchAngleDeg - launch angle above horizontal (°)
   *   spinRps        - backspin (rev/s)
   *   robotRadialVel - robot velocity toward goal (m/s), added to vx
   *   drag           - include aerodynamic drag (bool)
   *   magnus         - include Magnus lift (bool)
   *   storeTrajectory - if false, skip allocating path arrays (fast path for sweeps)
   */
  function simulateShot({
    distance, exitSpeed, launchAngleDeg,
    spinRps = 50, robotRadialVel = 0,
    drag = true, magnus = true,
    storeTrajectory = true,
  }) {
    const rad = launchAngleDeg * Math.PI / 180;
    let vx = exitSpeed * Math.cos(rad) + robotRadialVel;
    let vy = exitSpeed * Math.sin(rad);
    let x  = 0.0;
    let y  = SHOOTER_HEIGHT;
    let t  = 0.0;

    const omega = 2 * Math.PI * spinRps;  // rad/s

    const trajX = storeTrajectory ? [x] : null;
    const trajY = storeTrajectory ? [y] : null;

    // Ball starts below rim height; track when it descends back through it.
    // SHOOTER_HEIGHT (0.546 m) < RIM_HEIGHT (1.83 m), so wasAbove starts false.
    let wasAbove = y >= RIM_HEIGHT;
    let prevX = x, prevY = y;

    const frontWallX = distance - GOAL_RADIUS;
    const backWallX  = distance + GOAL_RADIUS;

    while (t < MAX_SIM_TIME) {
      const v2 = vx * vx + vy * vy;
      const v  = Math.sqrt(v2);

      let axDrag = 0, ayDrag = 0, ayMagnus = 0;

      if (drag && v > 0) {
        const f = (0.5 * AIR_DENSITY * DRAG_COEFF * BALL_XSECTION * v2) / BALL_MASS;
        axDrag = -f * (vx / v);
        ayDrag = -f * (vy / v);
      }

      if (magnus && v > 0) {
        const fM = (0.5 * AIR_DENSITY * MAGNUS_COEFF * BALL_XSECTION * omega * BALL_RADIUS * v) / BALL_MASS;
        ayMagnus = fM;
      }

      vx += axDrag * DT;
      vy += (-GRAVITY + ayDrag + ayMagnus) * DT;
      prevX = x;  prevY = y;
      x  += vx * DT;
      y  += vy * DT;
      t  += DT;

      if (storeTrajectory) { trajX.push(x); trajY.push(y); }

      // Front wall: x-crossing at near rim while y in wall range → miss
      if (prevX < frontWallX && x >= frontWallX) {
        const frac = (frontWallX - prevX) / (x - prevX + 1e-12);
        const yAtWall = prevY + frac * (y - prevY);
        if (yAtWall >= RIM_HEIGHT && yAtWall <= WALL_TOP) {
          return { hit: false, xFinal: frontWallX, yFinal: yAtWall, tof: t, trajX, trajY };
        }
      }

      // Back wall: x-crossing at far rim while y in wall range → hit
      if (prevX < backWallX && x >= backWallX) {
        const frac = (backWallX - prevX) / (x - prevX + 1e-12);
        const yAtWall = prevY + frac * (y - prevY);
        if (yAtWall >= RIM_HEIGHT && yAtWall <= WALL_TOP) {
          return { hit: true, xFinal: backWallX, yFinal: yAtWall, tof: t, trajX, trajY };
        }
      }

      // Detect downward crossing of rim height — ball entering top-loading opening
      const nowAbove = y >= RIM_HEIGHT;
      if (wasAbove && !nowAbove) {
        const frac = (prevY - RIM_HEIGHT) / (prevY - y + 1e-12);
        const xCrossing = prevX + frac * (x - prevX);

        const xNear = distance - GOAL_RADIUS + BALL_RADIUS;
        const xFar  = distance + GOAL_RADIUS - BALL_RADIUS;
        const hit = xCrossing >= xNear && xCrossing <= xFar;
        return { hit, xFinal: xCrossing, yFinal: RIM_HEIGHT, tof: t, trajX, trajY };
      }
      wasAbove = nowAbove;

      if (y < 0) {
        return { hit: false, xFinal: x, yFinal: y, tof: t, trajX, trajY };
      }
    }

    return { hit: false, xFinal: x, yFinal: y, tof: t, trajX, trajY };
  }

  /**
   * Sweep speed×angle space and return every shot that scores.
   */
  function findValidShots({
    distance, robotRadialVel = 0, spinRps = 50,
    speedRange = [5.0, 20.0], angleRange = [10.0, 70.0],
    speedSteps = 50, angleSteps = 50,
    drag = true, magnus = true,
  }) {
    const valid = [];
    for (let si = 0; si < speedSteps; si++) {
      const speed = speedRange[0] + si * (speedRange[1] - speedRange[0]) / (speedSteps - 1);
      for (let ai = 0; ai < angleSteps; ai++) {
        const angle = angleRange[0] + ai * (angleRange[1] - angleRange[0]) / (angleSteps - 1);
        const r = simulateShot({
          distance, exitSpeed: speed, launchAngleDeg: angle,
          spinRps, robotRadialVel, drag, magnus,
          storeTrajectory: false,
        });
        if (r.hit) valid.push({ speed, angle, xFinal: r.xFinal, yFinal: r.yFinal, tof: r.tof });
      }
    }
    return valid;
  }

  /**
   * Select the shot closest to the centroid of the valid region (maximum margin).
   */
  function selectOptimalShot(validShots) {
    if (!validShots.length) return null;
    let sumSpeed = 0, sumAngle = 0;
    for (const s of validShots) { sumSpeed += s.speed; sumAngle += s.angle; }
    const cSpeed = sumSpeed / validShots.length;
    const cAngle = sumAngle / validShots.length;

    let speeds = validShots.map(s => s.speed);
    let angles = validShots.map(s => s.angle);
    const stdSpeed = std(speeds) + 1e-9;
    const stdAngle = std(angles) + 1e-9;

    let best = null, bestScore = Infinity;
    for (const s of validShots) {
      const ds = (s.speed - cSpeed) / stdSpeed;
      const da = (s.angle - cAngle) / stdAngle;
      const score = ds * ds + da * da;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }

  return {
    GOAL_HEIGHT, GOAL_RADIUS, RIM_HEIGHT, WALL_HEIGHT, WALL_TOP, SHOOTER_HEIGHT,
    simulateShot, findValidShots, selectOptimalShot, std,
  };
})();
