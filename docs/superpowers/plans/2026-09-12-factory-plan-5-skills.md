# Factory Plan 5 — Human-Point Skills (13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "사람 지점 1개 = 스킬 1개"(§13.1)를 채운다 — Phase 1 스킬 4개 개정(`:project` `:technical` `:qa` `:feature`), `:finish` 삭제, 신설 9개(`:issue` `:harness` `:next` `:clarify` `:unstick` `:proposal` `:role` `:digest` `:status`), 스킬 파일 구조 린트(`doctor`), 설치기(`npx know-thy-build`) 갱신. 이 계획이 끝나면 사람이 등장하는 모든 지점에서 증거 요약 → 선택지 → L1 스크립트 경유 집행이 가능하다.

**Architecture:** 스킬은 `templates/know-thy-build/<name>.md`(설치 시 `.claude/commands/know-thy-build/`로 복사, `{{LANG}}` 치환)다. 모든 스킬 파일은 frontmatter(`description`, `allowed-tools`) + `## Language` + **§13.3 5개 섹션**(`## Trigger` `## Reads` `## Does` `## Produces` `## Must not`)을 갖고, Define 스킬은 그 뒤에 기존 소크라테스 본문을 잇는다. 운영 스킬은 3단계(요약 → 선택지 → 실행)이며 상태 변경은 **오직** `node .factory/bin/transition.js <issue> <label> --human --reason "…"`로, 결정은 `human-decision:v1` 코멘트로 남긴다. 머지는 어떤 스킬도 하지 않는다. `lib/skill-md.js`가 구조를 린트하고 `doctor`가 설치된 스킬을 검사한다.

**Tech Stack:** Markdown 템플릿, `bin/cli.js` 설치기(기존), Node/vitest(린트·설치 테스트), `gh` CLI, L1 스크립트(`transition.js`, `factory status`, `doctor`).

**Spec:** §13 전체(원칙·목록·정의·설치), §10(Phase 1 스킬 변경 표), §2.1(설치 명령), §3.1(라벨), §4.2.5(`factory run`과 큐 진입), §8.3(제안 PR 형식 — `:proposal`이 읽는다), ADR-015(R5·R7), Plan 2 `factory status`/`doctor`, Plan 3 역할 파일 구조(`:role`이 생성), Plan 4 `_retro.md`·제안 PR(`:proposal`·`:digest`가 읽는다).

## Global Constraints

