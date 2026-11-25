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

`nightshift run`은 준비된 것을 띄우고 끝나고, 작업자는 백그라운드에서 계속 돕니다. 새 티켓을 가져가고 끊긴 실행을
이어 가는 걸 사람 없이 하려면 서비스로 설치하세요.

```sh
cd ~/nightshift-queue
nightshift service install     # macOS: LaunchAgent, Linux: systemd 사용자 타이머
nightshift service status      # 설치 여부, 마지막 실행·종료 코드, 로그 마지막 줄
nightshift service uninstall
```

서비스는 이 큐에 대해 `pollSeconds`(기본 120초, 최소 30초)마다, 그리고 로그인할 때 `nightshift run`을 실행합니다.
`node`, `git`, `gh`, `claude`, `codex`는 설치할 때 쓴 셸의 PATH로 찾으니, 새 CLI를 깔았으면 `service install`을 다시
실행하세요. 서비스 자체 출력은 `.nightshift/service.log`에 남습니다. Linux에서 로그아웃 중에도 돌리려면
`loginctl enable-linger $USER`. 큐 폴더마다 서비스가 따로 생깁니다.

**환경 변수** (`env`, 기본 `{}`): 문자열 이름과 값의 객체. 예: `{"env": {"GH_CONFIG_DIR": "/Users/me/.config/gh-work"}}` 로
러너가 다른 `gh` 로그인을 쓰게 할 수 있습니다. `service install` 이 LaunchAgent 의 `EnvironmentVariables` 와 systemd 유닛의
`Environment=` 에 넣으므로 다시 설치해도 남습니다(서비스 파일을 손으로 고치지 마세요). `run`, `work`, `daemon` 도 시작하는
에이전트·`git`·`gh` 의 실행 환경에 합쳐 넣습니다. 비밀 값은 넣지 마세요: 이 파일과 서비스 파일은 평문입니다. 토큰은 `gh`
로그인이나 `tokenEnv` / `botTokenEnv` / `webhookUrlEnv` 가 가리키는 환경 변수에 두세요.

**시작 전 점검**: `publish: "pull-request"` 인 프로젝트는 `doctor` 가 `origin` 이 있는지, 지금 활성인 `gh` 계정이 그 저장소에
push 할 수 있는지(`gh api repos/<owner>/<repo>` 의 `permissions.push`)를 확인합니다. `publish: "branch"` 는 원격이 없어도
됩니다. 배차도 프로젝트 워커를 시작하기 직전에 같은 점검을 합니다. 실패하면 개발을 시작하지 않고 그 프로젝트의 ready
티켓은 그대로 둡니다. 사유는 로그에 남고, `notifyCommand` 와 채팅 알림(`blocked` 이벤트)으로 한 번만 갑니다. 문제가 풀렸다가
다시 생길 때만 또 보냅니다. 콘솔의 "대기 원인"에도 보입니다. 고치면(`gh auth switch`, `git remote add origin ...`) 다음
배차에서 작업이 시작됩니다.

배차는 한 번에 하나만 돕니다(`.nightshift/` 안의 잠금). 서비스가 있어도 직접 `run`을 해도 안전합니다.

터미널에 띄워 두고 싶으면 `nightshift daemon`이 멈출 때까지 같은 일을 합니다. cron을 쓰고 싶으면 도구들이 든 PATH와 함께
`nightshift run --root <큐>`를 부르면 됩니다.

## 로컬 콘솔 (`nightshift ui`)

```bash
nightshift ui --root ~/my-queue          # http://127.0.0.1:4404/ 를 출력합니다. --port 0 이면 빈 포트를 고릅니다
```

`status`, `logs`, `doctor`, 그리고 `nightshift.json` 직접 편집을 한 화면에서 하는 작은 웹 페이지입니다.
패키지 안에 들어 있어 따로 설치할 것이 없고, **이 컴퓨터에서만** 열립니다.

- **현황**: 실행 중인 워커와 단계, 상태별 티켓, 준비된 티켓이 아직 시작하지 않은 이유(사용량 한도, 그 프로젝트에 이미
  워커가 있음, 슬롯이 모두 사용 중, 출시가 유휴를 기다림, 설정에 없는 프로젝트), 최근 로그. 5초마다 갱신하며 읽기만 합니다.
- **설정**: 프로젝트 저장소 경로, 보드(local-md 또는 github: 폴더·저장소·신뢰할 로그인), 개발자·검토자 실행기
  (claude-code 또는 codex)와 모델, 동시 작업 수. **저장 전 검사**는 CLI와 같은 검증에 `doctor` 점검을 고친 값으로
  돌려 보며 아무것도 쓰지 않습니다. **저장**은 이전 파일을 `nightshift.json.bak-<시각>`으로 복사한 뒤 새 파일로
  원자적으로 교체합니다.
