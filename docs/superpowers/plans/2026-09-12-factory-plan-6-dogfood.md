# Factory Plan 6 — Dogfood (Demo Greenfield → KTB → own-calendar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan contains human checkpoints (secrets, token spend) — the executor stops at each and asks.**

**Goal:** 스펙 §12.3의 통합 검증 — (1) 데모 그린필드 repo에서 `factory init → doctor → push → bootstrap → 이슈 N건 다크 처리`를 **실제 GitHub Actions + 구독 토큰**으로 완주하고, (2) KTB 자신을 브라운필드로 factory에 태우고(retro-proposal 경로의 시험대), (3) own-calendar 병렬 3건으로 claim·back-pressure·sweeper를 본다. 발견된 결함은 이 계획의 태스크로 고친다(Plan 1–5의 코드 수정 = 이 계획의 산출물). 성공 기준은 §12.4.

**Architecture:** 이 계획은 코드보다 **운영 절차**다. 각 태스크 = "준비 → 실행 → 관찰 → 결함 목록 → 수정 커밋 → 재실행". 관찰의 원천은 GitHub(라벨·코멘트·PR·체크·Actions 로그)과 `factory/records`의 run 기록·`_retro.md`. Phase 1의 대화형 스킬(`:project` `:technical` `:qa`)은 헤드리스로 돌릴 수 없으므로 데모용 Phase 1 산출물(PROJECT.md·TECHNICAL.md·QA.md·harness.toml·CHARTER ready·스모크)은 **픽스처로 작성**한다(스킬 자체는 Plan 5에서 lint로 검증됨).

**Tech Stack:** `gh` CLI(사용자 로그인 세션), GitHub Actions(ubuntu-latest), Claude Code CLI(러너 설치), 데모 repo `LeeHyeonKyu/know-thy-build-demo`(private; 스파이크 산출물은 태그 `spikes-done`), KTB repo 자신, own-calendar(사용자 경로 확인 필요).

**Spec:** §11 그린필드 흐름, §12.3 통합 검증 3단계, §12.4 성공 기준, §4.4 인증(구독 토큰·PAT), §4.2.5 로컬 경쟁, §5.2.1 성숙도 승격, §8.4 retro 트리거, ADR-005(소비 보고), ADR-015/016/017.

## Global Constraints

- **사람 체크포인트(반드시 멈추고 묻는다)**: (H1) `FACTORY_BOT_TOKEN` — 사용자 PAT(`repo`, `workflow` 스코프)을 데모 repo 시크릿으로 등록; 컨트롤러는 사용자의 토큰 값을 절대 대화에 노출하지 않으며 `gh auth token`을 임의로 시크릿에 넣지 않는다(사용자가 `! gh secret set FACTORY_BOT_TOKEN --repo LeeHyeonKyu/know-thy-build-demo` 형태로 직접 실행). (H2) 토큰 소비 — 각 다크 실행 전에 예상 스테이지 수·대략 소비를 알리고 진행 여부를 확인(구독 7일 창 상태는 사용자가 안다). (H3) own-calendar repo 위치/권한·데모 외 repo에 대한 bootstrap(브랜치 보호 변경)은 각각 확인 후.
- 데모 repo는 일회용: 스파이크 잔재(`.github/workflows/spike-*.yml`, `spikes/`, `.claude/*`)는 `factory init` 전에 제거하고 커밋(태그 `spikes-done`이 보존).
- 모든 상태 변경은 L1 스크립트/CLI 경유(`transition.js --human`, `factory run`); 라벨을 손으로 옮기지 않는다 — 단 "건너뛰기 시도 100% 차단" 검증(§12.4)에서는 **의도적으로** 손 라벨을 붙여 needs-human으로 되돌아오는지 본다.
- 결함 수정은 KTB 브랜치 `spec/factory-1.0`에 커밋(TDD, 테스트 추가) → 데모 repo에는 `factory init --upgrade`로 반영(패키지는 `npm pack` 결과를 `npx <tgz>`로 설치하거나 `node <ktb>/bin/cli.js factory …`로 직접 실행 — npm 미publish 상태).
- 관찰 기록: `docs/factory/dogfood/<date>-<target>.md`(KTB repo)에 실행별 표(이슈·스테이지·결과·소요·비용·결함 id) — retro가 아니라 사람이 읽는 문서.
- 성공 기준(§12.4): 무개입 완주율 ≥80%(표본은 데모 5건 + own-calendar 3건이면 1.0 기준 미달 — 이 계획에서는 "완주 ≥ 6/8, 손 라벨 차단 100%, R1→R2 뒤집힘 기록, revert 0"으로 대체 판정하고 ADR에 표본 크기를 명시).

## Rulings baked into this plan