- Plan 1–4 제약 상속. 커밋은 `spec/factory-1.0`, push 금지. 템플릿·설치기 변경은 테스트로 고정.
- **스킬 파일 구조(§13.3, `lintSkillMd`가 강제)**: frontmatter `description`(한 줄), `allowed-tools`(배열); 본문에 `## Language`(기존 `{{LANG}}` 문단 — 설치기가 치환), `## Trigger`, `## Reads`, `## Does`, `## Produces`, `## Must not`(이 순서, 각각 비어있지 않음). Define 스킬은 5개 섹션 뒤에 기존 본문(`## How You Operate` …)을 잇는다.
- **집행 규칙(모든 운영 스킬 공통 문단 — 동일 텍스트를 각 파일에 둔다, include 문법 금지)**: 라벨은 손으로 옮기지 않는다(`gh issue edit --add-label/--remove-label` 금지); 전이는 `node .factory/bin/transition.js <issue> <label> --human --reason "<why>"`; 거부되면 사유를 사람에게 보여주고 멈춘다; 머지는 `gh pr merge` 금지(GitHub UI 링크만); 결정은 이슈(또는 PR) 코멘트 `<!-- human-decision:v1 issue=<n> skill=<name> -->` + ```yaml 블록(`decision`, `reason`, `actions[]`)으로 `gh issue comment <n> --body-file <tmp>`(본문에 `>` 줄이 있을 수 있으므로 항상 `--body-file`); 모든 요약은 **먼저 읽고**(handoff·run 기록·gates.json·dissent) 한 화면(≤25줄)으로; 질문은 한 번에 하나, 선택지는 2~3개에 권장 표시.
- 운영 스킬은 `factory init` 전에는 첫 줄에서 "factory가 아직 없음 — `npx know-thy-build factory init`"을 안내하고 종료(`.factory/bin/run-stage.js` 존재로 판단, §13.4).
- Define 스킬 개정은 **수술적**이다: §10 표의 변경만 하고 소크라테스 본문·체크포인트·문서 템플릿은 유지. 삭제 대상 문자열(worktree 워크플로, 서브에이전트 디스패치, `check-merge-gate.sh` 훅 생성, feature frontmatter `gate:`)이 파일에 남지 않아야 한다(테스트가 grep).
- `:finish` 삭제: 템플릿 삭제 + 설치기 `LEGACY_FILES`에 `know-thy-build/finish.md` 추가(설치 시 기존 설치본 제거) + help 텍스트 갱신.
- 설치기 help(`bin/cli.js`)는 13개 스킬을 Define 5(`project technical qa feature issue`) / Operate 8(`harness next clarify unstick proposal role digest status`)로 나열한다(§2.1의 "12개"는 `:issue` 추가로 13 — 스펙 §2.1 문구도 동기화).
- 예시 대화(§13.3의 `:unstick`·`:proposal`)는 파일에 **그대로** 싣는다(사람이 읽는 규범).

## Rulings baked into this plan

| # | 결정 | 근거 |
|---|---|---|
| P5-R1 | Define 스킬에도 §13.3 5개 섹션을 요약 블록으로 넣는다(본문 앞) — `doctor`가 13개 전부를 같은 규칙으로 검사 | §13.3 "모든 스킬 파일은 다음 구조" |
| P5-R2 | `:issue --now`와 `:next`의 큐 진입은 `transition.js <n> factory:queue --human`(라벨 그래프 `backlog → queue`, 요구조건 없음) — `factory run triage`가 아니다 | §13.3; 로컬 실행은 사용자가 별도로 `factory run` |
| P5-R3 | `:status`는 `npx know-thy-build factory status`를 실행해 그 출력을 그대로 보여주고, 항목마다 해당 스킬 명령을 덧붙인다(중복 구현 금지) | §13.4 "CLI는 비대화형 버전" |
| P5-R4 | `:proposal`의 드라이런은 "가능한 것만": lint 규칙 → 지난 N개 PR diff에 적용(`gh pr list --state merged`, `gh pr diff`), 임계 조정 → run 기록의 값 분포(`docs/factory/runs` on `factory/records`), 역할 신설 → 과거 PR 1~2건에 `claude -p`로 그 역할만 spawn(`--agent` 파일 지정, 사용자 확인 후) — 안 되는 경우 "드라이런 불가 사유"를 적고 승인 권고를 하지 않는다 | §13.3 Must not |
| P5-R5 | `:role`의 시험 실행도 같은 방식(`claude -p` + 임시 agent 파일) — 사용자에게 토큰 소비를 먼저 알린다 | §13.3 |
| P5-R6 | `:digest`는 `docs/factory/digests/YYYY-Wnn.md`를 쓰되 코드/이슈를 만들지 않는다; 입력은 `factory/records` 브랜치의 run 기록 + 머지된 PR + `_retro.md` | §13.3 |
| P5-R7 | `:project`의 Operations 섹션은 "M0 하네스 구축"으로 교체: 스택 결정 → 러너 설치 → `test/smoke` 1개 → `.factory/harness.toml`(템플릿을 프로젝트 값으로 채움; `factory init`이 먼저 실행돼 있어야 하며 없으면 실행 안내) → `npx know-thy-build factory doctor --no-run`(명령 실행은 스택 설치 후 전체 doctor) → PASS 전엔 `status: complete` 금지. CLAUDE.md의 Worktree Workflow 절과 `check-merge-gate` 훅 생성 절은 삭제하고 "Factory" 절(라벨 흐름·`factory status`·스킬 진입점)로 교체 | §10 |

---

## File Structure

```
templates/know-thy-build/
├── project.md · technical.md · qa.md · feature.md     # (개정)
├── architect.md · designer.md                         # (유지)
├── finish.md                                           # (삭제)
├── issue.md · harness.md · next.md · clarify.md        # (신설)
├── unstick.md · proposal.md                            # (신설, 예시 대화 포함)
└── role.md · digest.md · status.md                     # (신설)
bin/cli.js                                              # (수정) LEGACY_FILES, help 13개, Pipeline 안내
factory/lib/skill-md.js                                 # parseSkillMd / lintSkillMd / SKILL_SECTIONS
factory/lib/doctor/factory.js                           # (수정) checkSkills({root, exists, readFile, list})
factory/cli/doctor.js                                   # (수정) 배선 (.claude/commands/know-thy-build/*.md 있을 때)
factory/test/skills.test.js                             # 13개 템플릿 린트 + 설치기 통합(tmp dir에 설치 → 13개, finish 제거)
factory/test/doctor-factory.test.js                     # (추가) checkSkills
docs/factory/DECISIONS.md                               # ADR-018
docs/superpowers/specs/…factory-design.md               # §2.1·§10·§13.4 sync
README.md                                               # 스킬 목록
```

---

### Task 1: 스킬 린트 + doctor + 설치기 갱신 + `:finish` 삭제

- `factory/lib/skill-md.js`: `SKILL_SECTIONS = ["Language","Trigger","Reads","Does","Produces","Must not"]`; `parseSkillMd(text) → {frontmatter, sections: Map}`(`lib/frontmatter.js` + `## ` 분할; frontmatter `allowed-tools: [A, B]` 인라인 배열); `lintSkillMd(text, {name}) → violations[]`: description 비어있지 않음, allowed-tools 배열 ≥1, `{{LANG}}` 문자열 존재(템플릿) 또는 `## Language` 존재(설치본), 5개 섹션 존재·비어있지 않음·순서, 운영 스킬(`harness next clarify unstick proposal role digest status`)은 본문에 `transition.js` 언급 + `gh pr merge` 금지 문구 + `human-decision:v1` 문구, `:status`·`:digest`는 예외(읽기 전용 — `human-decision` 불필요).
- `checkSkills({ root, exists, readFile, list })`: `.claude/commands/know-thy-build/*.md`가 있으면 각 파일 lint → `skills.<name>` PASS/FAIL; 13개 중 없는 것 → `skills.missing` WARN(목록); 디렉토리 없음 → `skills.installed` PASS-info "not installed — npx know-thy-build".
- `bin/cli.js`: `LEGACY_FILES += "know-thy-build/finish.md"`(경로가 commandsDir 기준이므로 `join(commandsDir, "know-thy-build", "finish.md")` 처리 — 기존 `cleanLegacy` 로직에 하위 경로 지원), help·Pipeline 텍스트를 13개/Define·Operate로, `templates/know-thy-build/finish.md` 삭제.
- 테스트: `skills.test.js` — 픽스처 lint 규칙 각각; 설치기: `node bin/cli.js --lang ko`를 tmp cwd에서 실행(spawnSync, `HOME`을 tmp로) → `.claude/commands/know-thy-build/` 파일 수 == 템플릿 수, `{{LANG}}` 없음, 미리 만든 `finish.md`가 제거됨; `doctor-factory.test.js` checkSkills 케이스.
- [ ] 커밋 `feat(factory): skill template linter, doctor checkSkills, installer 13-skill catalog, :finish removed`.