- **Doctor**: 저장된 파일에 대해 `nightshift doctor`와 같은 점검.

일부러 하지 않는 것: 티켓 시작·중단·병합, 서비스 설치·제거, `autoMerge` 켜기, 명령어나 토큰 입력. 저장은
`nightshift.json`만 씁니다. 이미 실행 중인 워커는 시작할 때의 설정을 유지하고, 새 설정은 다음 배차 때
적용됩니다(서비스나 `daemon`이 돌고 있다면 확인 주기 이내).

파일의 나머지 내용(콘솔이 편집하지 않는 필드, 철자가 틀리거나 잘못된 필드, 모든 비밀값)은 저장할 때마다 그대로
보존합니다. 비밀로 보이는 값은 `•••••• (kept)`로 표시되는데, 이는 "바꾸지 않음"이라는 뜻이며 입력하는 값이
아닙니다. `command` 보드나 실행기는 잠겨 보이며 파일에서 바꿔야 합니다.

안전: `127.0.0.1`에만 바인드하고, 요청은 올바른 `Host`, 같은 출처의 `Origin`, 페이지의 일회용 CSRF 토큰이 있어야 하며,
엄격한 Content-Security-Policy를 씁니다. 서버는 설정 root의 설정 파일 외에는 파일이나 셸에 접근하지 않고, 보드 폴더는
설정 root 안에 있어야 합니다.

## 팀 규칙, 사람 결정 게이트, 출시 티켓

**`nightshift.rules.md`**는 프로젝트의 모든 프롬프트에 붙습니다(`projects.<이름>.rulesFile`). 저장소의 `CLAUDE.md` /
`AGENTS.md`에 없는 것을 적으세요: 테스트 명령, 커밋 방식, 건드리면 안 되는 폴더, PR 쓰는 법.

**사람 결정 게이트**(`humanGates`, 기본 전부 켜짐): `money`, `legal`, `destructive-data`, `outward-facing`,
`product-direction`. 변경이 여기에 걸리면 검토자가 `NEEDS_HUMAN`으로 답하고 내가 정할 것, 선택지, 추천을 적습니다.
티켓은 그 내용과 함께 `blocked`가 되고, 게이트에 걸린 것은 머지되지 않습니다.

**티켓 양식**(`ticketSections`, 기본 `[]` = 꺼짐): 항목 이름 목록, 예: `["결과물", "확인 방법", "범위 밖"]`.
티켓이 실행되기 전에 본문에 항목마다 `항목: 내용` 줄이 있어야 합니다(콜론 뒤에 내용, 전각 `：`도 됨). 하나라도 빠진 티켓은
빠진 항목을 노트로 남기고 `blocked`로 옮겨집니다(모든 보드 공통, 출시 티켓은 검사 안 함). 개발·검토 프롬프트에 항목 목록이
들어가고, 검토는 이 항목으로 채점하며 확인 항목을 직접 실행합니다. `add`는 본문에 빈 양식을 채워 줍니다. `doctor`는 잘못된
목록(빈 이름, 중복, 이름 속 콜론)을 알려 줍니다.

**경로 기반 사람 승인**(`gatePaths`, 기본 `[]` = 꺼짐): 글롭 목록, 예: `["db/migration/**", "**/*.sql", ".github/workflows/**"]`.
`humanGates`는 검토 모델에게 살펴보라고 알려 줄 뿐이지만, 이 옵션은 코드가 강제합니다. 검토가 `PASS`여도 base 브랜치 대비
바뀐 파일 중 하나라도 글롭에 맞으면 티켓은 `needs-human`으로 `blocked`가 되고 머지되지 않습니다(`autoMerge`가 켜져 있어도
마찬가지). 티켓 노트에 맞은 글롭과 파일이 남고, 검토 프롬프트에도 글롭이 들어갑니다. 글롭은 저장소 기준 경로 전체와 맞춥니다:
`*`와 `?`는 폴더 이름 안에서만, `**`는 폴더를 넘어 맞습니다(`dir/**`은 `dir` 아래 전부, `**/*.sql`은 모든 `.sql`).
git이 바뀐 파일을 못 가져오면 통과시키지 않고 사람에게 넘깁니다. `doctor`는 빈 글롭을 알려 줍니다.

**채팅 알림**(`notify`, 기본 꺼짐): 스크립트 없이 nightshift가 직접 Telegram, Slack, Discord로 메시지를 보냅니다.

```json
{ "notify": { "service": "telegram", "chatId": "123456", "botTokenEnv": "NIGHTSHIFT_TELEGRAM_BOT_TOKEN", "events": ["review", "blocked", "merged"] } }
```

