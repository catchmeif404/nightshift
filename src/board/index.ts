import { Config } from "../config.js";
import { BoardType } from "../enums.js";
import { Board } from "./board.js";
import { GitHubBoard } from "./github.js";
import { LocalMarkdownBoard } from "./localMarkdown.js";

export function openBoard(config: Config): Board {
  switch (config.board.type) {
    case BoardType.LocalMarkdown:
      return new LocalMarkdownBoard(config.board.dir);
    case BoardType.GitHub:
      return new GitHubBoard(config.tools.gh, config.board.repos, config.board.trustedAuthors, config.root);
  }
}