### Task 2: Phase 1 스킬 4개 개정(§10) — `project`, `technical`, `qa`, `feature`

수술적 편집(각 파일):
- 공통: frontmatter 유지(description 갱신), `## Language` 직후에 §13.3 5개 섹션 요약 블록 삽입(스펙 §13.3의 해당 항목 문장을 그대로).
- `project.md`: `### Operations — How does code ship?` 절을 P5-R7 내용으로 교체; `## Update CLAUDE.md`의 Worktree Workflow 절·"sub-agent dispatched" 흐름·`check-merge-gate.sh` 훅 생성 절(`## …merge gate hook` 포함) 삭제 → "Factory" 절(백로그→queue 흐름, `factory status`, 스킬 진입점, 보호 경로 안내)로 교체; `status: complete` 조건에 "doctor PASS" 추가; migration 절의 evolve 모드에 "브라운필드 성숙도 판정(M1/M2) → harness.toml 초안은 `:harness`로" 한 줄.
- `technical.md`: 산출물에 `docs/factory/CHARTER.md`(draft) 추가 — TDR "되돌리기 어려운 결정" → `load_bearing`, "절대 자동화 금지" → `NEVER_AUTOMATE`, 프로젝트 성격 → `tier_default`·hard limits; frontmatter는 Plan 2 템플릿 형식(`schema: factory.charter.v1`, `status: draft`)을 그대로 쓰고 값만 채움; `status: ready`는 사람이 바꾼다(Must not).
- `qa.md`: REVIEW/TEST 모드 절 삭제(리뷰어 역할로 이관, 안내 한 줄), SETUP에 §5.2.5-① 결정성 규칙 구체화 절(fake timer·시드·네트워크 차단·DB 격리·순서 무작위·sleep 금지 lint) + `harness.toml [test] [test.env] [test.fakes]` 값 작성 + 스모크 3개(성숙도까지) + `docs/QA.md` 산출 + `factory doctor` 통과 조건.
- `feature.md`: "Feature Classification" 이후의 워크트리 생성·서브에이전트 디스패치·`finish` 언급 삭제; 3-pass 유지; done_when 초안에 verify 레벨(현재 `harness.maturity` 이하만) 부여; 마지막 단계 `gh issue create --label backlog --title "<NNN> <title>" --body-file <tmp>`(요약 + 스펙 링크 + done_when 초안), 스펙 frontmatter에 `issue: <n>` 기록, `gate:` 필드 폐기; `--bug` 안내는 `:issue`로.
- 테스트(`skills.test.js`): 4개 lint 통과; 금지 문자열 부재(`worktree`, `check-merge-gate`, `finish`, `gate:` in feature frontmatter template, `Sub-agent`), 필수 문자열 존재(`harness.toml`, `factory doctor`, `CHARTER.md`, `status: draft`, `gh issue create`, `--label backlog`, `issue:`).
- [ ] 커밋 `feat(factory): revise project/technical/qa/feature skills for the factory (§10)`.