| # | 결정 | 근거 |
|---|---|---|
| P6-R1 | Phase 1 산출물은 데모용 픽스처로 작성(대화형 스킬은 헤드리스 불가); 스킬 검증은 Plan 5 lint + 사용자의 수동 시연으로 분리 | 자율 실행 가능성 |
| P6-R2 | 데모 이슈 5건: docs 1(README 절 추가), standard 3(기능 2 + 버그 1 — 버그는 `:issue` 형식), flaky 1(의도적으로 시간 의존 테스트를 심은 이슈 → §5.2.5 경로 관찰) | tier·경로 커버리지 |
| P6-R3 | KTB 자기 dogfood는 `harness.toml`에 `unit = "npx vitest run --reporter=json --outputFile=.factory/out/unit.json"`·`lint = "node -e 0"`(lint 없음)·M0로 시작; factory 파일 변경 PR은 integrity가 막으므로 **KTB 개발 이슈는 사람 머지**(§12.3-2 시험대) — 1건만 | 범위 |
| P6-R4 | own-calendar는 사용자 확인(H3) 후, 병렬 3건은 모두 standard tier | claim/back-pressure/sweeper 관찰 목적 |
| P6-R5 | 러너의 `claude` 설치 실패·토큰 만료 등 환경 결함은 `blocked → needs-human`으로 관찰되면 성공(설계대로) — 결함 목록에 넣지 않는다 | §4.3 |

---

## File Structure

```
know-thy-build-demo/ (dogfood target 1)
├── docs/PROJECT.md · docs/TECHNICAL.md · docs/QA.md · docs/features/001..003.md   # fixtures
├── .factory/harness.toml (M1: compose+integration smoke exist from spikes)  · docs/factory/CHARTER.md (status: ready)
├── test/smoke.test.js · test/integration/smoke.test.js · e2e/smoke.spec.js
└── (factory init output)
know_thy_build/
├── docs/factory/dogfood/2026-09-1x-demo.md · …-ktb.md · …-own-calendar.md
├── docs/factory/DECISIONS.md   # ADR-019 dogfood findings + sample-size note
└── (fix commits across factory/**, templates/**)
```

---

### Task 1: 데모 repo 준비(픽스처 + 정리) — 로컬, 토큰 소비 없음

- 데모 repo 로컬 클론(`/Users/hk/workspace/know-thy-build-demo`)에서 `main`을 `spikes-done` 태그 기준으로 정리: 스파이크 워크플로·`.claude/`·`spikes/` 삭제(태그 유지). 기존 `src/`, `test/`, `e2e/`, `docker-compose.test.yml`, `playwright.config.js`, `vitest.config.js`는 유지(스파이크가 만든 M2급 골격 — 성숙도는 **M1**으로 선언해 e2e는 승격 이슈로 관찰).
- 픽스처 작성: `docs/PROJECT.md`(작은 노트 API — 3 페르소나·저니·원칙; Feature Registry 3건), `docs/TECHNICAL.md`(Express + SQLite(파일) 또는 in-memory, Testing Strategy 절), `docs/QA.md`(결정성 규칙·fixture·네이밍·증거), `docs/features/001-create-note.md`, `002-list-notes.md`, `003-search.md`(각 done_when 초안 + `issue:` 자리), `.factory/harness.toml`(`[commands]` unit/integration/e2e·test_files·test_one·lint_file 실제 명령, maturity M1, `[test].smoke` 3개 중 unit·integration, `[test.env].compose`), `docs/factory/CHARTER.md`(`status: ready`, NEVER_AUTOMATE 2항).
- `node <ktb>/bin/cli.js factory init` → `factory doctor`(전체 — 명령 실제 실행, 스모크 GREEN) PASS 0 FAIL. 실패 항목은 픽스처 또는 **KTB 결함**으로 분류해 후자는 KTB에 수정 커밋.
- 커밋 + push(`main`, 아직 보호 없음). `docs/factory/dogfood/…-demo.md` 시작.
- [ ] 결과: doctor 출력, 수정된 KTB 결함 목록.

### Task 2: bootstrap + 시크릿 — **H1 체크포인트**

- `factory bootstrap --dry-run` 검토 → 사용자에게 (a) `FACTORY_BOT_TOKEN` PAT 등록 요청(직접 실행할 명령 제시), (b) `CLAUDE_CODE_OAUTH_TOKEN` 존재 확인(있음), (c) 진행 확인. → `factory bootstrap`(라벨 19, protection contexts=[integrity], strict=false, `FACTORY_TOKEN_ISSUED_AT`).
- `factory doctor --offline` 아닌 전체 doctor에서 `github.*` PASS 확인.
- [ ] 결과: bootstrap 출력, protection 상태(`gh api repos/…/branches/main/protection`).

### Task 3: 이슈 1건 다크 완주(docs tier) — **H2 체크포인트**

