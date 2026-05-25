// Physics engine — JS port of src/physics.py
// Ball flight with aerodynamic drag and Magnus (backspin) effect.

const PHYSICS = (() => {
  // ── 2026 game geometry (meters) ─────────────────────────────────────────
  // Update these to match your robot and the 2026 game piece.
  const GOAL_HEIGHT = 2.44;
  const GOAL_RADIUS = 0.305;
  const BALL_RADIUS = 0.120;
  const BALL_MASS   = 0.235;
  const SHOOTER_HEIGHT = 0.90;

  // Aerodynamic constants
  const AIR_DENSITY    = 1.225;
  const DRAG_COEFF     = 0.47;
  const MAGNUS_COEFF   = 0.20;
  const BALL_XSECTION  = Math.PI * BALL_RADIUS * BALL_RADIUS;

  const GRAVITY      = 9.81;
  const DT           = 0.002;   // timestep (s) — 2ms keeps error small, runs fast
  const MAX_SIM_TIME = 3.0;

  // Goal window ball must enter
  const GOAL_LOW  = GOAL_HEIGHT - GOAL_RADIUS + BALL_RADIUS;
  const GOAL_HIGH = GOAL_HEIGHT + GOAL_RADIUS - BALL_RADIUS;

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

    let prevX = x, prevY = y;

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
        // Backspin on forward-moving ball → upward Magnus lift
        const fM = (0.5 * AIR_DENSITY * MAGNUS_COEFF * BALL_XSECTION * omega * BALL_RADIUS * v) / BALL_MASS;
        ayMagnus = fM;
      }

      vx += (axDrag)           * DT;
      vy += (-GRAVITY + ayDrag + ayMagnus) * DT;
      prevX = x;  prevY = y;
      x  += vx * DT;
      y  += vy * DT;
      t  += DT;

      if (storeTrajectory) { trajX.push(x); trajY.push(y); }

      if (y < 0) {
        return { hit: false, yFinal: y, tof: t, trajX, trajY };
      }

      if (x >= distance) {
        // Interpolate exact y at goal plane
        const frac = (distance - prevX) / (x - prevX + 1e-12);
        const yAtGoal = prevY + frac * (y - prevY);
        const hit = yAtGoal >= GOAL_LOW && yAtGoal <= GOAL_HIGH;
        return { hit, yFinal: yAtGoal, tof: t, trajX, trajY };
      }
    }

    return { hit: false, yFinal: y, tof: t, trajX, trajY };
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
        if (r.hit) valid.push({ speed, angle, yFinal: r.yFinal, tof: r.tof });
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
    GOAL_HEIGHT, GOAL_RADIUS, GOAL_LOW, GOAL_HIGH, SHOOTER_HEIGHT,
    simulateShot, findValidShots, selectOptimalShot, std,
  };
})();
