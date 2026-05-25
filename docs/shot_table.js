// Shot table polynomial solver.
// Polyfit via normal equations (Vandermonde^T × Vandermonde), solved with
// Gauss-Jordan elimination.

const SHOT_TABLE = (() => {

  // ── Polynomial math ────────────────────────────────────────────────────

  /**
   * Least-squares polynomial fit.
   * Returns coefficients in descending order: [c_n, c_{n-1}, ..., c_0]
   * such that p(x) = c_n*x^n + ... + c_0.
   */
  function polyfit(xs, ys, degree) {
    const n = xs.length;
    const m = degree + 1;

    // Build A^T A and A^T y using Vandermonde structure
    const AtA = Array.from({ length: m }, () => new Float64Array(m));
    const Aty = new Float64Array(m);

    for (let i = 0; i < n; i++) {
      // pow[k] = xs[i]^k
      const pow = new Float64Array(m);
      pow[0] = 1;
      for (let k = 1; k < m; k++) pow[k] = pow[k - 1] * xs[i];
      // Column j of A = xs[i]^(degree-j) = pow[degree-j]
      for (let r = 0; r < m; r++) {
        const ar = pow[degree - r];
        Aty[r] += ar * ys[i];
        for (let c = 0; c < m; c++) AtA[r][c] += ar * pow[degree - c];
      }
    }

    // Gauss-Jordan elimination on augmented matrix [AtA | Aty]
    const aug = AtA.map((row, i) => [...row, Aty[i]]);

    for (let col = 0; col < m; col++) {
      // Partial pivot
      let pivotRow = col;
      for (let row = col + 1; row < m; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[pivotRow][col])) pivotRow = row;
      }
      [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];

      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-14) continue;

      // Eliminate all other rows
      for (let row = 0; row < m; row++) {
        if (row === col) continue;
        const factor = aug[row][col] / pivot;
        for (let j = col; j <= m; j++) aug[row][j] -= factor * aug[col][j];
      }
    }

    const coeffs = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      coeffs[i] = aug[i][m] / aug[i][i];
    }
    return coeffs;
  }

  /** Evaluate polynomial using Horner's method. Coeffs in descending order. */
  function polyval(coeffs, x) {
    let result = 0;
    for (let i = 0; i < coeffs.length; i++) result = result * x + coeffs[i];
    return result;
  }

  // ── Polynomial solver ──────────────────────────────────────────────────

  class ShotPolynomialSolver {
    constructor(degree = 4) {
      this.degree = degree;
      this._rvLevels = null;
      this._speedPolys = {};   // rv -> Float64Array coefficients
      this._anglePolys = {};
    }

    fit(tableEntries) {
      // Group by radial_velocity
      const rvMap = {};
      for (const e of tableEntries) {
        const key = Math.round(e.radialVelocity * 1e4) / 1e4;
        if (!rvMap[key]) rvMap[key] = [];
        rvMap[key].push(e);
      }

      this._rvLevels = Object.keys(rvMap).map(Number).sort((a, b) => a - b);
      this._speedPolys = {};
      this._anglePolys = {};

      for (const rv of this._rvLevels) {
        const key = Math.round(rv * 1e4) / 1e4;
        const entries = rvMap[key].filter(e => e.validCount > 0);
        if (entries.length < this.degree + 1) continue;
        entries.sort((a, b) => a.distance - b.distance);

        const dists  = entries.map(e => e.distance);
        const speeds = entries.map(e => e.exitSpeed);
        const angles = entries.map(e => e.launchAngle);

        this._speedPolys[key] = polyfit(dists, speeds, this.degree);
        this._anglePolys[key] = polyfit(dists, angles, this.degree);
      }
    }

    /**
     * Returns { exitSpeed, launchAngle } for a given distance and radial velocity.
     * Clamps inputs to fitted range and interpolates between rv levels.
     */
    predict(distance, radialVel = 0) {
      const rvs = this._rvLevels;
      if (!rvs || rvs.length === 0) return null;

      const rv = Math.max(rvs[0], Math.min(rvs[rvs.length - 1], radialVel));

      // Find bracketing levels
      let idx = rvs.findIndex(r => r >= rv);
      if (idx < 0) idx = rvs.length - 1;
      const rvHi = rvs[idx];
      const rvLo = idx > 0 ? rvs[idx - 1] : rvHi;

      const kLo = Math.round(rvLo * 1e4) / 1e4;
      const kHi = Math.round(rvHi * 1e4) / 1e4;

      if (!this._speedPolys[kLo] || !this._speedPolys[kHi]) return null;

      const speedLo = polyval(this._speedPolys[kLo], distance);
      const angleLo = polyval(this._anglePolys[kLo], distance);

      if (kLo === kHi) return { exitSpeed: speedLo, launchAngle: angleLo };

      const speedHi = polyval(this._speedPolys[kHi], distance);
      const angleHi = polyval(this._anglePolys[kHi], distance);

      const frac = (rv - rvLo) / (rvHi - rvLo + 1e-12);
      return {
        exitSpeed:   speedLo + frac * (speedHi - speedLo),
        launchAngle: angleLo + frac * (angleHi - angleLo),
      };
    }

    speedToRpm(speedMps, mpsFactor, distanceBasedLookup = null, distance = 0) {
      const ratio = distanceBasedLookup
        ? (distanceBasedLookup[distance] ?? mpsFactor)
        : mpsFactor;
      return (speedMps / (ratio + 1e-12)) * 60;
    }

    /** Returns sampled curve data for plotting. */
    sampleCurves(distMin, distMax, nPoints = 80) {
      const dists = Array.from({ length: nPoints }, (_, i) =>
        distMin + i * (distMax - distMin) / (nPoints - 1));
      const curves = {};
      for (const rv of [-2, 0, 2]) {
        curves[rv] = {
          speeds: dists.map(d => this.predict(d, rv)?.exitSpeed ?? null),
          angles: dists.map(d => this.predict(d, rv)?.launchAngle ?? null),
        };
      }
      return { distances: dists, curves };
    }
  }

  return { polyfit, polyval, ShotPolynomialSolver };
})();
