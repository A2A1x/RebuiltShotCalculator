// Shot table — 2D polynomial surface fit.
//
// Fits a single degree-3 polynomial in two variables:
//   (exit_speed, launch_angle) = f(distance, radial_velocity)
//
// Basis monomials: all d^a · v^b with a+b ≤ degree
//   degree 3 → 10 terms: 1, d, v, d², d·v, v², d³, d²·v, d·v², v³
//
// Least-squares normal equations solved via Gauss-Jordan with partial pivoting.

const SHOT_TABLE = (() => {

  // ── 2D polynomial math ────────────────────────────────────────────────────

  /**
   * Enumerate all basis monomials d^a · v^b with a+b ≤ degree.
   * Returns [[a0,b0], [a1,b1], …] ordered by total degree then d-exponent desc.
   */
  function basisTerms(degree) {
    const terms = [];
    for (let total = 0; total <= degree; total++) {
      for (let a = total; a >= 0; a--) {
        terms.push([a, total - a]);
      }
    }
    return terms;  // e.g. degree=3 → [[0,0],[1,0],[0,1],[2,0],[1,1],[0,2],[3,0],[2,1],[1,2],[0,3]]
  }

  /** Evaluate every basis term at the point (d, v). */
  function evalBasis(terms, d, v) {
    return terms.map(([a, b]) => Math.pow(d, a) * Math.pow(v, b));
  }

  /**
   * Least-squares 2D polynomial fit.
   * ds, vs — arrays of input coords; ys — target values (all length n).
   * Returns { coeffs: Float64Array, terms: [a,b][] }.
   */
  function polyfit2D(ds, vs, ys, degree) {
    const terms = basisTerms(degree);
    const m = terms.length;
    const n = ds.length;

    const AtA = Array.from({ length: m }, () => new Float64Array(m));
    const Aty = new Float64Array(m);

    for (let i = 0; i < n; i++) {
      const row = evalBasis(terms, ds[i], vs[i]);
      for (let r = 0; r < m; r++) {
        Aty[r] += row[r] * ys[i];
        for (let c = 0; c < m; c++) AtA[r][c] += row[r] * row[c];
      }
    }

    // Gauss-Jordan elimination on augmented matrix [AtA | Aty]
    const aug = AtA.map((row, i) => [...row, Aty[i]]);
    for (let col = 0; col < m; col++) {
      let pivotRow = col;
      for (let row = col + 1; row < m; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[pivotRow][col])) pivotRow = row;
      }
      [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-14) continue;
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
    return { coeffs, terms };
  }

  /** Evaluate a fitted 2D polynomial at (d, v). */
  function polyval2D(poly, d, v) {
    let result = 0;
    for (let i = 0; i < poly.coeffs.length; i++) {
      result += poly.coeffs[i] * Math.pow(d, poly.terms[i][0]) * Math.pow(v, poly.terms[i][1]);
    }
    return result;
  }

  // ── Legacy 1D helpers (kept for API compatibility) ────────────────────────

  /** 1D least-squares polyfit. Coefficients in descending order: [c_n, …, c_0]. */
  function polyfit(xs, ys, degree) {
    const n = xs.length;
    const m = degree + 1;
    const AtA = Array.from({ length: m }, () => new Float64Array(m));
    const Aty = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const pow = new Float64Array(m);
      pow[0] = 1;
      for (let k = 1; k < m; k++) pow[k] = pow[k - 1] * xs[i];
      for (let r = 0; r < m; r++) {
        const ar = pow[degree - r];
        Aty[r] += ar * ys[i];
        for (let c = 0; c < m; c++) AtA[r][c] += ar * pow[degree - c];
      }
    }
    const aug = AtA.map((row, i) => [...row, Aty[i]]);
    for (let col = 0; col < m; col++) {
      let pivotRow = col;
      for (let row = col + 1; row < m; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[pivotRow][col])) pivotRow = row;
      }
      [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-14) continue;
      for (let row = 0; row < m; row++) {
        if (row === col) continue;
        const factor = aug[row][col] / pivot;
        for (let j = col; j <= m; j++) aug[row][j] -= factor * aug[col][j];
      }
    }
    const coeffs = new Float64Array(m);
    for (let i = 0; i < m; i++) coeffs[i] = aug[i][m] / aug[i][i];
    return coeffs;
  }

  /** Evaluate a 1D polynomial (descending-order coefficients) via Horner's method. */
  function polyval(coeffs, x) {
    let result = 0;
    for (let i = 0; i < coeffs.length; i++) result = result * x + coeffs[i];
    return result;
  }

  // ── 2D Polynomial solver ──────────────────────────────────────────────────

  class ShotPolynomialSolver {
    constructor(degree = 3) {
      this.degree = degree;
      this._speedPoly = null;   // { coeffs: Float64Array, terms: [a,b][] }
      this._anglePoly = null;
      this._distMin = 0;
      this._distMax = 10;
      this._rvMin   = -3;
      this._rvMax   =  3;
    }

    /**
     * Fit 2D polynomials to all table entries simultaneously.
     * Entry format: { distance, radialVelocity, exitSpeed, launchAngle, validCount }
     */
    fit(tableEntries) {
      const entries = tableEntries.filter(e => e.validCount > 0);
      const minPoints = basisTerms(this.degree).length;
      if (entries.length < minPoints) return;

      const ds     = entries.map(e => e.distance);
      const vs     = entries.map(e => e.radialVelocity);
      const speeds = entries.map(e => e.exitSpeed);
      const angles = entries.map(e => e.launchAngle);

      this._distMin = Math.min(...ds);
      this._distMax = Math.max(...ds);
      this._rvMin   = Math.min(...vs);
      this._rvMax   = Math.max(...vs);

      this._speedPoly = polyfit2D(ds, vs, speeds, this.degree);
      this._anglePoly = polyfit2D(ds, vs, angles, this.degree);
    }

    /**
     * Evaluate (exitSpeed, launchAngle) for any (distance, radialVel).
     * Inputs are clamped to the fitted data range.
     */
    predict(distance, radialVel = 0) {
      if (!this._speedPoly) return null;
      const d = Math.max(this._distMin, Math.min(this._distMax, distance));
      const v = Math.max(this._rvMin,   Math.min(this._rvMax,   radialVel));
      return {
        exitSpeed:   polyval2D(this._speedPoly, d, v),
        launchAngle: polyval2D(this._anglePoly, d, v),
      };
    }

    speedToRpm(speedMps, mpsFactor) {
      return (speedMps / (mpsFactor + 1e-12)) * 60;
    }

    /**
     * Return all polynomial coefficients as a plain, JSON-serialisable object.
     *
     * `terms[i]` = [d_exponent, v_exponent]
     * Polynomial: Σ speedCoeffs[i] · d^terms[i][0] · v^terms[i][1]
     */
    getCoefficients() {
      if (!this._speedPoly) {
        return { degree: this.degree, terms: [], speedCoeffs: [], angleCoeffs: [] };
      }
      return {
        degree:      this.degree,
        terms:       this._speedPoly.terms,
        speedCoeffs: Array.from(this._speedPoly.coeffs),
        angleCoeffs: Array.from(this._anglePoly.coeffs),
      };
    }

    /** Returns sampled curve data for three rv slices — used by Poly Curves chart. */
    sampleCurves(distMin, distMax, nPoints = 80) {
      const dists = Array.from({ length: nPoints }, (_, i) =>
        distMin + i * (distMax - distMin) / (nPoints - 1));
      const curves = {};
      for (const rv of [-2, 0, 2]) {
        curves[rv] = {
          speeds: dists.map(d => this.predict(d, rv)?.exitSpeed  ?? null),
          angles: dists.map(d => this.predict(d, rv)?.launchAngle ?? null),
        };
      }
      return { distances: dists, curves };
    }
  }

  return { polyfit, polyval, polyfit2D, polyval2D, basisTerms, ShotPolynomialSolver };
})();
