# know_thy_build 구현체 평가 — 비판 중심 (외부 조사)

평가일: 2026-09-14 · 대상: `LeeHyeonKyu/know_thy_build` @ `2ab390c` (414 파일)
기준: SW Factory 조사(addyosmani/factory, spec-kit, 12-factor-agents, StrongDM, Stanford CodeX, arXiv:2604.02460, Osmani 146 PR 실측)
출처: 사용자가 제공한 외부 평가 원문. 이 파일은 원문을 보존하고, 대응은 `docs/superpowers/plans/2026-09-14-factory-audit-hardening.md`와 ADR-023이 맡는다.

---

## 0. 판정 요약

**엔지니어링 품질은 이 분야 공개 구현 중 상위권이다.** 락 CAS lease, head_sha 바인딩, base 코드로 계산하는 protectedPaths, 리포트↔exit code 양방향 교차검증, 두 배우 토큰 분리 — 전부 실제 사고에서 나왔고 스크립트로 강제된다.

**그러나 팩토리로서는 세 가지가 무너져 있다.**

1. **리뷰를 건너뛰고 머지까지 가는 경로가 실재한다.** 훅을 직접 실행해 우회를 재현했고, 체인의 나머지 단계는 전부 "허용된 명령"이다.
2. **실효 게이트는 `vitest` 하나다.** `lint = "node -e 0"`, `fast`/`full`/`deep`이 전부 동일, coverage·mutation 주석 처리, maturity M0이 레벨을 `fast`로 강등. 설정 오류로 못 돈 게이트는 GREEN으로 계산된다(fail-open). 게이트 자체를 테스트가 그렇게 고정해 뒀다.
3. **가장 비싼 컴포넌트가 자기 증거 없이 서 있다.** 226런 $563, 다크 완주 머지 1건, 단일 에이전트 베이스라인 0건. plan 토론(4토론자×3라운드, 19 에이전트 스폰)이 이슈당 비용의 약 40%인데, 그 토론이 막아낸 결함의 기록이 없다.

한 문장으로: **오케스트레이션은 구현했고 검증은 구현하지 않았다.**

## 1. 잘 된 것

| 항목 | 위치 | 왜 좋은가 |
|---|---|---|
| 게이트 양방향 교차검증 | `.factory/lib/gates.js:105-112` | exit 0 위조와 리포터가 삼킨 실패를 둘 다 잡고, 리포트를 못 읽은 RED는 절대 뒤집지 않는다 |
| head_sha 3중 바인딩 | `.factory/lib/requirements.js:37-47` | "손으로 만든 GREEN", "다른 커밋의 GREEN", `diagnostic:true` 전부 거부 |
| protectedPaths가 base 코드로 계산 | `.factory/bin/run-stage.js:1133-1150` | PR이 자기 `integrity.js`나 `[protected]`를 고쳐도 판정이 안 바뀐다 |
| `--no-renames` 강제 | `.factory/lib/integrity.js:170-178` | rename으로 보호 경로를 빠져나가는 구멍을 닫음 |
| 락 CAS lease + `live`/`stale`/`unknown` | `.factory/lib/claim.js` | "모른다"를 별도 상태로 두고 사람을 부른다 |
| `allChecksGreen` fail-closed | `.factory/lib/gh.js:11-20` | 체크가 없으면 "확인 못 함" |
| 정족수 위조 방지 | `aggregate.js:4`, `factory-review.js:395-405` | 에이전트가 자칭한 판정을 믿지 않고 `must_fix`에서 verdict를 재도출 |
| 자기 수정 경계가 코드 | `integrity.js:93` + `merge-stage.js:222-242` | `additive_only`를 실제로 집행 |
| 비용 회계 | `usage.js:145-176` | cache까지 합산, 회귀 테스트로 고정 |
| 도그푸드 로그가 실패를 숨기지 않음 | `docs/factory/dogfood/2026-09-12-demo.md` | "무개입 완주 0/2", "$67 소각, 머지 0건" |

## 2. HIGH — 재현 확인된 결함

