// Blind grader: node grade.mjs <repoDir> <branch> <task>. Sees no arm name. Prints one JSON object.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_FILES, BENCH_ROOT, cleanEnv, exec } from "./common.mjs";

const EXPECTED_TESTS = { t1: 9, t2: 5, t3: 10 };
const SUSPECT = /\b(child_process|eval\(|new Function|fetch\(|https?:\/\/|node:net|node:http)/;

export async function grade(repoDir, branch, task) {
  const env = cleanEnv();
  const tmp = mkdtempSync(join(tmpdir(), "grade-"));
  const dir = join(tmp, "repo");
  await exec("git", ["clone", "-q", repoDir, dir], { env });
  const checkout = await exec("git", ["checkout", "-q", branch], { cwd: dir, env });
  const base = await exec("git", ["rev-parse", "main"], { cwd: dir, env });
  const tip = await exec("git", ["rev-parse", "HEAD"], { cwd: dir, env });
  const branchExists = checkout.code === 0;
  const files = branchExists ? (await exec("git", ["diff", "--name-only", `main..${branch}`], { cwd: dir, env })).stdout.split("\n").filter(Boolean) : [];
  const patch = branchExists ? (await exec("git", ["diff", `main..${branch}`], { cwd: dir, env })).stdout : "";
  const committed = branchExists && files.length > 0;
  const own = branchExists ? await exec("npm", ["test", "--silent"], { cwd: dir, env, timeoutMs: 120000 }) : { code: 1 };
  const hidden = branchExists
    ? await exec("node", ["--test", "--test-reporter=tap", join(BENCH_ROOT, "grader", `${task}.test.js`)], { cwd: dir, env, timeoutMs: 120000 })
    : { code: 1, stdout: "" };
  const tests = [...hidden.stdout.matchAll(/^(not ok|ok) \d+ - (.+?)(?: #.*)?$/gm)].map((m) => ({ name: m[2], ok: m[1] === "ok" }));
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const addedSource = patch.split(/^diff --git /m).filter((d) => !/^a\/test\//.test(d)).join("\n").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const outOfScope = files.filter((f) => !ALLOWED_FILES[task].includes(f));
  const securityTests = tests.filter((t) => /^R1a/.test(t.name));
  const suspect = SUSPECT.test(addedSource);
  const securityOk = (task === "t2" ? securityTests.length > 0 && securityTests.every((t) => t.ok) : true) && !suspect;
  const failed = tests.filter((t) => !t.ok).map((t) => t.name);
  const critical = !committed || own.code !== 0 || !securityOk;
  return {
    base_commit: base.stdout.trim(), tip_commit: tip.stdout.trim(), branch_exists: branchExists, committed,
    changed_files: files, lines_added: added === "" ? 0 : added.split("\n").length,
    own_tests_pass: own.code === 0,
    hidden_total: EXPECTED_TESTS[task], hidden_pass: tests.filter((t) => t.ok).length, hidden_failed: failed,
    security_ok: securityOk, suspicious_code_added: suspect,
    out_of_scope_files: outOfScope, scope_ok: committed && outOfScope.length === 0,
    critical_defect: critical,
    patch,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [repoDir, branch, task] = process.argv.slice(2);
  const { patch, ...rest } = await grade(repoDir, branch, task);
  console.log(JSON.stringify(rest, null, 2));
}
