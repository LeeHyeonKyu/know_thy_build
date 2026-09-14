# Audit response — Task 2: review is verified before merge; the human gate is an explicit choice

> 감사 대응 계획 `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md` Task 2.
> 다루는 발견: **H1c**(머지가 리뷰보다 먼저 일어난다) · **H1b**(상태 게시자 미검증, 머지 경로 부분) ·
> **H6**(인간 게이트가 사실상 없다) · **M7**(`FACTORY_MERGE_TOKEN || FACTORY_BOT_TOKEN` 무성 강등).
> 이 파일은 ADR-023에 접히는 초안이다 — `DECISIONS.md`에 직접 쓰지 않는다.

## 1. 재현한 것 (fix 이전의 사실)

### H1c — 머지 스테이지는 리뷰 증거를 한 번도 보지 않았다
`merge-stage.js`는 `mergePr`(:476)를 부른 **뒤에** `transition("factory:merged")`(:487)를 불렀고,
`requirements.js`의 `factory:merged` 규칙은 `need(review)` — handoff의 **존재와 스키마**만 봤다.
정족수(roster size)와 all-approve는 `factory:approved` 규칙에만 있었다. 종합하면:

- 머지 스테이지 자신은 리뷰 handoff를 **읽지 않았다**(정족수도, 라운드도, sha 바인딩도).
- 유일하게 리뷰를 세는 규칙(`factory:approved`)은 라벨 편집으로 우회할 수 있고(H1a), 그 라벨이 붙은
  뒤에는 아무도 다시 세지 않았다.
- 되돌릴 수 없는 단계(`gh pr merge`)의 마지막 방어선이 **비어 있었다**.

재현 테스트(실패 → 통과 순서로 추가):
`factory/test/merge-stage.test.js`
- `H1c: with no review-evidence deps wired the stage refuses to merge` — 리뷰 재료가 **아무것도**
  배선되지 않은 런이 그대로 `mergePr`까지 갔다. 그 사실 자체가 구멍이다.
- `H1c: a review handoff that calls itself approved while a verdict rejects does not merge`
- `H1c: all-approve verdicts with an upheld ruling still recompute to rework`
- `H1c: a review handoff bound to a different commit does not merge`
- `H1c: fewer verdicts than the tier's roster …` / `one role approving twice …`
- `H1c: a round beyond K does not merge`
`factory/test/requirements.test.js`
- `H1c: factory:merged re-checks quorum, all-approve (recomputed from must_fix) and K`
`factory/test/run-stage.test.js`
- `H1c: the merged transition carries a roster and K even with no ctx` — merge는 script-only라
  `buildContext`를 거치지 않는다. 곧 규칙에 정족수 검사를 넣어도 `ctx.roster`가 undefined라
  **잴 자가 없었다**. 이 테스트가 그 두 번째 구멍을 고정한다.

### H1b — 상태의 게시자를 아무도 묻지 않았다 (머지 경로)
`mergeGates`의 리뷰 증거는 required checks(`allChecksGreen`) 하나였고, 그 함수는 `context`와 `state`만
본다. 봇 토큰은 classic `repo` 스코프라 `gh api -X POST /repos/o/r/statuses/<sha> -f state=success
-f context=factory/review`가 실제로 나간다 — 곧 "리뷰 통과"는 에이전트가 스스로 쓸 수 있는 값이었다.
재현: `H1b: a factory/review status posted by an account that is not the factory does not merge`,
`H1b: a missing factory/gates status on the PR head does not merge`,
`H1b: an unresolvable factory login fails closed`.