### H1. 리뷰를 전부 건너뛰고 머지되는 경로
(a) `block-dangerous.sh`가 백슬래시 줄바꿈 하나로 열린다 — 규칙이 줄 단위(`echo "$c" | grep -E`)라 `gh pr \⏎merge 5 --squash`, `git push origin \⏎--force main`, `gh issue edit 7 \⏎--add-label factory:approved`가 exit 0. `permissions.deny`의 접두 매칭도 동시에 빗나간다. 대조: `deny-all-writes.sh`는 명령 모양을 보므로 살아남는다.
(b) 에이전트가 자기 commit status를 붙일 수 있다 — `mergeGates`의 유일한 리뷰 증거는 required checks(`run-stage.js:907` → `allChecksGreen`)인데 게시자를 검증하지 않고, `gh api -X POST /repos/o/r/statuses/<sha> -f state=success -f context=factory/review`는 훅이 막지 않는다. `FACTORY_BOT_TOKEN`은 PAT `repo` 스코프라 status를 쓸 수 있다.
(c) 머지가 리뷰보다 먼저 일어난다 — `merge-stage.js:476` `mergePr` → `:487` `transition(merged)`. `factory:merged` 규칙은 머지된 뒤 평가되고, 정족수·all-approve 검사는 `factory:approved`에만 있다.
체인: handoff 위조(`gh issue comment` 허용) → status 위조 → `\⏎`로 라벨 편집 → mergeGates 통과 → 자동 승인·머지. 리뷰어 5명이 한 번도 뜨지 않고 main에 들어간다. 완화: 이 저장소의 `[protected].factory`는 넓지만 채택 저장소 템플릿 기본값은 좁다.

### H2. 게이트가 fail-open이다
`gates.js:61-63`: `misconfigured`가 차 있어도 status에 영향이 없고, `names.includes(n)` 필터 때문에 `required`에 있으나 레벨 목록에 없는 게이트는 무시된다. 실측 `status=GREEN misconfigured=prove-test,new-test-repeat,diff_coverage,mutation`. `gates.test.js:98-100`이 이를 정답으로 고정. prove-test/new-test-repeat는 사후 주입(`gates.js:264,267`)이라 required가 될 수 없다. 실효 게이트는 `unit` 하나(`harness.toml:53-56` fast/full/deep 동일, `lint="node -e 0"`, `MAX_LEVEL.M0="fast"`). 템플릿이 이 구성 그대로 배포된다.

### H3. tier가 자기 신고이고 자기 채점자를 고른다
`context.js:14` `tier = handoffs.triage?.tier ?? charter.tier_default` → roster·plan 라운드. `tierFloor`는 게이트 레벨만 승격하고 `tier_effective`는 소비처 0곳. `[load_bearing].paths`가 `factory/lib/...`를 가리키는데 설치본은 `.factory/lib/...`.

### H4. `cold_read`는 구현되지 않았다
`roles.toml`의 `cold_read = true`를 읽는 JS가 없다. `context.js:12-13`은 모든 handoff를 `context.json`에 쓰고, `factory-review.js:342`는 리뷰어에게 그 파일을 읽으라고 지시한 뒤 `:351`에서 plan만 읽지 말라 한다. `handoffs.implement`(verifier 판정)는 금지 목록에 없다. 훅은 읽기를 막지 않는다.

### H5. 테스트 변조 방어가 사실상 없다
`integrity.js:60-62`는 test_glob의 추가된 줄에서 skip pragma만 탐지; `removedLines`는 `additive_only` 글롭에만. 기존 테스트 파일 삭제·단언 변경 → 위반 0 → 자동 머지.

### H6. 인간 게이트가 사실상 없는데 back-pressure는 인간을 지키는 척한다
`merge-stage.js:465` `approvePr`가 admin PAT로 자동 승인 — 사람 서명은 토큰 등록 1회. `awaiting_review_max: 4`는 사람 주의력이 아니라 동시 잡 수를 보호하고, 검사는 implement 진입 한 곳뿐이며 예외 시 fail-open(`run-stage.js:187`). `MERGE_ENVIRONMENT_BODY`(`bootstrap.js:55`)에 `reviewers`만 넣으면 진짜 human gate가 생긴다.