### Task 3: 신설 A — `issue.md`, `harness.md`, `next.md`, `clarify.md`

§13.3 정의를 그대로 5개 섹션 + 본문(문답 흐름, 명령 예시)으로. 공통 집행 문단 포함. 세부:
- `issue.md`: 5분 문답(증상/기대 vs 실제/재현/영향 경로) → 이슈 본문 템플릿(`## Symptom` `## Expected vs actual` `## Repro` `## Impact paths` `## done_when (draft)`: 버그면 `test_<issue>_<slug>` 회귀 가드 1개 기본 — 이슈 번호는 생성 후 코멘트로 보정) → `gh issue create --label backlog --body-file`; `--now` → 역압 확인(`factory status --json`의 `backPressure`) 후 `transition.js <n> factory:queue --human --reason "issue --now"`; Must not(설계 결정 숨기기 — `promote-to-feature` 되돌림 설명).
- `harness.md`: (a) doctor 실패 항목별 원인·수정 루프(`factory doctor` 재실행), (b) 브라운필드 adopt: 매니페스트·스키마·라우트에서 명령·성숙도·load_bearing 후보 도출 → harness.toml 초안 → doctor, (c) 승격 PR 요약(diff → "gate에 추가되는 것/비용/스모크 GREEN 여부") + GitHub 링크; Must not(머지, `[protected]` 축소).
- `next.md`: 읽기(`gh issue list --label backlog --json …`, 스펙 frontmatter `depends_on/priority`, CHARTER limits, `factory status --json`) → 요약 한 줄 → 추천 순서(의존성·tier 균형·역압) → 선택 → 역압 경고 → `transition.js <n> factory:queue --human` + human-decision.
- `clarify.md`: triage handoff `questions[]` 읽기(이슈 코멘트의 `factory-handoff:v1 stage=triage`) → 한 번에 하나 문답 → 스펙 본문·이슈 본문 갱신(`gh issue edit --body-file`) → `transition.js <n> factory:queue --human --reason "clarified"`; Must not(스스로 답하기).
- 테스트: 4개 lint 통과 + 각 파일에 핵심 명령 문자열(`transition.js`, `--label backlog`, `factory status --json`, `factory-handoff:v1 stage=triage`).
- [ ] 커밋 `feat(factory): :issue :harness :next :clarify skills`.

### Task 4: 신설 B — `unstick.md`, `proposal.md`

- `unstick.md`: §13.3의 3단계와 사유 코드별 선택지 표를 그대로; 읽기 목록(run 기록은 `factory/records` 브랜치 — `git fetch origin factory/records && git show origin/factory/records:docs/factory/runs/<n>.md`, needs-human 사유는 마지막 `factory-transition-refused` 또는 `factory-transition:v1 … to=factory:needs-human` 코멘트, handoff들, gates.json은 run 기록 안 판정줄); 예시 대화 verbatim; 실행 절: 분할(새 스펙 파일 + `gh issue create --label backlog` + 원 스펙 done_when 제거 + plan handoff 무효화 코멘트 `<!-- factory-handoff-invalidated stage=plan reason=… -->`) / 범위 축소 / `:proposal`로 이동 / wont-do(`transition.js <n> factory:wont-do`는 그래프에 없다 — needs-human → queue만 허용; wont-do는 이슈 close + human-decision으로 처리한다고 명시) / 재큐 `transition.js <n> factory:queue --human --reason "<decision>"`; Must not(사유 없는 재큐, K·M 즉석 변경).
- `proposal.md`: 제안 PR 본문 마커 `<!-- factory-retro:v1 period=… -->` 파싱, 종류별 요약, 드라이런(P5-R4 — 종류별 구체 명령), 비용 추정, 선택지, PR 코멘트(`gh pr comment --body-file`), human-decision, 머지 링크; 예시 대화 verbatim; `factory:harness` PR도 같은 흐름(요약 = `:harness` (c)).
- 테스트: lint + 예시 대화 존재(`/know-thy-build:unstick 118` 문자열, `PR #131`) + 금지 문구(`gh pr merge` 금지 문장 존재).
- [ ] 커밋 `feat(factory): :unstick and :proposal skills with worked examples`.

