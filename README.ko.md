# nightshift

**티켓을 올려 두면 한 모델이 만들고, 다른 모델이 검토하고, 사람이 정할 일만 남겨 둡니다.**

[English](README.md) | [한국어](README.ko.md)

nightshift는 내 컴퓨터에서 도는 무인 개발 큐입니다. 보드(GitHub Issues 또는 마크다운 파일 폴더)에 티켓을 올려 두면,
티켓마다 개발 실행(Claude Code, 기본 `sonnet`)이 자기 브랜치에서 만들고, 따로 띄운 검토 실행(기본 `opus`)이 CTO처럼
확인합니다. 작은 문제는 직접 고치고, 큰 문제는 한 번 더 고치라고 돌려보내고, 사람이 정해야 하는 일(돈, 법률 문구, 데이터
삭제, 외부 공개)은 머지하지 않고 멈춥니다.

우리 제품을 만드는 러너에서 나왔고, 지금은 그 러너 자리를 대신해 우리 제품을 만들고 있습니다. 이전 bash 러너는 처음
12일 동안 **티켓 225개**를 만들고 검토했고, **84%**가 1회차 검토를 통과했습니다(통과는 AI 검토자의 판정입니다).

> 상태: 초기(0.1). 내장: Claude Code 에이전트, 로컬 마크다운·GitHub Issues·command 보드.
> 다른 에이전트(Codex 등)와 트래커(Notion, Linear 등)는 아직 내장이 아니라 직접 쓴 작은 스크립트로 붙입니다.

**문서:** [설치](docs/ko/INSTALL.md) · [처음 시작하기 (10분)](docs/ko/GETTING-STARTED.md) · [사용법·문제 해결](docs/ko/USAGE.md)

## 동작 방식

```
할 일 티켓 ──► 그 프로젝트의 작업자 (프로젝트당 1명, 여러 프로젝트 동시)
               │
               ├─ 빌드  (개발 모델) 전용 git worktree 에서 ─► PR <url> | BRANCH <이름> | BLOCKED <사유>
               ├─ 검토  (검토 모델) 테스트 직접 실행, 작은 건 고침 ─► PASS | REWORK | NEEDS_HUMAN | BLOCKED
               │     REWORK ─► 검토 의견을 들고 다시 빌드, 한 번 더 검토
               └─ 정리  PASS ─► 사람이 머지하도록 "review" (autoMerge 면 머지)
                        NEEDS_HUMAN / BLOCKED ─► "blocked", 사유를 티켓에 남김
```

아무도 안 볼 때도 버티는 이유:

- **실행의 말이 아니라 파일을 믿습니다.** 단계는 정해진 형식의 결과 파일 한 줄을 써야 끝난 것으로 칩니다.
  못 읽는 결과는 따로 치워 두고 그 단계를 다시 돌립니다.
- **끊겨도 이어서 합니다.** 단계마다 세션 ID를 정해 두고, 재부팅·사용량 한도·강제 종료 뒤 다음 배차가 그 세션을 이어 갑니다.
  3번 끊기면 마지막 로그 한 줄을 사유로 남기고 막힘으로 둡니다.
- **서브에이전트를 쓰지 않습니다.** 단계마다 따로 실행하므로 자식을 기다리다 잘리는 일이 없습니다.
- **내 작업 폴더는 건드리지 않습니다.** 티켓마다 자기 worktree와 브랜치에서 일합니다.
- **두 모델, 두 역할.** 코드를 쓴 모델이 그 코드를 승인하지 않습니다.
- **사람이 정할 일은 사람이.** 머지는 설정한 게이트에서 멈추고, `autoMerge`는 기본으로 꺼져 있습니다.
- **믿을 수 없는 이슈는 돌리지 않습니다.** GitHub에서는 `trustedAuthors`가 연 이슈만 집습니다. 이슈는 곧 프롬프트이니까요.

## 빠른 시작

Node 20 이상, git, 로그인된 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI가 필요합니다.

전체 따라 하기는 [처음 시작하기](docs/ko/GETTING-STARTED.md)에 있습니다.

```sh
npm install -g nightshift          # npm 배포 전에는 docs/ko/INSTALL.md 의 소스 설치
mkdir ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/my-app
nightshift doctor
nightshift add "slugify 함수 추가" --project my-app --body "소문자, 대시, 기존 테스트 옆에 테스트"
nightshift run                     # 작업자를 백그라운드로 띄우고 바로 끝남
nightshift logs -f                 # 지켜보기
nightshift status                  # 상태별 티켓
```

로컬 보드에서는 티켓이 `.tickets/` 안의 파일이고, 러너가 `ready → working → review | blocked → done` 으로 옮기며
각 파일에 메모를 덧붙입니다.

### GitHub Issues

```sh
nightshift init --board github --repo you/my-app --repo-path ./my-app
```

설정 파일을 쓰고, `nightshift:*` 라벨을 만들고, 로그인한 `gh` 사용자를 믿을 수 있는 작성자로 넣습니다(더하려면
`--trusted a,b`). 그다음 이슈에 `nightshift:ready` 라벨을 달면 됩니다. 작업자가 PR을 열고, 검토자가 검토하고, 이슈가 `nightshift:review`로 갑니다
(`autoMerge`면 머지되고 닫힙니다). 혼자 돌아야 하는 티켓에는 `nightshift:release`를 답니다.

### 다른 트래커 (command 보드)

Linear, Jira, Notion, 스프레드시트 등은 `board.command`에 작은 스크립트를 지정하면 보드로 씁니다. 스크립트는
`list <상태>`(티켓 JSON 배열 출력), `set-status <id> <상태> <사유>`, `note <id>`(메모는 stdin) 세 명령만 알면 됩니다.
사유(`needs-human`, `merged`, `cut-off` 등)를 보고 결정 요청 페이지를 여는 식으로 트래커 쪽 동작을 붙일 수 있습니다.
`language: "ko"`로 두면 러너가 티켓에 남기는 메모가 한국어가 됩니다.

설정 키 전체는 [영어 README](README.md#config-nightshiftjson)에 있습니다.

## 안전

nightshift는 worktree 안에서 파일을 고치고 명령을 실행할 권한으로 코딩 에이전트를 무인 실행합니다. 그래도 괜찮은
컴퓨터와 저장소에서 돌리고, 믿을 수 있을 때까지 `autoMerge`는 끄고, `trustedAuthors`는 짧게 두세요. 쓰는 에이전트
서비스의 약관이 무인 실행을 허용하는지도 확인하세요.

## 라이선스

MIT