## 3. MED
M1 CHARTER default-allow(`factory-triage.md:31-37`). M2 prove-test는 base exit≠0만 봄(`prove-test.js:22-24`; base에 `npm ci` 없음). M3 base 5/5 실패도 `flaky-existing`(`classify-failure.js:43`, `gates.js:236-255`). M4 quarantine이 모든 스테이지에서 RED→GREEN(`gates.js:100-105`). M5 `factory-loader`가 JSON을 읽으려고 LLM 호출(`factory-plan.js:190`, `context.js:18`). M6 죽은 훅 `check-merge-gate.sh:5` `$TOOL_INPUT`. M7 `FACTORY_MERGE_TOKEN || FACTORY_BOT_TOKEN` 무성 강등(`factory-merge.yml:60`). M8 보호 목록 세 곳 불일치(`harness.toml`/`ci-settings.json`/`block-dangerous.sh:73`). M9 harness 모드에서 `harness.toml` 보호 섹션 편집 가능(`block-dangerous.sh:101`). M10 lessons 15개 전부 헤더뿐. M11 `evidence_runs` 길이만 검사(`retro.js:540,544`), 인용 카운터 미증가(`lessons.js:116`). M12 docs tier `DOC_GLOBS=["docs/**","*.md"]`가 리뷰어 프롬프트 변경을 포함(`gates.js:262`). M13 중복 스테이지 실행, 라벨 조회 실패 시 통과.

## 4. 증거 기반 판정
누적 $563.01 / 226 runs; 다크 완주 머지 1건; 라운드 3 무개입 0/2; #2 plan 4회 재시도 ≈$67 소각; plan이 이슈당 ~40%; plan 1런 에이전트 19개; 단일 에이전트 baseline 0건. `docs/research/multi-agent-model-allocation-industry.md:167,272`와 `multi-agent-model-guidance-for-repo.md`(cross-provider 권고)에 반대 증거가 있으나 구현은 all-Claude 5명이며 그 선택의 ADR이 없다. R2의 `on_others`는 생성만 되고 소비되지 않는다.

## 5. 연구 대조표 (요약)
fail-closed 게이트 ❌(H2) · verdict 축자 인용 ✅ · cold read ❌(H4) · non-test hunk 되돌림 △ · 기존 테스트 수정 금지 ❌(H5) · tier 자기 신고 △(H3) · charter default-deny ❌(M1) · back-pressure가 사람 주의력 보호 ❌(H6) · 모든 머지는 사람 ❌(H6) · 리뷰어 아키텍처 다양성 ❌ · 단일 에이전트 baseline ❌ · 실행/업무 상태 통합 ✅ · 사람 에스컬레이션 툴 호출 ✅ · 제어 흐름 소유 ✅.

## 6. 우선순위 수정
P0: (1) 훅을 판정 전에 정규화(`\⏎` 조인 + 공백 축약, 단일 문자열); (2) `gh api …/statuses/` 차단; (3) 머지 전에 리뷰 확인 — `mergePr` 앞으로 review handoff 검사, `factory:merged` 규칙에 정족수+all-approve 재확인; (4) `factory-merge` 환경 required reviewer 1명 또는 명시적 설정.
P1: (5) `recomputeStatus` fail-closed, `gates.test.js:100` 단언 뒤집기; (6) PROOF_GATES required 가능; (7) `lint="node -e 0"` 제거; (8) 테스트 변조 탐지(삭제/변경 줄); (9) `tier_effective`→로스터.
P2: (10) 단일 에이전트 plan baseline 실험(≈$12/이슈); (11) plan R2 + 서명 2라운드 삭제 검토; (12) `cold_read` 배선; (13) `on_others` 집계; (14) `factory-loader` 제거; (15) 리뷰어 1명 다른 모델 패밀리.

## 7. 전략적 지적
Define(스펙 정의·QA 프레임워크)이 더 잘 되어 있고 시장에서 덜 붐빈다. Operate(다크 루프)에 비용·코드가 집중됐는데 검증 계층이 가장 얇다. 다음 사이클은 P0/P1에만.

## 8. 검증 방법과 한계
직접 재현: 백슬래시 우회 6케이스, statuses 미차단, MISCONFIGURED→GREEN 및 그 테스트 단언, cold_read 소비처 0, lessons 파일 크기, `mergePr`가 transition보다 앞, `allChecksGreen` 게시자 미검증, tier→roster 경로. 실행 재현 안 함: M13, M9, M11, M2. H1 체인은 구성 가능성 확인이며 끝까지 실행하지는 않음. 평가 시점 커밋 `2ab390c`.