### Task 5: 신설 C — `role.md`, `digest.md`, `status.md`

- `role.md`: §7.2 구조를 문답으로(목적·입력·금지·Lens 5+·Examples 2/2·Perspectives 3) → `.claude/agents/<name>.md` 생성(구조 검증: `node -e` 로 `lintAgentMd` 호출 — `.factory/lib/agent-md.js`가 설치돼 있다) → `roles.toml` 블록 + `spawn_on`/model → CHARTER 로스터 diff 제안 → 시험 실행(P5-R5: `claude -p` + `--agent`? 정확히는 임시 커맨드 파일로 그 역할만 spawn, 토큰 고지) → PR(`factory/role-<name>` 브랜치, `factory:retro-proposal` 라벨 — protected이므로 사람 머지); Must not(기존 Lens 조용히 수정, 시험 없이 등록).
- `digest.md`: 기간(기본 지난 7일) 내 머지 PR(`gh pr list --state merged --search "merged:>=…"`), plan handoff(approach·dissent·open_risks), DECISIONS.md, `_retro.md` 통계 → PROJECT.md의 언어로 "이번 주 제품이 어떻게 변했나" → `docs/factory/digests/YYYY-Wnn.md`; 질문 응답 모드("왜 이렇게 했지?" → handoff·R2 반박 인용); Must not(코드·이슈 변경 — `:feature`/`:issue`로 유도).
- `status.md`: `npx know-thy-build factory status` 실행(출력 그대로) → Needs You 항목마다 `/know-thy-build:unstick <n>` 등 다음 명령 제시; 읽기 전용.
- 테스트: lint(`digest`·`status`는 human-decision 예외) + 핵심 문자열.
- [ ] 커밋 `feat(factory): :role :digest :status skills`.

### Task 6: 문서·설치 스모크

- ADR-018 "Plan 5 판결 — Define 스킬도 5섹션, `:status`는 CLI 래퍼, 드라이런은 가능한 것만, wont-do는 close+decision", 스펙 §2.1(13개), §10 표(finish 삭제 확인), §13.4(설치·doctor 검사), README 스킬 표.
- 스모크: tmp 디렉토리에 `node bin/cli.js --lang ko` → 13개 설치 → `factory init` → `factory doctor --no-run --offline`에 `skills.*` PASS 13개(리포트에 출력).
- [ ] 커밋 `docs(factory): ADR-018 and spec/README sync for the 13 skills`.

---

## Self-Review

**Spec coverage.** §13.2 표의 13개 전부(Task 2–5) ✓; §13.1 원칙 5개 — 집행 규칙 문단(1·2·4), 증거 먼저(3), 운영 스킬 3단계(5) ✓; §13.3 구조 + doctor 검사(Task 1) ✓; §13.4 설치(Task 1·6) ✓; §10 표(Task 2; `check-merge-gate.sh` 삭제, `finish` 삭제) ✓; `:status` CLI(Plan 2) 재사용 ✓. 갭: `:unstick`의 `wont-do` 전이는 라벨 그래프에 없어 close+decision으로 대체(스펙 §3.2 `needs_human → queue`만) — ADR-018에 기록.

**Placeholder scan.** 각 스킬의 흐름·명령·금지가 문장으로 고정. 예시 대화는 스펙 verbatim.

**Type consistency.** `lintSkillMd` 섹션 이름 ↔ 템플릿 헤더; `transition.js` 인자 형식(`<issue> <label> --human --reason`) ↔ Plan 1a bin; `factory status --json` 필드(`backPressure`) ↔ Plan 2; `factory-handoff:v1 stage=triage` ↔ Plan 1a 마커; `lintAgentMd` ↔ Plan 3.
