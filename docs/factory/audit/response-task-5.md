# Audit response — Task 5: cold read는 구조가 되고, 로더는 사라지고, 겹침은 측정된다 (H4, M5, P2-13)

> ADR-023 초안 텍스트. `DECISIONS.md`에는 이 파일이 합쳐질 때 옮긴다(계획 Task 5 요구 4).
> 대상 감사: `docs/factory/audit/2026-09-14-external-audit.md` (평가 커밋 `2ab390c`).

## Context

세 지적은 서로 다른 층에 있지만 원인이 같다 — **선언을 강제로 착각했다.**

- **H4.** `roles.toml`에 `cold_read = true`가 다섯 번 적혀 있는데 그 값을 읽는 JS가 하나도 없었다.
  `context.js:12-13`은 네 스테이지의 handoff 전부를 `.factory/out/context.json`에 쓰고,
  `factory-review.js:342`는 리뷰어에게 그 파일을 읽으라고 지시한 뒤 `:351`에서 "plan은 읽지 마라"라고
  부탁했다. 금지 목록에 `handoffs.implement`는 없었다 — 곧 리뷰어는 **verifier의 판정, builder가
  추가했다고 신고한 테스트 목록, PR 번호와 builder의 요약**을 프롬프트 한 줄의 예의만으로 지나쳐야
  했다. 그리고 훅은 읽기를 막지 않는다. 강제가 없는 곳에 강제가 있다고 적어 둔 상태였다.
- **M5.** 네 workflow가 매번 `factory-loader`(sonnet)를 띄워 `context.json` + `roles.toml`을 읽고
  JSON을 JSON으로 옮겨 적게 했다. 그 에이전트가 `roles.toml`을 다시 열어야 했던 유일한 이유는
  `model` 하나였는데, `context.js:18`은 그 값을 이미 `def.model`로 들고 있었다. 스테이지마다 LLM
  호출 하나를 "복사"에 쓰면서, 그 복사가 틀릴 가능성까지 함께 샀다.
- **P2-13.** R2 스키마는 `on_others[{id, stance, reason}]`를 요구하고 리뷰어들은 매 라운드 그것을
  채워 냈는데, 그 배열을 소비하는 코드는 저장소 전체에 **0곳**이었다. 리뷰어 5명을 한 커밋에 붙이는
  일 전체의 정당성("각자 다른 것을 본다")을 검증할 유일한 재료를 생성만 하고 버리고 있었다.

## Decision

### 1. cold read는 파일 경계다 (H4)

`buildContext`는 이제 두 종류의 파일을 쓴다.

| 파일 | 누가 읽는가 | 무엇이 들어 있는가 |
| --- | --- | --- |
| `.factory/out/context.json` | 오케스트레이터(그리고 `verify-stage`) | 전부 — 지금까지와 같다 |
| `.factory/out/context.<role>.json` | 그 역할 하나 | `roles.toml`의 `cold_read`가 정한 부분집합 |

`roleContextFor(ctx, role)`가 그 부분집합을 만든다. `cold_read = true`인 역할이 받는 것은

- 이슈(번호·제목·본문·라벨), `stage`, `tier`, 로스터 이름들,
- 그 역할의 lessons 경로, `spec_path`, CHARTER의 `limits`,
- **PR 번호와 head sha** — builder의 *설명*이 아니라 "무엇을 판정하는가"의 좌표다,
- 게이트 요약(`harness.gates`)과 `maturity`,
- 계획의 `done_when`을 **네 필드로 깎은 것**(`id`/`text`/`verify`/`level`)

뿐이다. `handoffs` 키 자체가 없다 — verifier 판정도, `tests_added`도, `files_expected`/`non_goals`/
`dissent_log`도, 다른 리뷰어의 `verdicts`도 파일에 **존재하지 않는다**. `factory-review.js`는 각
리뷰어에게 `contextFor(r)` 경로만 넘기고 전체 파일의 경로는 한 번도 주지 않는다(등장하는 유일한
자리는 "그 파일을 열지 마라"는 금지 문장이다).

`cold_read = false`인 spec-conformance는 그 반대다: 전체 파일을 그대로 받고, 더해서 이슈 본문의
acceptance 절을 `acceptance` 필드로 뽑아 받는다 — 계약 대조가 그 역할의 임무이고, 계약이 이슈 본문
안에 있으면 찾아 헤매게 두지 않는다.

**왜 부탁이 아니라 파일인가.** 감사가 정확히 짚은 대로 읽기는 훅으로 막을 수 없다(PreToolUse의
`deny-all-writes.sh`는 쓰기만 본다). 지시로 막는 cold read는 모델이 한 번만 호기심을 내면 무너지고,
무너진 사실이 로그 어디에도 남지 않는다. 그래서 막는 자리를 옮겼다: **읽지 않기로 약속할 필요가
없다 — 읽을 것이 거기 없다.**

이것은 §5.2.3(qa는 `done_when`을 받는다)과 ADR-016을 한 걸음 더 밀어붙인 것이기도 하다. 예전에는
프롬프트가 역할별로 "plan의 어느 필드까지 봐도 되는지"를 문장으로 배분했다. 이제 그 배분은 파일을
쓰는 순간 끝나고, 프롬프트는 설명으로만 남는다.

### 2. `factory-loader`는 삭제됐다 (M5)

