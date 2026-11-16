# 설치

[English](../INSTALL.md) | [한국어](INSTALL.md)

## 필요한 것

| | 이유 | 확인 |
|---|---|---|
| Node.js 20 이상 | nightshift는 Node CLI입니다 | `node --version` |
| git | 티켓마다 자기 worktree와 브랜치를 만듭니다 | `git --version` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (로그인) | 만들고 검토하는 기본 에이전트 | `claude --version` 후 `claude`를 한 번 실행해 로그인 |
| [GitHub CLI](https://cli.github.com/) (로그인) | GitHub Issues 보드나 PR을 쓸 때만 | `gh auth status` |
| [Codex CLI](https://github.com/openai/codex) (로그인) | Codex가 만들거나 검토할 때만 | `codex --version`, `codex login` |
| Notion 통합 시크릿 | Notion 보드를 쓸 때만 | [Notion을 보드로](USAGE.md#notion을-보드로) |

nightshift는 Claude Code를 `--permission-mode auto`로 무인 실행합니다. 먼저 터미널에서 `claude`를 한 번 열어 혼자
잘 동작하는지 확인하세요. 실행은 평소 Claude Code 로그인과 설정(전역 `~/.claude/CLAUDE.md` 포함)을 그대로 씁니다.

## CLI 설치

npm에서:

```sh
npm install -g @catchmeif404/nightshift
nightshift --help
```

소스에서:

```sh
git clone https://github.com/catchmeif404/nightshift.git
cd nightshift
npm install
npm run build
npm link            # PATH 에 nightshift 명령을 올림
nightshift --help
```

소스 설치 업데이트: `git pull && npm install && npm run build`.

## 큐 폴더 만들기

nightshift는 설정·티켓·상태를 코드와 떨어진 폴더 하나에 둡니다. 저장소는 어디에 있어도 되고, 설정이 그 경로를 가리킵니다.

```sh
mkdir ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/my-app
nightshift doctor
```

`init`이 만드는 것:

| 파일 | 내용 |
|---|---|
| `nightshift.json` | 설정: 보드, 프로젝트, 모델, 한도 |
| `nightshift.rules.md` | 모든 프롬프트에 붙는 팀 규칙. 직접 고치세요 |
| `.tickets/` | 로컬 티켓 보드 (`--board local-md`일 때) |

처음 실행하면 로그·worktree·실행 상태를 담는 `.nightshift/`가 생깁니다. 백업은 괜찮지만 git에는 넣지 마세요.

`doctor`는 Node, git, 에이전트 CLI, 필요하면 `gh`, 그리고 각 프로젝트 경로가 git 저장소인지 확인합니다. `FAIL`이
있으면 첫 실행 전에 고치세요.

다음: [처음 시작하기](GETTING-STARTED.md).

## 지우기

```sh
npm uninstall -g @catchmeif404/nightshift      # 소스 설치는: npm unlink -g @catchmeif404/nightshift
rm -rf ~/nightshift-queue        # 큐 폴더: 설정, 티켓, 로그, worktree
```

nightshift가 만든 worktree는 각 저장소에 등록돼 있으니, 큐 폴더를 지운 뒤 저장소마다 `git worktree prune`을 실행하세요.
nightshift가 만든 브랜치는 `nightshift/`로 시작하고, 직접 지우기 전까지 남습니다.