- `:feature` 대신 픽스처 스펙 001로 이슈 생성(`gh issue create --label backlog --body-file`, 본문에 `docs/features/001-create-note.md` 경로 포함) → `transition.js <n> factory:queue --human`(로컬 CLI로) → Actions 관찰: triage → plan → implement → review → merge, 각 잡의 run 기록·handoff·status·라벨 전이를 표로. 실패 시: 결함 분류(KTB 코드/템플릿/프롬프트/환경) → KTB 수정(TDD) → `factory init --upgrade` → 데모 커밋 → 이슈를 `:unstick` 절차(로컬 `transition.js --human`)로 재큐.
- retro 잡(머지 시) 관찰: `_retro.md` 생성, light/full, lessons PR 자체 머지 여부.
- [ ] 결과: 완주 여부, 라운드 수, 비용(`factory status`), 결함·수정 커밋.

### Task 4: 이슈 4건(standard ×3 + flaky ×1) + 건너뛰기 차단 + 로컬 경쟁

- 이슈 002·003(standard), 버그 1건(`:issue` 형식 본문), flaky 유도 이슈("응답 시간 기반 캐시 만료 테스트" — builder가 시간 의존 테스트를 쓰기 쉬운 스펙) → 순차/병렬 큐 진입(back-pressure `awaiting_review_max` 4 관찰).
- 검증: (a) 손 라벨 `factory:approved`를 미리 붙인 이슈 → merge 잡이 handoff 부재로 needs-human(§3.3), (b) `factory run triage <n>` 로컬 실행과 GitHub 잡의 claim 경쟁(§4.2.5) — 한쪽만 진행, (c) sweeper: 진행 중 잡을 취소해 heartbeat 끊김 → 30분 후 재큐 관찰(시간 단축을 위해 `staleMinutes`를 harness/CHARTER가 아닌 sweeper 인자로 낮추는 임시 옵션은 만들지 않는다 — 실제 30분 대기 또는 workflow_dispatch 후 관찰), (d) flaky: classify-failure 경로·`factory:flaky` 이슈 자동 생성·격리 등록(retro).
- [ ] 결과: 표 + 결함·수정. R1→R2 판정 뒤집힘 비율 기록(§12.4).

### Task 5: KTB 자기 dogfood(브라운필드 1건, 사람 머지)

- KTB repo에 `.factory/harness.toml`(P6-R3)·CHARTER(ready)·`factory init`(자기 자신의 템플릿으로) → `doctor` → bootstrap은 **H3 확인**(KTB main 보호 변경) → 이슈 1건(예: "doctor 출력에 `--json`의 summary 정렬") → 다크 처리 → factory 파일이 diff에 포함되면 integrity RED → 사람 머지 경로 관찰. 결과·판결을 ADR-019에.
- [ ] 결과: retro-proposal/사람 머지 경로 확인.

### Task 6: own-calendar 병렬 3건 — **H3 체크포인트**

- 사용자에게 repo 경로·권한·bootstrap 동의 확인 → `/project evolve`에 해당하는 브라운필드 harness 초안은 `:harness (b)` 절차를 컨트롤러가 수동 수행(스킬 자체는 대화형) → doctor PASS → 이슈 3건 동시 큐 → claim 충돌 없음·back-pressure·sweeper 관찰.
- [ ] 결과: 표 + 결함·수정.

### Task 7: 마무리 — ADR-019, 스펙 §12.4 표본 주석, README 상태, npm 패키징 점검

- ADR-019 "Dogfood 결과와 판결"(완주율·차단·뒤집힘·revert·결함 유형 통계·표본 크기 한계), 스펙 §12.3/§12.4 실측 주석, `docs/factory/dogfood/*.md` 링크, README "상태: 1.0.0-alpha dogfooded on N issues". `npm pack --dry-run` 재확인, `package.json` version은 그대로(publish는 사용자 결정).
- [ ] 커밋 `docs(factory): ADR-019 dogfood results`.

---

## Self-Review

**Spec coverage.** §12.3 세 단계(Task 1–4 / 5 / 6) ✓; §12.4 네 기준(Task 4 표·ADR-019) ✓; §11 흐름(Task 1–3) ✓; §4.2.5 경쟁·§4.3 sweeper·§5.2.5 flaky·§8.4 retro 트리거(Task 3–4) ✓. 갭: Phase 1 대화형 스킬의 실사용 시연은 사용자 몫(P6-R1).

**Placeholder scan.** 각 태스크는 준비/실행/관찰/기록 항목이 구체적. 픽스처 내용은 Task 1에서 실제로 쓴다(스펙의 예시 도메인 대신 작은 노트 API — 의존성 최소).

**Human checkpoints.** H1(시크릿) Task 2, H2(토큰 소비) Task 3·4·6 시작 시, H3(타 repo 보호 변경·경로) Task 5·6 — 컨트롤러는 여기서 반드시 멈춘다.
