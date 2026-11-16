# TK-454 nightshift 사용/미사용 paired pilot 결과

> **3쌍 탐색용(pilot)**입니다. 통계적 우월이나 비용 절감을 보장하지 않으며, 외부 성능 홍보에 쓰지 않습니다.

## 1. 요약

- 동일 과제 3개(t1 CSV 내보내기, t2 경로 탈출 보안 수정, t3 저가재고 리포트)를 같은 시작 코드·같은 티켓 문구·같은 모델(`sonnet` 별칭, 로그상 `claude-sonnet-5-5`)로 ON/OFF 각 1회, 새 세션에서 실행했습니다. 실행 순서는 교차(t1 ON→OFF, t2 OFF→ON, t3 ON→OFF).
- **완성도: 6회 모두 완료, 숨김 인수 테스트 전부 통과(9/9, 5/5, 11/11), 치명 결함·범위 위반 0, 재작업 0회.** 과제가 쉬워 양쪽 모두 천장에 닿았고, 완성도 차이는 이 표본에서 측정되지 않았습니다(재검토 흐름이 결함을 잡아낸 사례도 없음).
- **토큰:** 3쌍 모두 ON이 OFF보다 많았습니다(총 토큰 ON/OFF 비 1.17~1.34, 중앙값 1.23). 증가분은 거의 전부 cache-read 입력이고 output 토큰은 비슷(비 0.99~1.22)합니다. ON의 프롬프트(규칙 파일, 사람 판단 게이트, 결과 파일 규약)가 더 길어서 세션마다 읽는 문맥이 늘어난 것과 부합하지만, **원인은 이 실험으로 검증하지 않았습니다.**
- **시간:** ON이 3쌍 모두 3.5~11.6초(비 1.07~1.22) 길었고, 대기/오버헤드(배차, worktree 생성, 폴링)가 ON에서 더 컸습니다. 1회씩이라 실행 간 잡음(같은 조건 반복 변동)을 알 수 없어, 이 차이가 잡음보다 큰지 말할 수 없습니다.
- 재검토 흐름이 실제로 가치를 내는 경우(첫 구현이 틀렸을 때)는 이 과제 난이도로는 관찰되지 않았습니다. 더 어려운 과제·반복이 필요합니다.

## 2. 설계 (사전등록: `bench/PREREGISTRATION.md`, 첫 실행 전 커밋 8df9399)

| 항목 | 값 |
|---|---|
| 시작 코드 | `bench/fixture/` (매 실행 새 scratch git repo, 동일 바이트) |
| 과제/완료 조건 | `bench/tasks/t1~t3.md` 양쪽 동일 |
| builder/reviewer 모델 | 둘 다 `sonnet` 별칭, 양쪽 동일 (로그에서 `claude-sonnet-5-5` 확인) |
| effort | 덮어쓰지 않음(현재 CLI 기본값, 동일 사용자 설정). nightshift에 effort 옵션이 없음 |
| 상한 | 실행당 20분, 재작업 최대 2회, 서브에이전트 금지, 권한 모드 `auto`, 외부 도구/네트워크 요청 없음 |
| 격리 | `/tmp/ns-bench/<id>/` scratch만 사용, 운영 runner·메인 체크아웃·푸시 없음, 순차 실행(동시 실행 없음) |
| ON | `nightshift init` 기본 규칙, local-md 보드, `publish: branch`, `nightshift add` → `nightshift run` |
| OFF | `claude -p` builder → `claude -p` reviewer → `VERDICT: REWORK`이면 재작업(같은 상한). 프롬프트는 같은 취지로 짧게 작성했고 nightshift의 규칙 파일·사람 게이트·결과 파일 규약은 없음. 이 차이가 곧 측정 대상 |
| 채점 | `bench/scripts/grade.mjs`: 조건명을 모르는 결정적 스크립트, 숨김 테스트는 실행 repo에 복사하지 않음. 정답 구현에서 전부 통과, 원본에서 실패함을 사전 확인 |

토큰 정의: 원본 Claude Code 세션 로그(`~/.claude/projects/*.jsonl`)의 모든 세션(builder+reviewer+재시도) 합. assistant 메시지는 content block마다 여러 줄로 기록되므로 `message.id`로 중복 제거. `input`(캐시 안 된 입력), `output`, `cache_read`, `cache_write`를 따로 보고하고, `total`은 네 값의 단순 합(가격 아님; cache read는 훨씬 저렴). 값이 없으면 빈 칸이며 0이나 추정으로 채우지 않습니다(이번엔 결측 없음).
시간 정의: `total`=시작 명령~종료 벽시계, `build`=builder 1라운드 세션 구간, `rework`=builder 2라운드 이상, `review`=reviewer 전체, `wait_overhead`=total−구간 합. **사람 실작업 시간은 관측하지 않아 미측정**입니다.

## 3. 결과 (원시값, 스크립트로 재계산: `node bench/scripts/analyze.mjs`)

