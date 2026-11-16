# 사용법

[English](../USAGE.md) | [한국어](USAGE.md)

- [하루 흐름](#하루-흐름)
- [좋은 티켓 쓰기](#좋은-티켓-쓰기)
- [상태별 뜻](#상태별-뜻)
- [GitHub Issues 와 PR](#github-issues-와-pr)
- [계속 돌리기](#계속-돌리기)
- [팀 규칙, 사람 결정 게이트, 출시 티켓](#팀-규칙-사람-결정-게이트-출시-티켓)
- [모델, 비용, 내 Claude Code 설정](#모델-비용-내-claude-code-설정)
- [Claude Code 대신 (또는 함께) Codex](#claude-code-대신-또는-함께-codex)
- [Notion을 보드로](#notion을-보드로)
- [그 밖의 에이전트와 트래커](#그-밖의-에이전트와-트래커)
- [문제 해결](#문제-해결)

## 하루 흐름

1. 티켓 쓰기: `nightshift add`(로컬 보드) 또는 `nightshift:ready` 라벨을 단 이슈(GitHub).
2. 돌리기: `nightshift run` 한 번, 또는 계속 돌게 두기(아래).
3. 세 무더기를 확인: **review**(통과, 머지만 남음), **blocked**(사유나 내가 정할 일), **done**(`autoMerge`로 머지됨).

```sh
nightshift status      # 작업자와 상태별 티켓
nightshift logs -n 100 # 무슨 일이 있었는지
```

## 좋은 티켓 쓰기

티켓은 나에게 아무것도 물어볼 수 없는 두 실행의 프롬프트가 됩니다. 새 팀원에게 주는 티켓처럼 쓰세요.

- **변경 하나.** "보고서 개선"이 아니라 "보고서 화면에 CSV 내보내기 추가".
- **끝의 기준.** "내보내기 버튼이 표와 같은 열의 CSV를 내려받고, 테스트가 있으면 끝." 검토자는 이걸로 판정합니다.
- **어디.** 이미 아는 파일, 화면, 엔드포인트.
- **이미 정한 것.** 쓸 라이브러리, 이름, 건드리지 말 곳.

너무 큰 티켓은 `REWORK`나 `BLOCKED`로 돌아오기 쉽습니다. 나누세요.

## 상태별 뜻

| 상태 | 뜻 | 내가 할 일 |
|---|---|---|
| `ready` | 작업자 기다리는 중 | 없음 |
| `working` | 작업자가 맡음. 메모에 단계가 나옴. 끊긴 실행은 다음 `run`에서 이어 감 | 없음 |
| `review` | 검토 통과. 메모에 위치(브랜치나 PR)가 있음 | 검토 의견 읽고 머지 |
| `blocked` | 마지막 메모에 사유: 개발자가 못 끝냄, 검토자가 멈춤, 사람 결정 필요(`needs-human`), 단계가 3번 끊김 | 결정하거나 고친 뒤 다시 `ready` |
| `done` | 머지됨(`autoMerge` PR) 또는 문서 통과 | 없음 |

막힌 티켓을 다시 `ready`로 두면 빌드 단계부터 새로 시작합니다. 브랜치와 열린 PR은 그대로 다시 써서, 하던 데서 이어집니다.

## GitHub Issues 와 PR

```sh
gh auth login                       # 한 번
nightshift init --board github --repo 나/my-app --repo-path ~/code/my-app
```

라벨(`nightshift:ready`, `:working`, `:review`, `:blocked`, `:done`, `:release`)을 만들고, 로그인한 `gh` 사용자를
믿을 수 있는 작성자로 넣습니다. `board.trustedAuthors`가 연 이슈만 돕니다. 공개 저장소에서는 누구나 이슈를 열 수 있고,
이슈는 곧 프롬프트이기 때문입니다. 사람을 더하려면 `--trusted alice,bob`이나 `nightshift.json`을 고치세요.

일을 맡기려면 이슈에 `nightshift:ready` 라벨을 답니다. 개발자가 브랜치를 push하고 PR을 열고, 검토자가 확인하며 작은
문제는 브랜치에서 직접 고치고, 이슈는 PR 링크와 검토 내용이 담긴 댓글과 함께 `nightshift:review`로 갑니다. 저장소에
push할 수 있는 `origin` 원격이 있어야 합니다. (검토를 PR 댓글로도 남기고 싶으면 `nightshift.rules.md`에 적으세요.)

`"autoMerge": true`면 통과한 PR을 nightshift가 직접 머지하고(`gh pr merge --merge --delete-branch`), 이슈를 닫고,
`postMergeCommand`를 실행합니다. 머지가 안 되는 PR(충돌, 필수 검사 실패)은 사유와 함께 `review`에 남습니다. 한동안
지켜보기 전에는 `autoMerge`를 꺼 두세요.

## 계속 돌리기

`nightshift run`은 준비된 것을 띄우고 끝나고, 작업자는 백그라운드에서 계속 돕니다. 새 티켓과 끊긴 실행을 이어 가려면
누군가 다시 불러야 합니다.

**터미널에서:** `nightshift daemon` (`daemonIntervalMinutes`마다, 기본 15분).

**cron** (macOS, Linux). cron은 PATH가 짧으니 `node`, `claude`, `git`, `gh`가 있는 폴더를 넣어 주세요(`which node claude`로 확인).

```cron
*/15 * * * * cd $HOME/nightshift-queue && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin nightshift run >> .nightshift/cron.log 2>&1
```

**launchd** (macOS). `~/Library/LaunchAgents/dev.nightshift.queue.plist`로 저장한 뒤
`launchctl load ~/Library/LaunchAgents/dev.nightshift.queue.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.nightshift.queue</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/nightshift-queue &amp;&amp; nightshift run</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/nightshift-queue.log</string>
  <key>StandardErrorPath</key><string>/tmp/nightshift-queue.log</string>
</dict></plist>
```

배차는 한 번에 하나만 돕니다(`.nightshift/` 안의 잠금). 겹쳐 불러도 안전합니다.

## 팀 규칙, 사람 결정 게이트, 출시 티켓

**`nightshift.rules.md`**는 프로젝트의 모든 프롬프트에 붙습니다(`projects.<이름>.rulesFile`). 저장소의 `CLAUDE.md` /
`AGENTS.md`에 없는 것을 적으세요: 테스트 명령, 커밋 방식, 건드리면 안 되는 폴더, PR 쓰는 법.

**사람 결정 게이트**(`humanGates`, 기본 전부 켜짐): `money`, `legal`, `destructive-data`, `outward-facing`,
`product-direction`. 변경이 여기에 걸리면 검토자가 `NEEDS_HUMAN`으로 답하고 내가 정할 것, 선택지, 추천을 적습니다.
티켓은 그 내용과 함께 `blocked`가 되고, 게이트에 걸린 것은 머지되지 않습니다.

**출시 티켓**(`add`의 `--release`, 또는 `nightshift:release` 라벨)은 혼자 돌며, 규칙 파일을 따르는 검토 모델 실행 한 번입니다.
규칙 파일에 출시 절차(태그, 배포, 실서비스 확인 방법)를 적어 두세요. 실행은 `DONE`이나 `BLOCKED`로 답합니다.

## 모델, 비용, 내 Claude Code 설정

- 기본: `sonnet`이 만들고 `opus`가 검토합니다. `nightshift.json`의 `builder.model` / `reviewer.model`로 바꿉니다.
- 티켓 하나는 Claude Code 실행 최소 2번, 재작업이 있으면 4번입니다. 구독 요금제면 사용량 한도에서 빠지고, 한도에
  걸리면 실행이 끊겼다가 나중에(`resumeCooldownMinutes` 뒤) 이어집니다.
- 실행은 내 Claude Code를 그대로 씁니다: 로그인, `~/.claude/settings.json` 권한, 전역 `~/.claude/CLAUDE.md`
  ("한국어로 답해"라고 돼 있으면 실행 요약도 한국어).
- 쓰는 서비스의 약관이 무인 실행을 허용하는지 확인하세요.

## Claude Code 대신 (또는 함께) Codex

기본은 Claude Code `sonnet`이 만들고 `opus`가 검토합니다. 두 역할 모두 [Codex CLI](https://github.com/openai/codex)로
바꿀 수 있습니다(`codex login`으로 로그인).

```json
"builder":  { "type": "codex" },
"reviewer": { "type": "claude-code", "model": "opus" }
```

섞어 쓰는 게 핵심입니다. 코드를 쓴 모델이 그 코드를 승인하지 않게요. Codex의 `model`은 생략하면
`~/.codex/config.toml`의 모델을 쓰고, 다른 모델을 쓰려면 적으면 됩니다.

`sandbox`는 Codex 실행이 사람 없이 어디까지 할 수 있는지 정합니다.

| `sandbox` | 동작 |
|---|---|
| `auto` (기본) | Codex의 "approve for me". worktree 쓰기 샌드박스에서 돌고, 그 이상이 필요한 일(저장소 `.git`에 커밋, push)은 Codex 자동 검토자에게 넘깁니다. Claude Code auto 모드에 해당 |
| `workspace-write` | worktree 안에만 쓰고 권한 상승을 하지 않습니다. 이 모드에선 worktree에서 커밋을 못 해 빌드가 `BLOCKED`로 끝납니다 |
| `danger-full-access` | 샌드박스·승인 없음. 이 용도로 따로 둔 컴퓨터에서만 |
| `read-only` | 브랜치를 절대 바꾸면 안 되는 검토자용 |

끊긴 Codex 실행도 Claude Code처럼 이어 갑니다(같은 스레드로 `codex exec resume`).

## Notion을 보드로

1. [notion.so/profile/integrations](https://www.notion.so/profile/integrations)에서 통합(integration)을 만들고 시크릿을
   복사합니다. "콘텐츠 읽기", "콘텐츠 업데이트", "댓글 읽기·쓰기" 권한을 줍니다.
2. 작업 데이터베이스에서 **⋯ → 연결 → 그 통합 추가**.
3. URL에서 데이터베이스 ID를 복사합니다(`notion.so/<워크스페이스>/<데이터베이스 ID>?v=...`).
4. 시크릿은 환경 변수(`NOTION_TOKEN`)나 나만 읽을 수 있는 파일(`tokenFile`)에 둡니다.

```json
"board": {
  "type": "notion",
  "notion": {
    "databaseId": "0123456789abcdef0123456789abcdef",
    "tokenEnv": "NOTION_TOKEN",
    "properties": { "title": "이름", "status": "상태", "project": "프로젝트", "kind": "종류", "id": "ID", "notes": "" },
    "statuses": { "ready": "할 일", "working": "진행 중", "review": "리뷰", "blocked": "막힘", "done": "완료" },
    "releaseKind": "출시",
    "filter": { "property": "담당", "equals": "nightshift" }
  }
},
"projects": { "my-app": { "repoPath": "~/code/my-app" } }
```

| 키 | 뜻 |
|---|---|
| `properties.title`, `status`, `project` | 필수. `status`는 상태(Status)나 선택(Select) 속성, `project`는 선택·다중 선택·텍스트·관계형(연결된 페이지 제목) |
| `properties.kind` | 선택. 값이 `releaseKind`면 출시 티켓 |
| `properties.id` | 선택. 고유 ID 속성(`TK-12`)이면 티켓 ID와 브랜치 이름이 짧아집니다. 없으면 페이지 ID |
| `properties.body` | 선택. 요청이 담긴 텍스트 속성. 기본은 페이지 본문 |
| `properties.notes` | 선택. 러너가 덧붙일 텍스트 속성. 기본은 페이지 댓글 |
| `statuses` | 러너 상태마다 상태 속성의 옵션 이름. 데이터베이스에 실제로 있어야 합니다 |
| `filter` | 선택. 이 속성이 이 값인 페이지만 티켓(선택·상태·텍스트·체크박스) |

프로젝트 속성의 값이 `projects`의 키입니다(위에선 `"my-app"`). `nightshift doctor`가 데이터베이스를 한 번 읽어서 토큰,
공유, 속성 이름을 확인합니다.

## 그 밖의 에이전트와 트래커

- **다른 에이전트 CLI**(Gemini CLI, opencode 등): `builder` / `reviewer`를
  `{"type": "command", "command": "/스크립트/경로"}`로 두면, 스크립트가 프롬프트를 stdin으로 받고 `NIGHTSHIFT_MODEL`,
  `NIGHTSHIFT_SESSION_ID`, `NIGHTSHIFT_SESSION_MODE`(`new` 또는 `resume`)를 환경 변수로 받아 티켓 worktree에서 돕니다.
  끝나면 exit 0이어야 하고, 끊긴 세션 이어가기는 스크립트가 맡습니다.
- **다른 트래커**(Linear, Jira, 스프레드시트): [command 보드 프로토콜](../../README.ko.md#다른-트래커-command-보드)용 작은
  스크립트를 쓰고 `"board": {"type": "command", "command": "..."}`로 두세요.

## 문제 해결

| 보이는 것 | 이유와 할 일 |
|---|---|
| `run`이 "nothing to start: no ready tickets" | `ready` 티켓이 없음. GitHub면: 이슈가 열려 있고 `nightshift:ready` 라벨이 있고 믿을 수 있는 작성자가 열었는지 |
| `run`이 ready 티켓이 "wait for a project that is already being worked on" | 프로젝트당 작업자 1명. 그 작업자가 끝나면 다음 묶음을 이어서 가져감 |
| Codex 빌드가 git index·lock 파일을 못 써서 `BLOCKED` | Codex `sandbox`가 `workspace-write`임. `auto`(기본)로 |
| `doctor`: "Notion: ... 404" 또는 "no property" | 데이터베이스를 통합에 연결하지 않았거나, `properties` / `statuses`의 이름이 실제와 다름 |
| 티켓이 `working`에 머물고 아무것도 안 돎 | 실행이 끊김. `resumeCooldownMinutes`(15분) 뒤 다음 `run`이 이어 감. `nightshift logs`로 마지막 종료 확인 |
| `blocked`: "stage was cut off 3 times" | 메모의 마지막 로그 줄 확인. 흔한 원인: 사용량 한도, `claude` 로그아웃, 무인 실행 중 권한 확인 창 |
| 실행 요약에 권한 규칙 얘기나 승인 요청이 나옴 | 내 Claude Code 설정이 실행에 필요한 걸 막음. `~/.claude/settings.json`에서 허용하거나 `permissionMode`를 바꾸세요 |
| `blocked`: "could not make a worktree" | 프로젝트 경로가 git 저장소가 아니거나 `baseBranch`(기본 `main`)가 없음 |
| `review`: "the merge failed" | PR에 충돌이나 필수 검사 실패. GitHub에서 고치거나 티켓을 다시 `ready`로 |
| nightshift가 만든 브랜치를 지웠는데 사용 중이라고 함 | 그 저장소에서 `git worktree prune` 후 다시 |

**전부 멈추기:** cron / launchd / daemon을 멈추고, `nightshift status`로 작업자를 찾아 멈춥니다(`kill <pid>`). 끊긴 티켓은
`working`에 남아 있다가 다시 켜면 이어집니다.