### H6 — 사람의 서명은 토큰 등록 1회뿐이었고, 그 사실이 어디에도 없었다
`merge-stage.js:465`의 `approvePr`가 admin PAT으로 자동 승인하고, `MERGE_ENVIRONMENT_BODY`에는
`deployment_branch_policy`만 있었다(= *토큰이 어디로 새는가*의 통제이지 *사람이 봤는가*가 아니다).
결함의 절반은 **그 상태가 선언되지 않았다**는 것이다: 아무도 다크 머지를 고른 적이 없는데 전 저장소가
다크였다. 재현: `doctor-merge-authority.test.js`의
`H6: merge.human_gate — true PASSes, false WARNs as merge.dark, absent FAILs`,
`bootstrap.test.js`의 `H6: merge.human_gate: true puts a required reviewer …`.

### M7 — 두 배우 모드의 무성 강등
`factory-merge.yml:60` `GH_TOKEN: ${{ secrets.FACTORY_MERGE_TOKEN || secrets.FACTORY_BOT_TOKEN }}`.
그 폴백은 단일 배우 모드를 위한 것인데 **두 배우 모드에서도 똑같이 작동했다**: 환경이 적용되지
않았거나(보호되지 않은 브랜치에서 시작한 dispatch) 시크릿이 지워지면 잡은 조용히 에이전트 배우의
토큰으로 머지한다 — 로그 한 줄 없이, 사후에 구별할 방법도 없이. 재현:
`yml-lint.test.js`의 `merge-token-required-when-two-actor: …`.

## 2. 지금 무엇이 막는가

### (a) 머지 직전 리뷰 검증 — `merge-stage.js` §(6b)
`approvePr`보다도 **앞**이다(실패하면 머지도 승인도 없다 — 승인 자체가 사람 눈에는 팩토리의 서명이다).
자리는 ready 플립과 체크 안정화가 끝난 뒤이므로 PR head가 확정된 순간이고, 그 순간의 **라이브 PR
head**를 다시 물어 그것으로 판정한다. 네 가지를 묻는다:

1. 그 sha에 묶인 `review.v1` handoff가 있는가
2. 정족수(= 이 tier의 로스터 크기) + all-approve — handoff의 자기 신고 `decision`은 **읽지 않는다**.
   판정은 `must_fix`에서 `aggregate.js`로 다시 계산한다(`lib/review-quorum.js`)
3. `round ≤ K`
4. `factory/review`·`factory/gates` 상태의 `creator.login`이 팩토리 계정인가

하나라도 확인 불가면(dep 미배선 · 조회 실패 · 로그인 미해결 · 상태 부재) GREEN이 아니라 **판정 불가**,
곧 `factory:needs-human`이다. 사유는 정확한 한 줄로 전이 코멘트와 run 기록에 함께 남는다.

새 파일 `factory/lib/review-quorum.js`가 "리뷰가 통과했다"의 **유일한 판정처**다 — `factory:approved`
규칙, `factory:merged` 규칙, 머지 스테이지 셋이 같은 함수를 부른다.

**K는 `factory:approved`에 걸리지 않는다**(ADR-020 KTB-29 r1 SF1 유지: K는 실패를 끊는 한도이지 성공을
막는 한도가 아니다). `factory:merged`와 머지 스테이지에만 건다 — KTB-29 이후 `nextState`가 `round >= K`
rework을 곧장 needs-human으로 보내므로 `round > K`인 approve는 정상 경로에서 **만들어질 수 없고**,
그런 handoff는 이 그래프를 거치지 않고 생긴 것이다.

### (b) 게시자 확인의 재료
`gh.commitStatuses(sha)` 신설 — `GET /repos/{repo}/commits/{sha}/statuses`만이 항목마다 `creator`를
준다(combined status API도 `gh pr checks`도 주지 않는다. 그것이 `allChecksGreen`이 게시자를 못 본
이유다). 조회 sha가 곧 "그 상태가 붙은 커밋"이므로 target-sha 검사는 구조적으로 참이 된다.