`context.js`가 로더의 산출물을 Node에서 결정적으로 만들어 `.factory/out/loaded.json`에 쓴다 —
`issue`/`stage`/`tier`, `roster[{name, agentType, model, lessons, context}]`, `contexts`, `rounds`,
`plan`, `limits`, `spec_path`, `maturity`, `orchestration`, `pr`/`head_sha`, `must_fix`(rework 라운드의
verdict 합집합), `disputed`(PR 코멘트의 최신 `factory.rework-response.v1` 중 `status: disputed`).
디스패처 커맨드가 그 작은 파일을 그대로 Workflow의 `args.loaded`로 넘기고, 네 workflow는
`const loaded = args.loaded ?? null;` 한 줄로 받는다.

- **아낀 것**: 스테이지마다 sonnet 서브에이전트 1회 — triage·plan·implement·review 네 스테이지 ×
  매 라운드. 리뷰가 K=3까지 도는 이슈 하나에서만 로더 호출이 여섯 번 넘게 일어났다.
- **함께 사라진 것**: `.claude/agents/factory-loader.md`, `.factory/lessons/factory-loader.md`,
  doctor의 `LOADER_AGENT` 예외(“roles.toml에 없는데 lint는 해야 하는 파일”), 네 workflow가 공유하던
  `LOADER` schema 리터럴과 loader 프롬프트.
- **유지한 것**: 네 workflow가 같은 블록을 **바이트 단위로 공유한다**는 성질. 공유되는 것이
  schema에서 Load 블록으로 바뀌었을 뿐이고, 테스트는 그대로 네 파일을 비교한다.
- **fail-closed**: payload가 없으면 `{issue, error: 'context payload missing', orchestration,
  guarantee}`뿐 — stage 필드를 싣지 않으므로 `verify-stage`가 needs-human으로 떨어뜨린다.
  issue-mismatch도 같은 모양으로 남았다.

로더를 없앤 것은 비용 때문만이 아니다. **읽고 옮겨 적는 일에 판단이 낄 자리를 두지 않는 것**이
요점이다 — 로더가 역할을 하나 빠뜨리면 그 역할은 이번 라운드에 존재한 적이 없는 것이 되고, 그 사실은
`aggregate-review.sh`의 로스터 대조까지 가서야 드러났다.

### 3. 리뷰어 겹침을 센다 (P2-13)

`overlapFrom(verdictSets)` — 순수 함수, `factory/lib/retro/harvest.js`. 한 리뷰 런에서 finding
하나를 "제기한 역할"은 (a) must_fix에 적은 역할과 (b) R2에서 `stance: "agree"`로 그 id를 지지한
역할이다. `disagree`는 제기가 아니고, **아무도 적지 않은 id에 대한 agree는 세지 않는다**(사라진
라운드의 id이거나 오기이고, 없는 finding에 겹침을 만들어 주면 안 된다).

- `unique_findings_by_role[role]` — 그 역할 혼자 제기한 finding 수.
- `overlap_ratio` — 두 역할 이상이 제기한 finding ÷ 전체 finding.

겹침은 **런 안에서만** 뜻이 있다(다른 라운드의 같은 id는 다른 코드에 대한 판정이다). 그래서
`harvest`는 창 안에서 머지된 이슈의 review handoff를 런 단위로 모아 각각을 따로 센다. 누적은 비율의
평균이 아니라 분자·분모의 합에서 다시 나온다(`accumulateStats`).

보이는 자리는 둘이다.

- `factory status`: `## 최근 머지` 밑의 한 줄 —
  `- review overlap (30d): 0.17 (1/6 findings raised by ≥2 roles, 4 review run(s)) · unique: correctness 2, qa 1`.
  분모가 0인 창은 비율을 만들지 않는다(`no findings in N review run(s)`) — "겹치지 않았다"와
  "판정할 finding이 없었다"는 다른 사실이다.
- retro의 통계 표: `reviewer overlap` / `unique findings by role` 두 행(창 · 누적).

## Consequences

- 리뷰어 프롬프트에서 "handoffs.plan의 어느 필드까지" 같은 배분 문장이 사라졌다. 역할 파일
  (`reviewer-spec-conformance.md` 등)의 "You receive" 절은 여전히 맞다 — 다만 이제 그것을 지키는
  것은 문장이 아니라 파일이다.
- `.factory/out/`에 파일이 늘었다(로스터 크기 + 1). 전부 스크래치 경로라 무결성 검사·더티 트리
  판정의 대상이 아니다.
- `disputed`를 Node가 PR 코멘트에서 뽑는다 — 조회에 실패하면 빈 배열이다. 이것은 fail-open이
  아니다: 분쟁 목록이 비면 "빌더가 이의를 제기하지 않았다"가 되고, 리뷰어의 must_fix는 그대로
  살아 있다(항목이 사라지는 방향이 아니다).
- 남은 것: `agent-md.js`의 쓰기 금지 역할 목록과 `stop-guard.sh`에 `factory-loader` 이름이 아직
  있다. 존재하지 않는 agent_type에 대한 **더 엄격한** 규칙이라 해로울 것이 없어 그대로 두었다.
- 겹침 수치는 아직 표본이 얇다(다크 완주 머지 1건). 첫 판단 근거가 되려면 리뷰 런이 쌓여야 하고,
  그때까지 이 줄의 역할은 "재료를 버리지 않는다"이다.
