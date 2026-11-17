// Seeded random order of the 56 cells of the third comparison (TK-461). Usage: node schedule-v3.mjs [seed=461] [tasks=taskA,taskB]
// 20 full runs: per task A2 x2 (same-day rerun), A3 x4, A4 x4; 36 review runs: per task x 3 planted defects x 3 arms x 2.
// Same seed gives the same order. Anon ids are r3-001... in run order (they do not reveal the arm).
import { mulberry32 } from "./schedule-v2.mjs";

export const RUN_REPEATS = { A2: 2, A3: 4, A4: 4 };
export const REVIEW_REPEATS = 2;
export const DEFECTS = ["build", "missing", "hidden"];

export function schedule(seed, tasks) {
  const rand = mulberry32(seed);
  const cells = [
    ...tasks.flatMap((task) => Object.entries(RUN_REPEATS).flatMap(([arm, n]) => Array.from({ length: n }, () => ({ kind: "run", task, arm })))),
    ...tasks.flatMap((task) => DEFECTS.flatMap((defect) => Object.keys(RUN_REPEATS).flatMap((arm) => Array.from({ length: REVIEW_REPEATS }, () => ({ kind: "review", task, defect, arm }))))),
  ];
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  return cells.map((c, i) => ({ ...c, id: `r3-${String(i + 1).padStart(3, "0")}` }));
}

// The command-line arguments of run-v3.mjs for one cell.
export function argsFor(cell) {
  return cell.kind === "run" ? ["run", cell.task, cell.arm, cell.id] : ["review", cell.task, cell.defect, cell.arm, cell.id];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 461);
  const tasks = (process.argv[3] ?? "t1,t2").split(",");
  for (const c of schedule(seed, tasks)) console.log(`${c.id} ${argsFor(c).join(" ")}`);
}