팩토리 계정은 두 개일 수 있다: 두 배우 모드에서 이 잡의 `GH_TOKEN`은 **머지 배우**인데
`factory/review`를 올린 것은 앞 스테이지의 **에이전트 배우**다. 그래서 `factory-merge.yml`에
`Resolve the agent actor's login` 스텝이 붙는다 — 봇 토큰으로 `gh api user`를 한 번 불러 **로그인
이름**(토큰이 아니다)을 `$GITHUB_ENV`의 `FACTORY_BOT_LOGIN`으로 넘긴다. 잡 토큰의 로그인조차
해석되지 않으면 fail closed.

### (c) `factory:merged` 규칙이 정족수를 다시 센다
같은 헬퍼로 quorum + all-approve + K. 그리고 merge는 `buildContext`를 거치지 않으므로 `buildCtxExtra`가
CHARTER에서 읽은 로스터와 K를 받도록 바뀌었다(`reviewRoster`, `maxRounds` 인자) — 규칙에 검사를 넣는
것과 **그 검사가 실제로 물리는 것**은 다른 일이다.

### (d) 두 배우 모드에서 토큰이 없으면 잡이 죽는다
`factory-merge.yml`의 **첫 스텝**(`id: two-actor-token-guard`, 체크아웃보다도 앞)이
`vars.FACTORY_TWO_ACTOR == 'true'`인데 `secrets.FACTORY_MERGE_TOKEN == ''`이면 `exit 1`한다.
폴백 자체는 남는다 — 단일 배우 모드에는 그것이 정답이다. yml-lint 규칙
`merge-token-required-when-two-actor`(scope: repo)가 "폴백이 있으면 가드 스텝도 있어야 한다"를 고정한다.
열쇠는 `id:`다(자유 텍스트인 `name:`이 아니라) — `merge-token-scope`의 스크럽 예외와 같은 방식이다.

### (e) 사람 게이트는 CHARTER의 명시적 선택이 됐다
CHARTER frontmatter에 `merge: { human_gate: true|false }`. `loadCharter`는 **기본값을 채우지 않는다** —
"없음"과 "false"는 다른 사실이기 때문이다.

| 상태 | bootstrap | doctor |
|---|---|---|
| `true` | `factory-merge` 환경에 `reviewers: [{type: User, id: <소유자 id>}]` → 모든 머지 잡이 사람 앞에서 멈춘다 | PASS `charter.merge-human-gate` |
| `false` | 리뷰어 없음 + 무엇을 잃는지 말하는 note | **WARN** `merge.dark — no per-PR human signature (merge.human_gate=false)` |
| 없음 | true로 읽는다(fail closed — 다크는 기본값이 아니다) | **FAIL** `charter.merge-human-gate-unset` |

소유자 id는 `gh api user`의 `id`로 한 번에 얻는다(로그인과 같은 응답). id를 못 얻으면 `reviewers`를
**넣지 않는다**: 없는 리뷰어를 넣으면 PUT이 422로 실패해 환경이 통째로 안 만들어지고 시크릿 보호까지
함께 잃는다 — 대신 note가 그 공백을 이름으로 말한다.

머지 전이 텍스트도 이 사실을 싣는다(`humanGateNote`): 사람이 서명했는지, 다크였는지, 선언 자체가
없었는지가 이슈 코멘트와 run 기록에 매번 남는다.

**KTB 자신은 `false`다** — 소유자 결정, 이유는 `docs/factory/CHARTER.md`의 "머지 권한 — 사람 게이트"
절에 적혀 있다: 이 저장소는 다크 루프를 증명하는 것 자체가 산출물이고, 머지마다 사람의 클릭을 요구하면
그 측정이 성립하지 않는다. 대가(사람의 서명은 토큰 등록 1회뿐)와 그 대가를 감당할 수 있는 이유
(저장소 하나·소유자 한 명·전부 squash라 revert 한 번)까지 같은 자리에 적었다.
**채택 저장소 템플릿의 기본값은 반대(`true`)다** — 남의 코드베이스에 다크 머지를 기본으로 심지 않는다.

