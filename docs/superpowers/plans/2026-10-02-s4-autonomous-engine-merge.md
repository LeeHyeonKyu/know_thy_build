# S4 — 비판정 경로의 엔진 자기 머지 (플랜 초안)

Date: 2026-10-02
Owner decision anchoring this: `docs/superpowers/specs/2026-09-30-explicit-submission-and-self-change.md` §8.2–8.4 (토론 뒤 v2).
Status: v2 — /333 1라운드 반영(`docs/research/s4-plan-debate.md`). 이슈 3건으로 공장에 제출한다.

## 0. 지금 어디까지 왔나

| 단계 | 상태 | 증거 |
|---|---|---|
| S1 귀속·명시적 제출 | 완료(1.4.35) | `principalFromEnv`, `explicitSubmission` |
| S2 큐 심사·상한 | 완료(1.4.35, S2b #137) | `lib/admission.js`, 하네스 이슈도 문을 지남 |
| S3 러너 미러 + #41 실증 | 완료(1.4.36–1.4.40, #136) | `lib/mirror.js`, `docs/research/simulation-136.md` |
| S3b 빌더가 base 병합 충돌을 끝냄 | 완료(엔진 #143/1.4.42, 프롬프트 1.4.41) | `loaded.merge_conflicts`, `assertBaseMergeComplete` |
| **S4** | 이 문서 | — |

엔진 이슈의 현재 끝: `approved` → merge 스테이지가 보호 경로를 보고 `needs-human`(`merge-stage.js:297-309`, 보호 경로가 **하나라도** 있으면 전부). #136·#143 둘 다 여기서 사람이 머지했다. S4의 목표는 그 분기를 **판정자 경로/비판정 경로**로 가르고, 비판정 경로만 안전망 뒤에서 공장이 머지하는 것.

## 1. 안전망의 구성 (스펙 §8.3을 구현 단위로)

```
approved ─ merge 스테이지 ─ 보호 경로 분류
            ├─ 판정자 경로 포함 ──────────────────────────► needs-human (오늘과 같음)
            └─ 비판정 경로만
                 ├─ CHARTER self_change.auto_merge_non_judge = false ─► needs-human (오늘과 같음; S4a·S4b 배포 중 기본값)
                 └─ true
                      ├─ 회로차단기 열림 ───────────────────► needs-human, 사유 "breaker open"
                      ├─ 거부 시드 카나리 ≠ GREEN ─────────► needs-human, 사유 "seed canary RED: <seed>"
                      ├─ 거부권 창(60분) 미경과 ───────────► merge 잡이 창이 닫힐 때까지 **잡 안에서** 기다린다(5분 폴링)
                      ├─ factory:veto 라벨 있음 ────────────► needs-human, 사유 "vetoed by <login>"
                      └─ 전부 통과 ───────────────────────► 기존 머지 경로(게이트 재실행 → squash → merged)
```

시계·증거는 전부 **러너가 쓴 것**만 쓴다: 거부권 창의 시작은 팩토리 계정이 올린 커밋 status의 `created_at`(위조 불가 — `verifyFactoryStatuses`와 같은 게시자 검사), 카나리 결과도 status, 회로차단기 상태는 `factory/records` 브랜치의 파일. 에이전트가 쓸 수 있는 것(이슈 본문·코멘트·PR 본문)은 어느 판정의 입력도 아니다.

## 2. 이슈 분할 (각 < 2,000줄 diff)

### S4a — 비판정 경로 양의 목록 + import-closure 테스트 + 잡 내 거부권 창 + CHARTER 스위치 (엔진, 공장이 만든다)
- `factory/lib/non-judge-paths.js` (신규): **판정자 경로를 열거하지 않는다** — 토론에서 그 목록이 새는 것이 확인됐다(`gh.js`가 `verifyFactoryStatuses`의
  로그인 집합을, `config.js`가 CHARTER 값을, `sweeper.js`가 재진입을 만든다). 대신 **비판정 경로를 양의 목록**으로 적고 목록 밖은 전부 judge다:
  `NON_JUDGE_GLOBS` = `docs/**`(단 `docs/factory/CHARTER.md` 제외), `templates/factory/docs/**`, `factory/lib/{board,board-static,progress,usage,heartbeat,agents-log,status,aggregate}.js`,
  `factory/bin/{board,scrub-artifacts}.js`, 그 `.factory/` 미러, `factory/test/` 중 위 모듈의 테스트. `classifyProtected(files, {engine}) → { non_judge, judge }`; `engine=false`(채택 저장소)면 전부 judge.
- **import-closure 테스트**(합성 공격면을 기계적으로 닫는다): 판정 모듈 집합 `{merge-stage, integrity, gates, requirements, self-gate, admission, transition, labels, protected-paths, review-quorum, gh, config}`과
  `bin/run-stage.js`의 정적 import 닫힘에 양의 목록 파일이 하나라도 들어오면 RED. 목록을 늘리는 PR은 이 테스트가 막는다.
- `merge-stage.js`: 보호 경로 분기를 분류 뒤로. `non_judge`만이고 CHARTER `self_change.auto_merge_non_judge === true`일 때만 새 경로. 그 외는 오늘과 동일한 `handToHuman`.
- 거부권 창은 **merge 잡 안에서** 기다린다 — sweeper의 stalled 팔에 맡기지 않는다(`STALLED_RESTART_LIMIT = 2`와 60분/30분 cron이 정확히 겹쳐 정상 대기가 정지로 오판된다;
  비판정 파일인 sweeper에 재진입을 맡기는 것 자체가 구멍). 첫 검사에서 status `factory/veto-window`(pending, `closes=<iso>`)와 PR 코멘트 1회를 남기고,
  `created_at`(러너 기록) + `veto_minutes`까지 5분 간격으로 `factory:veto` 라벨을 폴링한다. KTB는 호스티드 러너(공개 저장소)라 점유 비용이 없다.
  `factory-merge.yml`의 `timeout-minutes`는 사람이 90으로 올린다(워크플로 = 사람 머지).
- `factory:veto` 라벨: 카탈로그에 추가(상태 라벨 아님). 있으면 `needs-human`, 사유에 라벨을 붙인 계정(이벤트 API).
- CHARTER 프론트매터 `self_change: { auto_merge_non_judge: false, veto_minutes: 60 }` — 기본 false. 켜는 것은 사람의 CHARTER PR.
- done_when 초안: 분류(목록 밖 1개 섞이면 judge; `engine=false`면 전부 judge), import-closure, 스위치 false면 오늘과 바이트 같은 전이, 창 미경과→대기→경과 / veto 세 갈래(가짜 시계 주입), status 게시자 검사 실패 시 blocked.

### S4b — 거부 시드 카나리 (엔진; 시드 파일은 사람이 넣는다)
- `factory/seeds/<name>/{README.md,seed.patch}` 3건(사람 PR, NEVER_AUTOMATE에 `factory/seeds/**` 추가): (1) 기존 테스트 1개 삭제, (2) `block-dangerous.sh`의 패턴 1개 제거, (3) 이슈 `must_not`의 글롭을 건드리는 diff. 시드 목록은 어느 에이전트 프롬프트·컨텍스트에도 싣지 않는다(스펙 §8.3 마지막 줄).
- `factory/lib/canary.js` (공장이 만든다): PR head를 임시 워크트리에 받아 시드를 하나씩 적용하고 **새 엔진**(그 워크트리의 `factory/lib`)의 `integrityCheck`·`policyViolations`·must-not 게이트를 돌려 셋 다 거부되는지 본다. 에이전트 없음, 러너 시간만. 결과를 status `factory/seed-canary`(success/failure, description에 거부된 시드 수)로. merge 스테이지의 새 경로가 이 status를 요구(§1 표).
- 시드 자체가 오래되면(테스트 파일이 사라져 patch가 안 붙음) RED — "시드 갱신"은 사람 몫이고, RED는 자동 머지를 막을 뿐 사람 머지를 막지 않는다.

### S4c — 회로차단기 + 리셋 CLI (엔진)
- `factory/lib/breaker.js`: 상태 파일 `breaker.json`을 `factory/records` 브랜치에(러너만 쓴다). 열리는 조건(§8.2): `factory/seed-canary` failure 연속 2, **또는** 최근 엔진 머지 5건 창에서 사후 신호 악화 — `needs-human`·`rework` 전이 비율이 직전 창보다 높고 절대값 ≥ 0.4, **창의 표본이 3 미만이면 평가 보류**. 입력은 Actions 런 결과·전이 코멘트(러너 기록)뿐. 토론 결론: N=5는 통계적으로 약하므로 이것은 **2차 방어선**이다 — 1차는 양의 목록·잡 내 거부권·시드 카나리.
- 평가 시점: merge 스테이지 새 경로의 첫 검사 + sweep(`quick=false`)마다. 열리면 PR·이슈에 한 번 코멘트, 이후 모든 비판정 자동 머지가 `needs-human`.
- 리셋: `factory breaker --reset --reason` — 사람 전용(`refuseHumanFlag`와 같은 검사 + 훅 패턴). 쿨다운 6h는 리셋 뒤 자동 머지 재개까지의 대기.

### 순서와 켜는 시점
S4a → S4b(시드는 사람 PR 선행) → S4c → 소유자가 CHARTER 스위치를 켠다. 스위치가 꺼진 동안 세 이슈는 각각 오늘의 동작을 바꾸지 않으므로, 각 이슈는 오늘의 공장(S3b 포함)으로 만들고 사람이 머지한다(판정자 경로 — `merge-stage.js`는 그 자체가 판정자 경로이므로 S4 이슈 셋은 모두 사람 머지. 자동 머지가 처음 적용되는 것은 S4 **다음** 비판정 이슈다).

## 3. Interfaces (이슈 경계 고정)

```js
// S4a  factory/lib/non-judge-paths.js
export const NON_JUDGE_GLOBS: readonly string[];          // 양의 목록 — 목록 밖은 전부 judge
export const JUDGE_MODULES: readonly string[];            // import-closure 테스트의 뿌리
export function classifyProtected(files: string[], { engine: boolean }): { judge: string[], non_judge: string[] };
// S4a  merge-stage deps(d) 추가
d.selfChange: { auto_merge_non_judge: boolean, veto_minutes: number }   // CHARTER에서
d.vetoWindow: { open: () => Promise<{ ok, opened_at }>, read: () => Promise<{ ok, opened_at, reason? }> }  // factory/veto-window status(게시자 검사 포함)
d.vetoLabel:  () => Promise<{ ok: boolean, vetoed: boolean, by: string|null }>
d.sleep:      (ms) => Promise<void>, d.now: () => number   // 테스트가 시계를 주입한다
// S4b  factory/lib/canary.js
export async function runSeedCanary({ run, root, headSha, seedsDir }): Promise<{ ok: boolean, rejected: string[], accepted: string[], unapplied: string[] }>;
// merge-stage deps: d.seedCanary: () => Promise<{ ok: boolean, state: "success"|"failure"|"missing", reason?: string }>   // status 읽기
// S4c  factory/lib/breaker.js
export function evaluateBreaker({ canaryHistory, mergeWindows, now }): { open: boolean, reason: string|null, since: string|null };
// merge-stage deps: d.breaker: () => Promise<{ ok: boolean, open: boolean, reason?: string }>
```

merge 스테이지 새 경로의 판정 순서는 §1 표의 위에서 아래이며, 어느 dep이든 `ok:false`면 **판정 불가 → blocked**(통과가 아니다 — `verifyFactoryStatuses`와 같은 fail-closed).

## 4. 비용 추정
각 이슈는 #143 규모(엔진 ~300–600줄 + 테스트) — 실측 기준 implement+review $5–15, 라운드 2 이내. 카나리는 에이전트를 쓰지 않는다. S4 전체 ≈ $30–45 + 사람 머지 3회 + 시드 PR 1회.

## 5. 열린 질문 (/333에 물었고 답했다 — `docs/research/s4-plan-debate.md`)
1. 거부권 창의 재진입을 stalled 팔(30분 주기)에 맡기는 것이 맞는가, 아니면 merge 스테이지가 창이 닫힐 때까지 **기다리는** 것이 맞는가(러너 60분 점유 vs 재dispatch 2회).
2. 회로차단기의 "사후 신호 악화"를 어떤 신호로 재는가 — 전이 비율(위 초안) vs 되돌림(revert) 발생 vs 채택 저장소 health 잡.
3. 시드 3건을 KTB 저장소 안에 두는 것(에이전트가 읽을 수 있다)과 별도 비공개 저장소에 두는 것 중 어느 쪽인가.
4. 분할이 맞는가 — S4a가 스위치 꺼진 채 들어가는 것이 "동작을 바꾸지 않는 이슈"로서 리뷰 가능한가.

## 6. 결정 (2026-10-02, /333 1라운드)
1. 재진입: merge 잡 안에서 대기(sweeper 불의존). 2. 차단기: 전이 비율, 표본 하한 3, 2차 방어선. 3. 시드: 저장소 안 + NEVER_AUTOMATE + 프롬프트 미게재(dissent: 별도 비공개 저장소, S7과 재검토).
4. 분할 유지 — 합성 공격면은 양의 목록 + import-closure 테스트로 기계적으로 닫는다. 섀도 머지 대안은 기각(스테이지는 base 엔진으로 돈다, ADR-023).

## 7. v3 — 판정 경로도 자동 머지 (2026-10-03, 소유자 결정 ADR-033, 스펙 §8.5)
§1 표의 첫 가지("판정자 경로 포함 → needs-human")가 바뀐다: 판정 경로는 **만장일치 + GREEN + 거부권 창 + 차단기 닫힘**이면 공장이 머지한다.
- S4a(#149)에 더하는 것: CHARTER `self_change.auto_merge_judge`(기본 false) 파싱; `classifyProtected`가 `judge`를 돌려주면 리뷰 만장일치
  (`review handoff`의 verdicts 전원 approve, 로스터 수 = verdicts 수)를 요구하고, 스위치가 꺼져 있으면 오늘과 같이 `handToHuman`.
  나머지(거부권 창·status·veto 라벨)는 두 경로가 공유한다.
- S4c(차단기)의 입력에 "판정 경로 자동 머지 뒤 revert"를 더한다 — main에서 `Revert "…(#N)"` 커밋이 공장 머지 PR을 가리키면 1회로 센다. 연속 2회면 열림.
- 켜는 순서: S4a 머지 → `auto_merge_non_judge: true`(소유자) → S4c 머지 → `auto_merge_judge: true`(소유자). S4b(시드)는 차단기 입력으로 병행.
