# 처음 시작하기: 10분 안에 첫 티켓

[English](../GETTING-STARTED.md) | [한국어](GETTING-STARTED.md)

GitHub 없이 내 컴퓨터에서 티켓 하나가 처음부터 끝까지 도는 걸 봅니다. nightshift [설치](INSTALL.md)와 Claude Code
로그인이 필요합니다. 티켓 하나에 Claude Code 실행이 2번 듭니다(작은 변경이면 각각 1분 안팎).

## 1. 시험할 작은 저장소

테스트 명령이 있는 실제 저장소를 써도 되고, 장난감 저장소를 만들어도 됩니다.

```sh
mkdir -p ~/code/demo-app && cd ~/code/demo-app && git init -b main
cat > package.json <<'EOF'
{ "name": "demo-app", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > text.js <<'EOF'
export function capitalize(word) {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}
EOF
cat > text.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { capitalize } from "./text.js";
test("capitalize", () => assert.equal(capitalize("night"), "Night"));
EOF
git add . && git commit -m "init"
```

## 2. 그 저장소를 가리키는 큐

```sh
mkdir -p ~/nightshift-queue && cd ~/nightshift-queue
nightshift init --repo-path ~/code/demo-app
nightshift doctor
```

프로젝트 이름은 폴더 이름(`demo-app`)이 됩니다. 로컬 보드에서는 결과가 로컬 브랜치로 남고(`"publish": "branch"`)
어디에도 push하지 않습니다.

## 선택: 설치할 때 더 켜 보기

`init` 한 번으로 티켓 양식, 경로 승인, 채팅 알림을 켤 수 있습니다. 플래그를 주지 않으면 모두 꺼져 있고, 나중에
콘솔(`nightshift ui`)에서 같은 세 설정을 보고 바꿀 수 있습니다.

```sh
nightshift init --repo-path ~/code/demo-app \
  --sections deliverable,verify,out-of-scope \
  --gate-paths default \
  --notify telegram --notify-chat-id=-1001234567
```

- `--sections`: 모든 티켓에 `Deliverable:` / `Check:` / `Out of scope:` 줄을 요구합니다 (영문 항목 이름으로 쓰이며, 바꾸려면 `nightshift.json`의 `ticketSections`를 고치세요).
- `--gate-paths`: `default`(`db/migration/**`, `**/*.sql`, `.github/workflows/**`) 또는 쉼표로 구분한 글롭. 하나라도 건드린 변경은 사람을 기다립니다.
- `--notify telegram|slack|discord`: Telegram은 `--notify-chat-id`도 필요합니다 (음수 ID가 플래그로 읽히지 않게 `=`로 쓰세요). 파일에는 환경변수 **이름**만 들어가며, 값은 러너가 도는 곳에서 export 하세요.

## 3. 티켓 쓰기

```sh
nightshift add "slugify 함수 추가" --project demo-app \
  --body "text.js 에 slugify(text) 추가: 소문자, 앞뒤 공백 제거, 공백·문장부호 묶음은 대시 하나로, 앞뒤 대시 없음. 기존 테스트 옆에 테스트 추가."
```

`.tickets/T-1.md`가 생깁니다. 위에는 front matter(`status: ready`), 아래에는 요청 내용이 있습니다. 요청과 "끝"의 기준이
분명할수록 두 실행 모두 잘합니다. [좋은 티켓 쓰기](USAGE.md#좋은-티켓-쓰기)를 보세요.

## 4. 실행하고 지켜보기

```sh
nightshift run          # 작업자를 백그라운드로 띄우고 바로 끝남
nightshift logs -f      # 따라 보기. Ctrl+C 는 보기만 멈추고 작업자는 계속 돎
```

이 순서로 보입니다.

```
T-1 build r1: starting claude-code session ...        개발자(sonnet)가 nightshift/t-1 브랜치에서 만듦
T-1 build r1: exit 0: ...                             개발자 요약 마지막 줄
T-1 review r1: starting claude-code session ...       검토자(opus)가 확인·테스트, 필요하면 직접 고침
T-1 verdict r1: PASS (BRANCH nightshift/t-1)
T-1 -> review (ready-to-merge): review passed, ready for you to merge: branch nightshift/t-1. Review: ...
work demo-app: done
```

## 5. 결과 보기

```sh
nightshift status                 # T-1 이 review 아래에 있음
cat .tickets/T-1.md               # 맨 아래 메모: 무슨 일이 있었는지, 검토 요약
cd ~/code/demo-app
git log --oneline main..nightshift/t-1
git diff main...nightshift/t-1
npm test
```

검토자의 전체 의견은 `~/nightshift-queue/.nightshift/results/T-1.review`에 있습니다.

## 6. 머지 (결정은 내가)

```sh
cd ~/code/demo-app
git merge nightshift/t-1
```

그다음 `.tickets/T-1.md`의 `status: review`를 `status: done`으로 바꿉니다.

## 다음

- 검토자가 돌려보내거나 멈춰야 할 티켓도 넣어 보세요. "가격을 5달러로 바꿔"는 `money` 항목이라 판정이
  `NEEDS_HUMAN`이 되고, 결정할 내용이 적힌 채로 `blocked`가 됩니다.
- `nightshift.rules.md`에 팀 규칙(테스트 명령, 커밋 방식, 건드리면 안 되는 곳)을 적으세요.
- GitHub Issues와 PR로 옮기기: [사용법 → GitHub](USAGE.md#github-issues-와-pr).
- 혼자 계속 돌게 하기: `nightshift service install` ([사용법 → 계속 돌리기](USAGE.md#계속-돌리기)).
