import { Brand } from "../brand.js";
import { GitHubState, SettleReason, TicketKind, TicketStatus } from "../enums.js";
import { run } from "../exec.js";
import { Board, Ticket, oldestFirst } from "./board.js";

export function statusLabel(status: TicketStatus): string {
  return `${Brand.labelPrefix}${status}`;
}

export const RELEASE_LABEL = `${Brand.labelPrefix}${TicketKind.Release}`;

// Every label the runner uses, with a color, for "init".
export function boardLabels(): Array<{ name: string; color: string; description: string }> {
  const colors: Record<TicketStatus, string> = {
    [TicketStatus.Ready]: "0E8A16",
    [TicketStatus.Working]: "FBCA04",
    [TicketStatus.Review]: "1D76DB",
    [TicketStatus.Blocked]: "B60205",
    [TicketStatus.Done]: "5319E7",
  };
  const labels = Object.values(TicketStatus).map((s) => ({
    name: statusLabel(s),
    color: colors[s],
    description: `${Brand.name}: ${s}`,
  }));
  labels.push({ name: RELEASE_LABEL, color: "000000", description: `${Brand.name}: runs alone` });
  return labels;
}

interface IssueJson {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  author: { login: string };
  labels: Array<{ name: string }>;
}

function isIssue(value: unknown): value is IssueJson {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.number === "number" && typeof v.title === "string" && Array.isArray(v.labels);
}

export function splitId(id: string): { repo: string; number: string } {
  const at = id.lastIndexOf("#");
  return { repo: id.slice(0, at), number: id.slice(at + 1) };
}

export class GitHubError extends Error {}

// GitHub Issues as the board: one label per status. The project of an issue is its repo ("owner/name").
// Only issues opened by a trusted author run: on a public repo anyone can open an issue,
// and an issue is a prompt.
export class GitHubBoard implements Board {
  readonly name = "GitHub Issues";

  constructor(
    private readonly gh: string,
    private readonly repos: string[],
    private readonly trustedAuthors: string[],
    private readonly cwd: string,
  ) {}

  private async call(args: string[]): Promise<string> {
    const result = await run(this.gh, args, this.cwd);
    if (result.code !== 0) throw new GitHubError(`gh ${args.slice(0, 2).join(" ")}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async list(status: TicketStatus): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const repo of this.repos) {
      const out = await this.call([
        "issue", "list", "--repo", repo, "--state", "open", "--label", statusLabel(status),
        "--limit", "100", "--json", "number,title,body,createdAt,author,labels",
      ]);
      const parsed: unknown = JSON.parse(out);
      if (!Array.isArray(parsed)) continue;
      for (const issue of parsed.filter(isIssue)) {
        if (!this.trustedAuthors.includes(issue.author.login)) continue;
        const labels = issue.labels.map((l) => l.name);
        tickets.push({
          id: `${repo}#${issue.number}`,
          title: issue.title,
          body: issue.body,
          project: repo,
          kind: labels.includes(RELEASE_LABEL) ? TicketKind.Release : TicketKind.Build,
          status,
          createdAt: issue.createdAt,
        });
      }
    }
    return tickets.sort(oldestFirst);
  }

  async setStatus(id: string, status: TicketStatus, _reason: SettleReason, note: string): Promise<void> {
    const { repo, number } = splitId(id);
    const view: unknown = JSON.parse(await this.call(["issue", "view", number, "--repo", repo, "--json", "labels,state"]));
    const current = isIssueView(view) ? view.labels.map((l) => l.name) : [];
    const stale = Object.values(TicketStatus)
      .map(statusLabel)
      .filter((label) => label !== statusLabel(status) && current.includes(label));
    const args = ["issue", "edit", number, "--repo", repo, "--add-label", statusLabel(status)];
    if (stale.length > 0) args.push("--remove-label", stale.join(","));
    await this.call(args);
    if (note !== "") await this.addNote(id, note);
    if (status === TicketStatus.Done && isIssueView(view) && view.state === GitHubState.Open) {
      await this.call(["issue", "close", number, "--repo", repo]);
    }
  }

  async addNote(id: string, note: string): Promise<void> {
    const { repo, number } = splitId(id);
    await this.call(["issue", "comment", number, "--repo", repo, "--body", `**${Brand.name}**: ${note}`]);
  }
}

interface IssueView {
  state: string;
  labels: Array<{ name: string }>;
}

function isIssueView(value: unknown): value is IssueView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === "string" && Array.isArray(v.labels);
}
