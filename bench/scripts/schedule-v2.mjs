// Seeded random order of the 24 runs (2 tasks x 3 arms x 4 repeats). Usage: node schedule-v2.mjs [seed] [tasks=t1,t2]
// Same seed gives the same order. Anon ids are r2-001... in run order (they do not reveal the arm).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function schedule(seed, tasks, arms = ["B0", "B2", "A2"], repeats = 4) {
  const rand = mulberry32(seed);
  const cells = tasks.flatMap((task) => arms.flatMap((arm) => Array.from({ length: repeats }, () => ({ task, arm }))));
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  return cells.map((c, i) => ({ ...c, id: `r2-${String(i + 1).padStart(3, "0")}` }));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 458);
  const tasks = (process.argv[3] ?? "t1,t2").split(",");
  for (const c of schedule(seed, tasks)) console.log(`${c.task} ${c.arm} ${c.id}`);
}
