// Physics engine — ball flight with aerodynamic drag and Magnus (backspin) effect.

const PHYSICS = (() => {
  // ── 2026 game geometry (meters) ─────────────────────────────────────────
  // Front lip of hexagonal hub opening: 72 in = 1.83 m
  // Opening diameter: 41.7 in = 1.059 m  →  radius = 0.530 m
  // Goal center height = lip + radius = 1.83 + 0.530 = 2.36 m
  // Shooter exit height: 21.5 in = 0.546 m
  const GOAL_HEIGHT    = 2.36;
  const GOAL_RADIUS    = 0.530;
  const RIM_HEIGHT     = GOAL_HEIGHT - GOAL_RADIUS;  // = 1.83 m, front lip (72 in)
  const WALL_HEIGHT    = 8 * 0.0254;                 // 8 in rim walls above each rim edge = 0.2032 m
  const WALL_TOP       = RIM_HEIGHT + WALL_HEIGHT;   // top of rim walls = 2.0332 m
  const BALL_RADIUS    = 0.120;
  const BALL_MASS      = 0.235;
  const SHOOTER_HEIGHT = 0.546;

  // Aerodynamic constants
  const AIR_DENSITY    = 1.225;
  const DRAG_COEFF     = 0.55;
  const MAGNUS_COEFF   = 0.20;
  const BALL_XSECTION  = Math.PI * BALL_RADIUS * BALL_RADIUS;

  const GRAVITY      = 9.81;
  const DT           = 0.002;   // timestep (s) — 2ms keeps error small, runs fast
  const MAX_SIM_TIME = 3.0;
  // Empirical spin decay rate (s⁻¹): ω(t) = ω₀·e^(−k·t). Tune against measured flight data.
  const SPIN_DECAY_RATE = 0.5;

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
    ceilingHeight = null,
    storeTrajectory = true,
  }) {
    const rad = launchAngleDeg * Math.PI / 180;
    let vx = exitSpeed * Math.cos(rad) + robotRadialVel;
    let vy = exitSpeed * Math.sin(rad);
    let x  = 0.0;
    let y  = SHOOTER_HEIGHT;
    let t  = 0.0;

    let omega = 2 * Math.PI * spinRps;  // rad/s — decays in flight

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

      let axDrag = 0, ayDrag = 0, axMagnus = 0, ayMagnus = 0;

      if (drag && v > 0) {
        const f = (0.5 * AIR_DENSITY * DRAG_COEFF * BALL_XSECTION * v2) / BALL_MASS;
        axDrag = -f * (vx / v);
        ayDrag = -f * (vy / v);
      }

      if (magnus && v > 0) {
        // |F_m|/m = ½ ρ C_m A v ω R / m, direction perpendicular to v in the
        // lift sense for backspin: ax = -(|F|/m)·(vy/v), ay = +(|F|/m)·(vx/v).
        const fM = (0.5 * AIR_DENSITY * MAGNUS_COEFF * BALL_XSECTION * omega * BALL_RADIUS * v) / BALL_MASS;
        axMagnus = -fM * (vy / v);
        ayMagnus = +fM * (vx / v);
      }

      // Symplectic (semi-implicit) Euler: update velocity first, then position
      // with the new velocity. Better energy conservation than forward Euler.
      vx += (axDrag + axMagnus) * DT;
      vy += (-GRAVITY + ayDrag + ayMagnus) * DT;
      omega *= (1 - SPIN_DECAY_RATE * DT);
      prevX = x;  prevY = y;
      x  += vx * DT;
      y  += vy * DT;
      t  += DT;

      if (storeTrajectory) { trajX.push(x); trajY.push(y); }

      // Ceiling: any upward crossing of the ceiling plane invalidates the shot.
      if (ceilingHeight != null && y >= ceilingHeight) {
        const frac = (ceilingHeight - prevY) / (y - prevY + 1e-12);
        const xAtCeiling = prevX + frac * (x - prevX);
        return { hit: false, xFinal: xAtCeiling, yFinal: ceilingHeight, tof: t, trajX, trajY };
      }

      // Front wall extends from the carpet (y=0) up to WALL_TOP.
      // Any x-crossing below WALL_TOP hits the wall → miss.
      if (prevX < frontWallX && x >= frontWallX) {
        const frac = (frontWallX - prevX) / (x - prevX + 1e-12);
        const yAtWall = prevY + frac * (y - prevY);
        if (yAtWall >= 0 && yAtWall <= WALL_TOP) {
          return { hit: false, xFinal: frontWallX, yFinal: yAtWall, tof: t, trajX, trajY };
        }
      }

      // Back wall: x-crossing at far rim while y in wall range → miss
      if (prevX < backWallX && x >= backWallX) {
        const frac = (backWallX - prevX) / (x - prevX + 1e-12);
        const yAtWall = prevY + frac * (y - prevY);
        if (yAtWall >= RIM_HEIGHT && yAtWall <= WALL_TOP) {
          return { hit: false, xFinal: backWallX, yFinal: yAtWall, tof: t, trajX, trajY };
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
    speedRange = [5.0, 20.0], angleRange = [40.68, 81.0],
    speedSteps = 50, angleSteps = 50,
    drag = true, magnus = true,
    ceilingHeight = null,
  }) {
    const valid = [];
    for (let si = 0; si < speedSteps; si++) {
      const speed = speedRange[0] + si * (speedRange[1] - speedRange[0]) / (speedSteps - 1);
      for (let ai = 0; ai < angleSteps; ai++) {
        const angle = angleRange[0] + ai * (angleRange[1] - angleRange[0]) / (angleSteps - 1);
        const r = simulateShot({
          distance, exitSpeed: speed, launchAngleDeg: angle,
          spinRps, robotRadialVel, drag, magnus,
          ceilingHeight,
          storeTrajectory: false,
        });
        if (r.hit) valid.push({ speed, angle, xFinal: r.xFinal, yFinal: r.yFinal, tof: r.tof });
      }
    }
    return valid;
  }

  /**
   * Select the most error-tolerant shot from the valid region.
   * For each candidate, measure the margin (m/s and deg) to the nearest
   * invalid neighbour along the speed and angle axes; normalize each by
   * the std of the valid region in that axis; maximize min(normalized).
   */
  function selectOptimalShot(validShots) {
    if (!validShots.length) return null;

    const allSpeeds = validShots.map(s => s.speed);
    const allAngles = validShots.map(s => s.angle);
    const meanSpeed = allSpeeds.reduce((a, b) => a + b, 0) / allSpeeds.length;
    const meanAngle = allAngles.reduce((a, b) => a + b, 0) / allAngles.length;
    const stdSpeed = std(allSpeeds) + 1e-9;
    const stdAngle = std(allAngles) + 1e-9;

    const speedsAtAngle = new Map();
    const anglesAtSpeed = new Map();
    for (const s of validShots) {
      if (!speedsAtAngle.has(s.angle)) speedsAtAngle.set(s.angle, []);
      if (!anglesAtSpeed.has(s.speed)) anglesAtSpeed.set(s.speed, []);
      speedsAtAngle.get(s.angle).push(s.speed);
      anglesAtSpeed.get(s.speed).push(s.angle);
    }
    for (const arr of speedsAtAngle.values()) arr.sort((a, b) => a - b);
    for (const arr of anglesAtSpeed.values()) arr.sort((a, b) => a - b);

    // Smallest gap between consecutive valid values ≈ grid step.
    // Allow 1.5× that as the contiguity threshold.
    const minGap = (groups) => {
      let m = Infinity;
      for (const arr of groups.values()) {
        for (let i = 1; i < arr.length; i++) {
          const g = arr[i] - arr[i - 1];
          if (g < m) m = g;
        }
      }
      return m;
    };
    const speedThresh = minGap(speedsAtAngle) * 1.5;
    const angleThresh = minGap(anglesAtSpeed) * 1.5;

    const margin = (sortedVals, v, thresh) => {
      let idx = 0, bestDiff = Infinity;
      for (let i = 0; i < sortedVals.length; i++) {
        const d = Math.abs(sortedVals[i] - v);
        if (d < bestDiff) { bestDiff = d; idx = i; }
      }
      let lo = idx;
      while (lo > 0 && sortedVals[lo] - sortedVals[lo - 1] < thresh) lo--;
      let hi = idx;
      while (hi < sortedVals.length - 1 && sortedVals[hi + 1] - sortedVals[hi] < thresh) hi++;
      return Math.min(v - sortedVals[lo], sortedVals[hi] - v);
    };

    // Primary: max std-normalized boundary margin (discrete on the grid).
    // Tiebreak by proximity to centroid so the shot table stays smooth
    // across adjacent (distance, radial_vel) cells.
    let best = null, bestScore = -Infinity, bestTie = -Infinity;
    for (const s of validShots) {
      const sMargin = margin(speedsAtAngle.get(s.angle), s.speed, speedThresh);
      const aMargin = margin(anglesAtSpeed.get(s.speed), s.angle, angleThresh);
      const score = Math.min(sMargin / stdSpeed, aMargin / stdAngle);
      const ds = (s.speed - meanSpeed) / stdSpeed;
      const da = (s.angle - meanAngle) / stdAngle;
      const tie = -(ds * ds + da * da);
      if (score > bestScore || (score === bestScore && tie > bestTie)) {
        bestScore = score; bestTie = tie; best = s;
      }
    }
    return best;
  }

  /**
   * Iterative virtual-target solver — 1690 Orbit shoot-on-the-move technique.
   *
   * The robot moves at (radialVel, lateralVel) while the ball is in flight.
   * Each iteration: find the optimal stationary shot to the current virtual
   * target → get its TOF → shift virtual target = (dist−vr·t, −vl·t) → repeat.
   * Converges in ≤5 steps as long as ball speed ≫ robot speed.
   *
   * Returns:
   *   virtualDist   — effective distance to aim at (m); use for table lookup
   *   yawOffsetDeg  — horizontal shooter correction (°); negative = aim right
   *                   when moving left; use atan convention described above
   *   tof           — converged time-of-flight estimate (s)
   */
  function computeVirtualTarget({
    distance, radialVel = 0, lateralVel = 0,
    spinRps = 50, drag = true, magnus = true,
    ceilingHeight = null, maxIter = 5,
  }) {
    let tof = 0;
    let vdx = distance;   // virtual target radial component
    let vdz = 0;          // virtual target lateral component

    for (let i = 0; i < maxIter; i++) {
      const vDist = Math.sqrt(vdx * vdx + vdz * vdz);
      if (vDist < 0.1) break;

      // Query optimal stationary shot at virtual distance
      const valid = findValidShots({
        distance: vDist, robotRadialVel: 0,
        spinRps, drag, magnus, ceilingHeight,
        speedRange: [5.0, 20.0], angleRange: [40.68, 81.0],
        speedSteps: 40, angleSteps: 40,
      });
      const opt = selectOptimalShot(valid);
      if (!opt) break;

      const r = simulateShot({
        distance: vDist, exitSpeed: opt.speed, launchAngleDeg: opt.angle,
        spinRps, drag, magnus, ceilingHeight, storeTrajectory: false,
      });

      const prevTof = tof;
      tof = r.tof;

      // Where the goal appears relative to the robot when the ball arrives
      vdx = distance - radialVel * tof;
      vdz = -lateralVel * tof;

      if (i > 0 && Math.abs(tof - prevTof) < 0.002) break;
    }

    const virtualDist = Math.sqrt(vdx * vdx + vdz * vdz);
    // Negative yawOffsetDeg = aim right; positive = aim left
    const yawOffsetDeg = Math.atan2(-lateralVel * tof, distance - radialVel * tof) * 180 / Math.PI;

    return { virtualDist, yawOffsetDeg, tof };
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }

  // ── Feed shot physics (floor target) ──────────────────────────────────────
  // Simulates a shot that lands on the floor. No goal geometry — the ball flies
  // freely until it hits y=0. Returns the horizontal landing position and TOF.

  function simulateFeedShot({
    exitSpeed, launchAngleDeg,
    spinRps = 10, robotRadialVel = 0,
    drag = true, magnus = true,
    storeTrajectory = true,
  }) {
    const rad = launchAngleDeg * Math.PI / 180;
    let vx = exitSpeed * Math.cos(rad) + robotRadialVel;
    let vy = exitSpeed * Math.sin(rad);
    let x  = 0.0;
    let y  = SHOOTER_HEIGHT;
    let t  = 0.0;
    let omega = 2 * Math.PI * spinRps;

    const trajX = storeTrajectory ? [x] : null;
    const trajY = storeTrajectory ? [y] : null;
    let prevX = x, prevY = y;

    while (t < MAX_SIM_TIME) {
      const v2 = vx * vx + vy * vy;
      const v  = Math.sqrt(v2);
      let axDrag = 0, ayDrag = 0, axMagnus = 0, ayMagnus = 0;

      if (drag && v > 0) {
        const f = (0.5 * AIR_DENSITY * DRAG_COEFF * BALL_XSECTION * v2) / BALL_MASS;
        axDrag = -f * (vx / v);
        ayDrag = -f * (vy / v);
      }
      if (magnus && v > 0) {
        const fM = (0.5 * AIR_DENSITY * MAGNUS_COEFF * BALL_XSECTION * omega * BALL_RADIUS * v) / BALL_MASS;
        axMagnus = -fM * (vy / v);
        ayMagnus = +fM * (vx / v);
      }

      vx += (axDrag + axMagnus) * DT;
      vy += (-GRAVITY + ayDrag + ayMagnus) * DT;
      omega *= (1 - SPIN_DECAY_RATE * DT);
      prevX = x; prevY = y;
      x += vx * DT;
      y += vy * DT;
      t += DT;

      if (storeTrajectory) { trajX.push(x); trajY.push(y); }

      // Interpolate precise floor-crossing point
      if (prevY > 0 && y <= 0) {
        const frac  = prevY / (prevY - y + 1e-12);
        const xLand = prevX + frac * (x - prevX);
        return { xLanding: xLand, tof: t, landed: true, trajX, trajY };
      }
    }

    return { xLanding: x, tof: t, landed: false, trajX, trajY };
  }

  function findValidFeedShots({
    distance, robotRadialVel = 0, spinRps = 10,
    speedRange = [3.0, 18.0], angleRange = [40.68, 81.0],
    speedSteps = 50, angleSteps = 50,
    drag = true, magnus = true,
  }) {
    const valid = [];
    for (let si = 0; si < speedSteps; si++) {
      const speed = speedRange[0] + si * (speedRange[1] - speedRange[0]) / (speedSteps - 1);
      for (let ai = 0; ai < angleSteps; ai++) {
        const angle = angleRange[0] + ai * (angleRange[1] - angleRange[0]) / (angleSteps - 1);
        const r = simulateFeedShot({
          exitSpeed: speed, launchAngleDeg: angle,
          spinRps, robotRadialVel, drag, magnus,
          storeTrajectory: false,
        });
        if (r.landed) {
          valid.push({ speed, angle, xLanding: r.xLanding, tof: r.tof });
        }
      }
    }
    return valid;
  }

  // Picks the shot that lands closest to the target, then maximizes robustness:
  // the shot with the most neighbors within ±0.5 m/s and ±2° sits deepest inside
  // the valid region and tolerates the most motor/hood error.
  function selectOptimalFeedShot(validShots, targetDistance) {
    if (!validShots.length) return null;
    const minErr = Math.min(...validShots.map(s => Math.abs(s.xLanding - targetDistance)));
    const pool = validShots.filter(s => Math.abs(s.xLanding - targetDistance) <= minErr + 0.15);
    if (pool.length === 1) return pool[0];
    const DV = 0.5, DA = 2.0;
    return pool.reduce((best, s) => {
      const cS = pool.filter(p => Math.abs(p.speed - s.speed) <= DV && Math.abs(p.angle - s.angle) <= DA).length;
      const cB = pool.filter(p => Math.abs(p.speed - best.speed) <= DV && Math.abs(p.angle - best.angle) <= DA).length;
      return cS > cB ? s : best;
    });
  }

  return {
    GOAL_HEIGHT, GOAL_RADIUS, RIM_HEIGHT, WALL_HEIGHT, WALL_TOP, SHOOTER_HEIGHT,
    simulateShot, findValidShots, selectOptimalShot, computeVirtualTarget, std,
    simulateFeedShot, findValidFeedShots, selectOptimalFeedShot,
  };
})();