| task | arm | outcome | completed | hidden tests | own tests | security | scope | rework rounds | total s | build s | rework s | review s | wait s | total tokens | out | cache read | cache write | input |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1 | OFF | pass | true | 9/9 | true | true | true | 0 | 44.68 | 22.35 | 0 | 19.03 | 3.31 | 176304 | 2538 | 121119 | 52637 | 10 |
| t1 | ON | pass | true | 9/9 | true | true | true | 0 | 48.99 | 24.07 | 0 | 19.44 | 5.48 | 216444 | 2539 | 159841 | 54052 | 12 |
| t2 | OFF | pass | true | 5/5 | true | true | true | 0 | 51.49 | 29.81 | 0 | 18.58 | 3.10 | 218062 | 3262 | 159479 | 55309 | 12 |
| t2 | ON | pass | true | 5/5 | true | true | true | 0 | 54.94 | 29.96 | 0 | 20.62 | 4.36 | 291826 | 3244 | 233634 | 54932 | 16 |
| t3 | OFF | pass | true | 11/11 | true | true | true | 0 | 52.34 | 29.19 | 0 | 19.71 | 3.44 | 251784 | 3556 | 191190 | 57024 | 14 |
| t3 | ON | pass | true | 11/11 | true | true | true | 0 | 63.98 | 33.13 | 0 | 23.80 | 7.04 | 294414 | 4334 | 231055 | 59009 | 16 |

| metric | t1 ON−OFF | t2 ON−OFF | t3 ON−OFF | t1 ratio | t2 ratio | t3 ratio | n pairs | median diff | median ratio |
|---|---|---|---|---|---|---|---|---|---|
| total_tokens | 40140 | 73764 | 42630 | 1.23 | 1.34 | 1.17 | 3 | 42630 | 1.23 |
| input_tokens | 2 | 4 | 2 | 1.20 | 1.33 | 1.14 | 3 | 2 | 1.20 |
| output_tokens | 1 | -18 | 778 | 1.00 | 0.99 | 1.22 | 3 | 1 | 1.00 |
| cache_read_tokens | 38722 | 74155 | 39865 | 1.32 | 1.46 | 1.21 | 3 | 39865 | 1.32 |
| cache_write_tokens | 1415 | -377 | 1985 | 1.03 | 0.99 | 1.03 | 3 | 1415 | 1.03 |
| total_s | 4.31 | 3.45 | 11.63 | 1.10 | 1.07 | 1.22 | 3 | 4.31 | 1.10 |
| build_s | 1.72 | 0.15 | 3.94 | 1.08 | 1.00 | 1.14 | 3 | 1.72 | 1.08 |
| rework_s | 0 | 0 | 0 | n/a | n/a | n/a | 3 | 0 | n/a |
| review_s | 0.41 | 2.04 | 4.09 | 1.02 | 1.11 | 1.21 | 3 | 2.04 | 1.11 |
| wait_overhead_s | 2.17 | 1.26 | 3.60 | 1.66 | 1.41 | 2.05 | 3 | 2.17 | 1.66 |
| rework_rounds | 0 | 0 | 0 | n/a | n/a | n/a | 3 | 0 | n/a |
| hidden_pass | 0 | 0 | 0 | 1 | 1 | 1 | 3 | 0 | 1 |


최초 시작 2026-11-16T23:47:17Z, 최종 완료 2026-11-16T23:52:48Z (UTC, 6회 합 약 5분 31초).

## 4. 관찰 자료와 통제 실험의 구분

- **통제 실험(이 문서의 수치):** 위 6회뿐입니다.
- **기존 로그 재사용 안 함:** `~/.local/state/catchmeif404/nightshift/` 의 과거 운영 티켓 로그는 과제·코드 상태·규칙 파일·reviewer 모델(opus)·사람 개입이 서로 달라 동등 비교가 불가하고, OFF 짝이 없습니다. 단순 비교는 효과로 오인될 수 있어 제외했습니다.

## 5. 한계와 막힌 경로

1. 표본: 과제 3개, 조건당 1회. 반복 실행이 없어 변동폭을 모릅니다. 중앙값·비율은 기술 통계일 뿐 유의성 검정이 아닙니다.
2. 과제가 작아(각 약 1분) 천장 효과가 있습니다. 재작업·재검토의 가치, 20분 상한, 실패/timeout 경로는 이번에 발생하지 않아 검증되지 않았습니다.
3. OFF는 "기존 Claude Code 직접 개발/리뷰 절차"를 스크립트로 흉내 낸 것입니다. 실제 사람이 대화형으로 하는 개발과는 다르며, 그 사람의 시간은 측정하지 않았습니다.
4. 프롬프트 길이 차이가 토큰 차이의 원인이라는 설명은 가설입니다(프롬프트 길이만 통제한 대조 실행 없음).
5. effort는 고정 값을 명시 설정하지 않고 양쪽 기본값에 맡겼습니다. 두 arm이 같은 설정을 읽었지만 값 자체는 기록하지 못했습니다.
6. 평가자는 결정적 스크립트(조건명을 가린 채 동일 기준)이며 LLM/사람 평가는 없습니다. 코드 품질(가독성 등)은 채점하지 않았습니다.
7. 가용성: 사용량 한도·로그인 문제로 막힌 실행은 없었습니다. 모든 실행이 기존 로그인/플랜으로 수행됐고 새 결제나 한도 증액은 없었습니다.
8. 제품 코드는 수정하지 않았습니다(`bench/`만 추가).

## 6. 재현

`bench/README.md` 참고: `cd bench && ./scripts/run-all.sh && node scripts/analyze.mjs`.
산출물: `bench/results/runs.csv`, `summary.json`, `summary.md`, `raw/*.json|patch`, `usage/*.jsonl`, `runs/*.json`.
