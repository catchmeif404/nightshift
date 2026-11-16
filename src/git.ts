import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brand } from "./brand.js";
import { Config, ProjectConfig } from "./config.js";
import { GitHubState } from "./enums.js";
import { run } from "./exec.js";
import { safeId } from "./state.js";

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

// The runner, not the agent, makes the worktree: every ticket works on its own branch,
// never in the checkout you are using. A resumed ticket gets the same worktree back.
export async function ensureWorktree(config: Config, project: ProjectConfig, tree: Worktree): Promise<Worktree> {
  if (existsSync(tree.path)) return tree;
  const repo = project.repoPath;
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

// Files the ticket's branch changed against the base branch (since the point it forked), committed or not.
// Throws GitError when git cannot tell: the caller must not read that as "nothing changed".
export async function changedFiles(config: Config, project: ProjectConfig, tree: Worktree): Promise<string[]> {
  const hasOrigin = await succeeds(config, project.repoPath, ["remote", "get-url", "origin"]);
  const base = hasOrigin ? `origin/${project.baseBranch}` : project.baseBranch;
  const fork = await git(config, tree.path, ["merge-base", base, "HEAD"]);
  const out = await run(config.tools.git, ["diff", "--name-only", "--no-renames", "-z", fork], tree.path);
  if (out.code !== 0) throw new GitError(`git diff ${fork}: ${out.stderr.trim()}`);
  return out.stdout.split("\0").filter((f) => f !== "");
}
