// Web Worker — runs shot table generation off the main thread.
// Imported by main.js via: new Worker('worker.js')
// Messages received: { type: 'generate', config: {...} }
// Messages sent:     { type: 'progress', pct: 0-100 }
//                    { type: 'done', table: [...] }

importScripts('physics.js', 'shot_table.js');

self.onmessage = function (e) {
  if (e.data.type !== 'generate') return;
  const cfg = e.data.config;

  const {
    distMin = 1.5, distMax = 8.0, distSteps = 20,
    rvSteps  = 7,
    hoodAngleOffset = 0, mpsFactor = 1.0, spinRps = 50,
    drag = true, magnus = true,
  } = cfg;

  const distances   = linspace(distMin, distMax, distSteps);
  const radialVels  = linspace(-3.0, 3.0, rvSteps);
  const total = distances.length * radialVels.length;
  let done = 0;

  const table = [];

  for (const dist of distances) {
    for (const rv of radialVels) {
      const valid = PHYSICS.findValidShots({
        distance: dist, robotRadialVel: rv, spinRps,
        drag, magnus,
        speedSteps: 45, angleSteps: 45,   // balanced quality vs speed
      });
      const optimal = PHYSICS.selectOptimalShot(valid);

      let entry;
      if (optimal) {
        const speeds = valid.map(s => s.speed);
        const angles = valid.map(s => s.angle);
        entry = {
          distance:       dist,
          radialVelocity: rv,
          exitSpeed:      optimal.speed * mpsFactor,
          launchAngle:    optimal.angle + hoodAngleOffset,
          toleranceSpeed: PHYSICS.std(speeds),
          toleranceAngle: PHYSICS.std(angles),
          validCount:     valid.length,
        };
      } else {
        entry = {
          distance: dist, radialVelocity: rv,
          exitSpeed: 0, launchAngle: 0,
          toleranceSpeed: 0, toleranceAngle: 0, validCount: 0,
        };
      }
      table.push(entry);

      done++;
      // Post progress every 5% to avoid flooding the message queue
      if (done % Math.max(1, Math.floor(total / 20)) === 0 || done === total) {
        self.postMessage({ type: 'progress', pct: Math.round(100 * done / total) });
      }
    }
  }

  self.postMessage({ type: 'done', table });
};

function linspace(lo, hi, n) {
  return Array.from({ length: n }, (_, i) => lo + i * (hi - lo) / (n - 1));
}