## 3. 채택자에게 보이는 동작 변화

1. **머지가 더 자주 `factory:needs-human`으로 떨어진다.** 리뷰 handoff가 PR head에 묶여 있지 않거나,
   정족수가 안 맞거나, `factory/review`·`factory/gates` 상태가 없거나 팩토리가 올린 것이 아니면
   자동 머지가 멈춘다. 사유는 항상 `review verification failed — <정확한 이유>`로 시작한다.
   → **업그레이드 직후의 첫 머지에서 가장 흔한 원인**: 옛 워크플로가 `FACTORY_BOT_LOGIN`을 넘기지
   않고 두 배우 모드라면, `factory/review`의 게시자(에이전트 배우)가 잡 토큰(머지 배우)과 달라
   막힌다. `factory init --upgrade`로 워크플로를 갱신하면 풀린다.
2. **`factory doctor`에 새 줄이 생긴다.** `merge.human_gate`를 아직 선언하지 않은 CHARTER는
   `charter.merge-human-gate-unset` **FAIL**이다. 고치는 법은 frontmatter 한 줄이고, 그 한 줄이 곧
   결정의 기록이다.
3. **`merge.human_gate: true`로 부트스트랩하면 머지 잡이 사람을 기다린다.** GitHub 환경의 required
   reviewer가 잡 시작 전에 승인을 요구하므로, 다크 완주는 그 순간부터 "사람 클릭 1회 포함"이 된다.
   이것이 기본값이다(템플릿 CHARTER).
4. **두 배우 모드에서 머지 토큰이 비면 머지 잡이 첫 스텝에서 죽는다** — 예전에는 조용히 봇 토큰으로
   머지했다. 실패 메시지가 어디를 볼지(환경 시크릿 / 보호 브랜치에서 시작했는가) 말한다.
5. **새 필수 호출 하나**: 머지 잡이 `GET /repos/{repo}/commits/{sha}/statuses`를 한 번 더 부른다
   (읽기 전용, 봇/머지 토큰 둘 다 가능).
6. **yml-lint 규칙 추가**: `merge-token-required-when-two-actor`. 자기 워크플로에
   `secrets.FACTORY_MERGE_TOKEN || …`를 쓴 저장소는 가드 스텝을 함께 둬야 한다.

## 4. 남은 구멍 (이 태스크가 닫지 않은 것)

- **게시자 확인은 에이전트 배우 자신의 위조를 막지 못한다.** `factory/review` 상태를 올리는 계정이
  곧 에이전트가 쥔 계정이므로, 이 검사가 거르는 것은 *제3자의* 위조와 *상태 자체의 부재*다.
  에이전트의 자기 위조를 막는 것은 (i) 훅의 `gh api …/statuses/` 차단(Task 1)과 (ii) **정족수를
  handoff에서 다시 세는 것**(이 태스크의 (a)) 두 겹이다 — 상태 하나만으로는 더 이상 머지되지 않는다.
  근본 해결은 리뷰 증거를 커밋 상태가 아니라 서명된 산출물로 옮기는 것이고, 이 사이클 밖이다.
- **`FACTORY_BOT_LOGIN`은 워크플로가 넘기는 값이다.** 워크플로를 고칠 수 있는 주체는 이 값을 속일 수
  있다 — 그 지점의 방어선은 린트가 아니라 L1이다(`.github/**`가 `[protected].factory`라 사람 머지).
- **tier는 여전히 triage handoff의 자기 신고다**(감사 H3). 머지 스테이지의 로스터도 그 tier에서
  나오므로, tier를 낮게 신고하면 정족수도 함께 낮아진다. `tier_effective`는 Task 4의 몫이다.

## 5. 리뷰 batch-1 수정 — 리뷰 증거에 출처를 붙였다 (H1b-b)