- `service`: `telegram`, `slack`, `discord` 중 하나(기본 `none` = 꺼짐).
- `events`(기본 넷 다): `review`(검토 통과, 머지 대기), `blocked`(막힘·사람 결정 필요·끊김·머지 실패·설정 오류로 멈춤), `merged`(머지됨, 문서 통과, 출시 끝), `daily-report`([아침 보고](#아침-보고-nightshift-report). `dailyReportAt`을 넣었을 때만 보냄).
- 비밀값은 설정에 넣지 않고 환경변수 **이름**만 적습니다. Telegram은 `botTokenEnv`(기본 `NIGHTSHIFT_TELEGRAM_BOT_TOKEN`)와 `chatId`(다른 API 주소가 필요하면 `apiUrl`), Slack·Discord는 `webhookUrlEnv`(수신 웹훅 URL, 기본 `NIGHTSHIFT_SLACK_WEBHOOK_URL` / `NIGHTSHIFT_DISCORD_WEBHOOK_URL`)입니다. 변수는 러너가 도는 환경에서 내보내 두세요(설치한 서비스라면 그 서비스 환경).
- 메시지는 `language` 설정에 맞춘 한두 줄입니다: `<티켓> <제목>: <무슨 일>`, 그리고 PR이 있으면 PR 링크.
- 전송이 실패해도(네트워크, HTTP 오류, 변수 없음) 로그에만 남고 티켓과 실행은 계속됩니다. 변수가 없으면 `doctor`가 경고합니다.
- `notifyCommand`와 `workerDoneCommand`는 그대로 함께 동작합니다.

**출시 티켓**(`add`의 `--release`, 또는 `nightshift:release` 라벨)은 혼자 돌며, 규칙 파일을 따르는 검토 모델 실행 한 번입니다.
규칙 파일에 출시 절차(태그, 배포, 실서비스 확인 방법)를 적어 두세요. 실행은 `DONE`이나 `BLOCKED`로 답합니다.

## 모델, 비용, 내 Claude Code 설정

- 기본: `sonnet`이 만들고 `opus`가 검토합니다. `nightshift.json`의 `builder.model` / `reviewer.model`로 바꿉니다.
- 티켓 하나는 Claude Code 실행 최소 2번, 재작업이 있으면 4번입니다. 구독 요금제면 사용량 한도에서 빠지고, 한도에
  걸리면 메시지에서 풀리는 시각을 읽어 그때까지 아무것도 띄우지 않았다가 같은 세션으로 이어 갑니다(한도는 시도 횟수로 세지
  않습니다).
- 실행은 내 Claude Code를 그대로 씁니다: 로그인, `~/.claude/settings.json` 권한, 전역 `~/.claude/CLAUDE.md`
  ("한국어로 답해"라고 돼 있으면 실행 요약도 한국어).
- 쓰는 서비스의 약관이 무인 실행을 허용하는지 확인하세요.

### 티켓별 토큰과 시간

개발·검토·출시 단계가 끝날 때마다 `<stateDir>/usage/<티켓>.jsonl`에 한 줄이 쌓입니다: 단계, 라운드, 모델,
input / output / cache read / cache write 토큰, 가중 합계, 소요 초. 따로 켤 것은 없습니다.

- 가중 합계 = input x1 + output x5 + cache write x1.25 + cache read x0.1 (`bench/`와 같은 식). 토큰은 Claude Code 세션
  파일에서 합산하며 메시지 id로 중복을 제거합니다. 소요 시간은 그 파일의 첫~마지막 timestamp입니다.
- Codex와 `command` 에이전트는 nightshift가 읽을 세션 파일이 없고, Claude Code도 세션 파일이 없을 수 있습니다. 그
  경우 시간(실행 벽시계)만 기록하고 토큰은 "알 수 없음"으로 둡니다. 이 때문에 단계가 실패하지는 않습니다.
- 티켓이 끝나면 보드 메모에 한 줄이 붙습니다. 예: `개발 r1 sonnet 2m10s 124k · 검토 r1 opus 1m17s 93k · 합계 217k`
  (`language: "en"`이면 영어). 토큰을 모르는 단계는 그렇게 표시하고 합계에서 뺍니다.
- `nightshift status`와 콘솔의 티켓 줄에 지금까지의 합계(`217k · 3m27s`)가 나옵니다.

## 아침 보고 (`nightshift report`)

```bash
nightshift report                       # 지난 24시간
nightshift report --since 3d            # 지난 3일 (12h 도 가능)
nightshift report --since 2026-11-24    # 그날 0시부터 (이 컴퓨터의 시간대)
nightshift report --json                # 스크립트용 같은 자료
nightshift report --send                # notify 와 notifyCommand 로도 보내기
```

`<stateDir>`에 러너가 남기는 기록만 읽습니다. 티켓이 끝날 때와 사용 한도로 멈출 때 `journal.jsonl`에 한 줄씩 쌓입니다.
보드를 새로 긁지 않으므로 오프라인에서도 됩니다. 이 버전으로 올리기 전에 끝난 티켓은 기록이 없어 나오지 않습니다.

기간 안에 끝난 티켓은 그 기간의 마지막 결과 기준으로 한 묶음에 들어갑니다.

- **통과**: 머지됐거나, 검토를 통과해 PR이 머지를 기다리는 것.
- **재작업 후 통과**: 위와 같되 검토자가 한 번 이상 돌려보낸 것.
- **막힘**: 개발이나 검토가 멈췄거나 단계가 끊긴 것. 사유가 한 줄 붙습니다.
- **사람 판단 필요**: 게이트(돈, 법무, 지정 경로 등)에 걸렸거나 검토자가 사람을 요청한 것. 사유가 한 줄 붙습니다.

줄마다 `[프로젝트] 티켓 제목 - PR 또는 브랜치 · 토큰 · 시간`이 나옵니다 (토큰은 [티켓별 토큰과 시간](#티켓별-토큰과-시간)의
가중 합계이고, 읽지 못했으면 "토큰 알 수 없음"). 맨 아래에 합계(티켓 수, **1회 통과율** = 사람 판단 대기를 뺀 티켓 중
재작업 없이 통과한 비율, 총 토큰, 사용 한도로 기다린 시간. 겹친 한도는 한 번만 셉니다)와 **지금 할 일**(기다리는 PR
머지, 막힌 것 풀기, 나머지 결정)이 붙습니다. 움직인 티켓이 없으면 그렇다고 한 줄만 나옵니다. 할 일 목록은 기간 끝
시점의 기록 기준이라, 그 뒤 직접 머지하거나 고친 티켓은 다시 끝나기 전까지 남아 있을 수 있습니다.

`--send`는 같은 글을 `notify` 채팅(Telegram, Slack, Discord)과 `notifyCommand`(마지막 인자)로 보냅니다. `notify.events`는 무시합니다(직접 요청했으므로). 보낼 곳이 없거나
보내기에 실패하면 종료 코드가 1입니다. 매일 아침 받으려면 **`dailyReportAt`**(`"HH:MM"`, 24시간제, 이 컴퓨터의 시각. 비우거나
없으면 꺼짐이 기본)을 넣으세요.

```json
{ "dailyReportAt": "08:00", "notify": { "service": "telegram", "chatId": "123456", "events": ["review", "blocked", "merged", "daily-report"] } }
```

그 시각 뒤 첫 배차가 지난 24시간 보고를 한 번 보냅니다. 보내기에 성공하면 날짜를 `<stateDir>/report-sent`에 적어 두므로
재시작이나 두 번째 워커가 있어도 두 번 가지 않고, 실패하면 다음 배차에 다시 시도합니다. 채팅 서비스로 받으려면
`notify.events`에 `daily-report`가 있어야 합니다(기본값에는 들어 있음). `nightshift ui`의 현황 맨 위에도 지난 24시간
요약이 카드로 뜹니다.

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
| 티켓이 `working`에 머물고 아무것도 안 돎 | 실행이 끊김. `resumeCooldownMinutes`(15분) 뒤 다음 `run`이 이어 감. `nightshift logs`로 마지막 종료 확인. 서비스가 설치돼 있는지(`nightshift service status`) |
| `blocked`: "stage was cut off 3 times" | 메모의 마지막 로그 줄 확인. 흔한 원인: `claude` 로그아웃, 무인 실행 중 권한 확인 창 (사용량 한도는 기다렸다 이어 가고 횟수로 안 셈) |
| 아무것도 안 돌고 `status`에 "usage limit: … until …" | 에이전트 계정이 사용량 한도에 걸림. 그 시각이 지나면 알아서 이어 감. 할 일 없음 |
| 실행 요약에 권한 규칙 얘기나 승인 요청이 나옴 | 내 Claude Code 설정이 실행에 필요한 걸 막음. `~/.claude/settings.json`에서 허용하거나 `permissionMode`를 바꾸세요 |
| `blocked`: "could not make a worktree" | 프로젝트 경로가 git 저장소가 아니거나 `baseBranch`(기본 `main`)가 없음 |
| `review`: "the merge failed" | PR에 충돌이나 필수 검사 실패. GitHub에서 고치거나 티켓을 다시 `ready`로 |
| nightshift가 만든 브랜치를 지웠는데 사용 중이라고 함 | 그 저장소에서 `git worktree prune` 후 다시 |

**전부 멈추기:** `nightshift service uninstall`(또는 daemon 멈춤) 후, `nightshift status`로 작업자를 찾아 멈춥니다(`kill <pid>`). 끊긴 티켓은
`working`에 남아 있다가 다시 켜면 이어집니다.
