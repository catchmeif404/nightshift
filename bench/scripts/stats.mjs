// Spread and sample-size helpers for the phase-2 planning. No dependencies.
// Library only; used by analyze2.mjs and tested by scripts/stats.test.mjs.

export const Z = { alpha05: 1.959964, power80: 0.841621, power90: 1.281552 };

export const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
// sample standard deviation (n-1); null with fewer than 2 values
export const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
// coefficient of variation = sd / mean; null when undefined (n<2 or mean 0)
export const cv = (xs) => {
  const s = sd(xs);
  const m = xs.length ? mean(xs) : 0;
  return s === null || m === 0 ? null : s / m;
};

// Runs per arm to detect a relative difference `delta` (0.10 = 10 %) in a mean with coefficient of variation `cvValue`,
// two-sided alpha 0.05, normal approximation: n = 2 (z_a + z_b)^2 cv^2 / delta^2.
export function nPerArmForRelativeDiff(cvValue, delta, power = Z.power80) {
  if (cvValue === null || delta <= 0) return null;
  return Math.ceil((2 * (Z.alpha05 + power) ** 2 * cvValue ** 2) / delta ** 2);
}

// Runs per arm to detect pass rates p1 vs p2 (two-sided alpha 0.05, normal approximation, no continuity correction).
export function nPerArmForProportions(p1, p2, power = Z.power80) {
  if (p1 === p2) return null;
  return Math.ceil(((Z.alpha05 + power) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (p1 - p2) ** 2);
}

// Two pass rates exactly `d` apart around an observed rate p, kept inside [0.02, 0.98]: near the ceiling or the floor the
// window is shifted, not clipped (clipping one end would size a smaller difference than the one named).
export function rateWindow(p, d) {
  const lo = Math.max(0.02, Math.min(p - d / 2, 0.98 - d));
  return [lo, lo + d];
}