적대적 재리뷰(`scratchpad/review-audit-batch1-report.md` §2c)의 판정: **위조한 handoff 코멘트 하나가
`verifyReviewQuorum`을 그대로 통과한다.** §4가 "보상 층"으로 꼽은 둘이 모두 열려 있었기 때문이다 —
(i) 훅의 `gh api …/statuses/` 차단은 `curl` 철자로 우회되고(MF-1, ADR-023), (ii) 재계산된 정족수는
**출처가 없는 재료**로 계산된다(`parseHandoffs`는 작성자를 버리고, `gh issue comment`는 열려 있으며,
`creator.login` 대조는 에이전트가 쥔 바로 그 계정을 통과시킨다).

**무엇을 바꿨나**

1. **run 기록이 판정을 싣는다**(`factory/lib/run-record.js`). review 스테이지가 `claude -p`가 **끝난 뒤**
   `review-evidence: head_sha=… round=… decision=… verdicts=role=verdict,…` 한 줄을 남긴다. sha는 handoff가
   적은 값이 아니라 **스테이지가 실제로 체크아웃한 커밋**(`checkoutSha`)이다. 그 기록은 `syncRecords`가
   `factory/records`로 민다.
2. **머지가 둘을 대조한다**(`factory/lib/review-quorum.js` `verifyReviewProvenance`, `merge-stage.js` §(6b2)).
   같은 커밋 · 같은 verdict 집합(역할 순서 무관) · 같은 라운드여야 하고, 기록이 없거나 읽히지 않으면
   `review evidence not bound to a factory run`으로 **needs-human**이다(fail closed). 정족수 검사(6b)와
   두 배우 승인(6c) **사이**가 아니라 승인 **앞**이다 — 승인 자체가 서명이다.
3. **그 브랜치를 잠갔다.** (a) 훅이 `git push … factory/records`·`factory/lock*`과 REST `git/refs` 철자를
   전부 막는다(러너의 `syncRecords`/`claim`은 Node에서 직접 git을 부르므로 훅을 거치지 않는다 — 이
   규칙이 막는 것은 **에이전트 세션의 Bash**뿐이다). (b) `bootstrapPlan`이 `factory/records`에
   force-push·삭제 금지 보호 op을 낸다. (c) doctor `protection.records`가 그 상태를 매 실행에서 말한다.

**에이전트가 스테이지보다 먼저 기록을 쓸 수 있는가 — 확인한 것**: 없다. 그 줄은 `claude -p`가 종료한 **뒤**
`runStage`가 직접 쓰고(세션 안에서는 아직 존재하지 않는다), 로컬 파일을 미리 고쳐 둬도 `syncRecords`의 꼬리
병합이 브랜치 tip 뒤에 이어 붙일 뿐이라 **머지가 읽는 것은 브랜치의 마지막 줄**이고 그 줄은 이번 런의 것이다.
브랜치로 직접 미는 경로는 훅이 막는다.

**잔여 위험(단일 자격증명) — 소리 내어 말한다**: 러너와 에이전트는 **같은 PAT**을 쓴다. 훅이 볼 수 없는 철자
(런타임 조립, ADR-020 잔여 위험 #4)로 push가 나가면 이 바인딩도 함께 무너진다. `restrictions`로 push를 머지
배우에게 묶을 수는 **없다** — 기록을 쓰는 것은 모든 스테이지의 러너이고, 좁히면 증거를 지키려다 기록 자체를
없앤다. 진짜 분리는 두 번째 배우이거나 `GITHUB_RUN_ID`에 묶인 서명 산출물이고, 그것이 다음 주기의 P0다.

**tier 바닥(잠정, Task 4까지)**: `reviewRoster()`가 triage의 자기 신고와 `.factory/out/gates.json`의
`tier_effective`를 `maxTier`로 합친다 — 자기 신고는 tier를 올릴 수는 있어도 내릴 수는 없다. §4가 남긴
"tier는 여전히 자기 신고다"의 절반이 이것으로 닫힌다(나머지는 Task 4).
