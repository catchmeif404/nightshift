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
