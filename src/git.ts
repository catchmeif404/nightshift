import { existsSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Brand } from "./brand.js";
import { Config, ProjectConfig } from "./config.js";
import { GitHubState, Mergeable } from "./enums.js";
import { run } from "./exec.js";
import { safeId } from "./state.js";

// GitHub may still be working out a pull request's mergeable field right after a push.
const MERGEABLE_ATTEMPTS = 3;
const MERGEABLE_PAUSE_MS = 2000;

export class GitError extends Error {}

export interface Worktree {
  path: string;
  branch: string;
}

export function worktreeFor(worktreesDir: string, ticketId: string): Worktree {
  const id = safeId(ticketId).toLowerCase();
  return { path: join(worktreesDir, id), branch: `${Brand.branchPrefix}${id}` };
}

async function git(config: Config, cwd: string, args: string[]): Promise<string> {
  const result = await run(config.tools.git, args, cwd);
  if (result.code !== 0) throw new GitError(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function succeeds(config: Config, cwd: string, args: string[]): Promise<boolean> {
  return (await run(config.tools.git, args, cwd)).code === 0;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// The folders git knows as worktrees of the repository (the main checkout included), as real paths. Throws when git cannot say.
// An entry git marks prunable (its folder lost the .git file, e.g. only build leftovers remain) does not count.
export async function knownWorktrees(config: Config, repo: string): Promise<Set<string>> {
  const result = await run(config.tools.git, ["worktree", "list", "--porcelain"], repo);
  if (result.code !== 0) throw new GitError(`git worktree list in ${repo}: ${result.stderr.trim()}`);
  const prefix = "worktree ";
  const known = new Set<string>();
  for (const block of result.stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const head = lines.find((l) => l.startsWith(prefix));
    if (head === undefined || lines.some((l) => l.startsWith("prunable"))) continue;
    known.add(real(head.slice(prefix.length).trim()));
  }
  return known;
}

// Where a leftover folder is moved to: next to it, with the time in the name.
function asidePath(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 18);
  return `${path}.old-${stamp}`;
}

// The runner, not the agent, makes the worktree: every ticket works on its own branch,
// never in the checkout you are using. A resumed ticket gets the same worktree back.
// A folder at the path that git does not know as this repository's worktree (build leftovers, say) is moved aside,
// never deleted, and a new worktree is made.
export async function ensureWorktree(config: Config, project: ProjectConfig, tree: Worktree, log: (line: string) => void = () => undefined): Promise<Worktree> {
  const repo = project.repoPath;
  if (existsSync(tree.path)) {
    if ((await knownWorktrees(config, repo)).has(real(tree.path))) return tree;
    const aside = asidePath(tree.path);
    try {
      renameSync(tree.path, aside);
    } catch (error) {
      throw new GitError(`${tree.path} exists but git does not know it as a worktree of ${repo}, and it could not be moved aside: ${error instanceof Error ? error.message : String(error)}`);
    }
    log(`${tree.path} is not a git worktree of ${repo}; moved it to ${aside} and made a new worktree`);
    await run(config.tools.git, ["worktree", "prune"], repo);
  }
  if (!(await succeeds(config, repo, ["rev-parse", "--git-dir"]))) {
    throw new GitError(`${repo} is not a git repository`);
  }
  let start = project.baseBranch;
  if (await succeeds(config, repo, ["remote", "get-url", "origin"])) {
    await git(config, repo, ["fetch", "--quiet", "origin", project.baseBranch]);
    start = `origin/${project.baseBranch}`;
  }
  if (await succeeds(config, repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`])) {
    await git(config, repo, ["worktree", "add", tree.path, tree.branch]);
  } else {
    await git(config, repo, ["worktree", "add", "-b", tree.branch, tree.path, start]);
  }
  return tree;
}

// The repository's shared git folder (objects, refs, the worktree's index). A sandboxed agent must be able to write
// there to commit from a worktree, since it lives outside the worktree folder.
export async function gitCommonDir(config: Config, tree: Worktree): Promise<string> {
  const result = await run(config.tools.git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], tree.path);
  return result.code === 0 ? result.stdout.trim() : "";
}

// Leaves a worktree with uncommitted changes alone; the branch always stays.
export async function removeWorktree(config: Config, project: ProjectConfig, tree: Worktree): Promise<boolean> {
  if (!existsSync(tree.path)) return true;
  return succeeds(config, project.repoPath, ["worktree", "remove", tree.path]);
}

export async function pullRequestState(config: Config, url: string): Promise<GitHubState> {
  const result = await run(config.tools.gh, ["pr", "view", url, "--json", "state", "-q", ".state"], config.root);
  const state = result.stdout.trim();
  return Object.values(GitHubState).find((s) => s === state) ?? GitHubState.Unknown;
}

// Runs outside any checkout, so --delete-branch removes only the remote branch: the local one
// may still be checked out in the ticket's worktree.
export async function mergePullRequest(config: Config, url: string): Promise<string> {
  const result = await run(config.tools.gh, ["pr", "merge", url, "--merge", "--delete-branch"], tmpdir());
  return result.code === 0 ? "" : result.stderr.trim() || `gh pr merge exited ${result.code}`;
}

export interface GateHit {
  glob: string;
  files: string[];
}

// Glob over a repository-relative path with "/" separators: "**" crosses folders (a "**/" prefix also matches
// no folder at all), "*" and "?" stay inside one folder name. The whole path must match; a leading "./" or "/" is ignored.
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.?\//, "");
  let out = "";
  for (let i = 0; i < g.length; i += 1) {
    const c = g.charAt(i);
    if (c === "*" && g.charAt(i + 1) === "*") {
      const slash = g.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function gateHits(globs: string[], files: string[]): GateHit[] {
  return globs
    .map((glob) => ({ glob, files: files.filter((f) => globToRegExp(glob).test(f)) }))
    .filter((hit) => hit.files.length > 0);
}

// The base branch as the worktree sees it: origin's copy when the repository has an origin.
export async function baseRef(config: Config, project: ProjectConfig): Promise<string> {
  return (await succeeds(config, project.repoPath, ["remote", "get-url", "origin"])) ? `origin/${project.baseBranch}` : project.baseBranch;
}

// What GitHub says about the pull request right now. GitHub works the field out lazily, so UNKNOWN is asked again a few times.
export async function pullRequestMergeable(config: Config, url: string, pauseMs: number = MERGEABLE_PAUSE_MS): Promise<Mergeable> {
  let state = Mergeable.Unknown;
  for (let attempt = 0; attempt < MERGEABLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(pauseMs);
    const result = await run(config.tools.gh, ["pr", "view", url, "--json", "mergeable", "-q", ".mergeable"], config.root);
    const word = result.stdout.trim();
    state = result.code === 0 ? (Object.values(Mergeable).find((m) => m === word) ?? Mergeable.Unknown) : Mergeable.Unknown;
    if (state !== Mergeable.Unknown) return state;
  }
  return state;
}

// Files that would conflict if the base branch were merged into the worktree's branch now (git merge-tree, nothing is touched).
// Empty when there is no conflict or git cannot tell (an old git without --write-tree): the developer then finds them itself.
export async function conflictFiles(config: Config, project: ProjectConfig, tree: Worktree): Promise<string[]> {
  const base = await baseRef(config, project);
  if (base.startsWith("origin/")) await run(config.tools.git, ["fetch", "--quiet", "origin", project.baseBranch], tree.path);
  const out = await run(config.tools.git, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, "HEAD"], tree.path);
  if (out.code !== 1) return [];
  // "<tree oid>\0<file>\0<file>\0\0<messages>": the names end at the first empty entry.
  const parts = out.stdout.split("\0").slice(1);
  const end = parts.indexOf("");
  return (end < 0 ? parts : parts.slice(0, end)).filter((f) => f !== "");
}

// Files the ticket's branch changed against the base branch (since the point it forked), committed or not.
// Throws GitError when git cannot tell: the caller must not read that as "nothing changed".
export async function changedFiles(config: Config, project: ProjectConfig, tree: Worktree): Promise<string[]> {
  const base = await baseRef(config, project);
  const fork = await git(config, tree.path, ["merge-base", base, "HEAD"]);
  const out = await run(config.tools.git, ["diff", "--name-only", "--no-renames", "-z", fork], tree.path);
  if (out.code !== 0) throw new GitError(`git diff ${fork}: ${out.stderr.trim()}`);
  return out.stdout.split("\0").filter((f) => f !== "");
}

// What a span of commits changed: files touched and lines added / removed.
export interface DiffSize {
  files: number;
  added: number;
  removed: number;
}

export const NO_DIFF: DiffSize = { files: 0, added: 0, removed: 0 };

// Reads `git diff --numstat` output. A binary file counts as a file with no lines.
export function parseNumstat(text: string): DiffSize {
  const size: DiffSize = { files: 0, added: 0, removed: 0 };
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t.+$/.exec(line);
    if (m === null) continue;
    size.files += 1;
    size.added += Number(m[1]) || 0;
    size.removed += Number(m[2]) || 0;
  }
  return size;
}

export async function headCommit(config: Config, tree: Worktree): Promise<string> {
  return git(config, tree.path, ["rev-parse", "HEAD"]);
}

// Committed changes from `from` to the worktree's current HEAD (the reviewer's own commits).
export async function diffSince(config: Config, tree: Worktree, from: string): Promise<DiffSize> {
  const out = await git(config, tree.path, ["diff", "--numstat", "--no-renames", from, "HEAD"]);
  return parseNumstat(out);
}
