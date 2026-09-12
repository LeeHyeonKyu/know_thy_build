# Factory Plan 4 — Retro, Lessons, Quarantine Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공장이 스스로 배우게 한다 — 머지 수로 깨어나는 retro 잡(경량 수확 + N번째마다 전체 분석), lesson·역할 예시/관점의 **다크 append**(L1 스크립트가 조건 검사 후 PR 생성·자체 머지), gate 승격·임계·역할 변경 **제안 PR**(사람 머지), 성숙도 승격 `factory:harness` 이슈 생성, flaky 격리 **등록**과 TTL 만료 처리, retro N 자가 조정. 이 계획이 끝나면 §8 전체와 §5.2.5-⑤의 "격리 등록"이 동작한다.

**Architecture:** retro는 라벨 상태 머신 밖의 잡이다 — `factory-retro.yml`(`pull_request: closed`, merged만, `concurrency: factory-retro`)이 `node .factory/bin/retro.js`를 호출한다. `retro.js`(L1)는 `factory/records` 브랜치의 `docs/factory/runs/_retro.md`에서 상태(마지막 retro 커서, 누적 머지 수, 현재 N, 이력, 후보)를 읽고, **경량 수확**(결정적 — LLM 없음: 마지막 커서 이후 handoff·run 기록에서 must_fix 주장·dissent·flaky id·needs-human 사유·사용량을 후보로 축적)을 매번 하며, 누적 머지 ≥ N이면 **전체 retro**: `claude -p "/factory-retro"`(디스패처 → `factory-retro.js` → `factory-retro` 에이전트가 후보·기록을 읽고 `factory.retro.v1`로 제안)를 돌리고, L1이 그 출력을 **조건 검사 후 집행**한다: lessons/예시/관점은 `factory/lessons-<date>` 브랜치 PR을 열어 `factory/integrity` GREEN이면 스스로 머지(다크), 그 외 제안은 `factory:retro-proposal` PR(사람), 성숙도 부족은 `factory:queue`+`factory:harness` 이슈, K회 자가 수정 실패한 `factory:flaky` 이슈는 `quarantine.toml` 등록. 마지막에 yield로 N을 조정하고 `_retro.md`를 갱신해 records 브랜치에 push한다.

**Tech Stack:** Plan 1–3과 동일(Node ≥22 ESM, smol-toml, vitest, `run()`/`gh` 주입, records-branch plumbing, Workflow 도구, vm 하네스).

**Spec:** §8.1 (입력·출력 4종·처리 방식), §8.2, §8.3 (제안 PR 형식), §8.4 (트리거·N 자가 조정·delta·최소 근거 창), §5.2.1 (성숙도 승격 감지 규칙 3개), §5.2.5-④⑤ (자가 수정 K회 → 격리, TTL → 다른 레벨 재작성 이슈, 삭제는 조용히 일어나지 않음), §7.4 (lessons 형식), §9 (run 기록·`_retro.md`), §6.1 (integrity의 lessons/additive-only 규칙), ADR-014 (records 브랜치), ADR-015 (L0 = integrity만 — lessons PR 자체 머지의 전제).

## Global Constraints

- Plan 1–3 제약 상속. 커밋은 `spec/factory-1.0`, push 금지. TDD.
- **retro는 절대 라벨을 옮기지 않고, 코드를 고치지 않는다.** 산출은 lessons/예시/관점 append(다크), 제안 PR(사람), 이슈 생성, `quarantine.toml`·`_retro.md` 갱신뿐.
- **최소 근거 창(§8.4)은 L1이 검사한다**: lesson 채택 근거 run ≥2(서로 다른 이슈), 예시/관점 추가 근거 run ≥2, gate 승격 인용 ≥3, 임계 조정 표본 ≥20 run, 역할 변경·신설 근거 ≥10 run. 조건 미달 후보는 `_retro.md` 후보 목록에 **남긴다**(다음 retro가 다시 본다). 에이전트가 "채택"이라 해도 L1이 근거를 세지 못하면 채택하지 않는다.
- lessons 항목 형식(§7.4, integrity가 검사): `- [L-YYYY-MM-DD-NN] <체크 문장>` + 다음 줄 `  근거: runs/<issue>.md, runs/<issue>.md. 인용: 0회.`; 역할당 `max`(헤더) 초과 시 **인용 0회·가장 오래된 항목부터** 삭제해 자리를 만든다(삭제도 PR diff에 보인다).
- 역할 파일 추가는 `## Examples`의 `### 좋은 발견`/`### 나쁜 발견` 및 `## Perspectives` **끝에 항목 append만**(상한 Examples 8/8, Perspectives 6 — 초과 시 추가하지 않고 후보로 유지). 다른 섹션은 건드리지 않는다(integrity additive_only가 막는다 — 스크립트가 어겨도 PR이 RED가 되어 머지되지 않는다).
- lessons PR 자체 머지 조건: PR의 `factory/integrity` 체크가 `success`(최대 10분 폴링, `gh pr checks`), diff가 `.factory/lessons/**`와 `.claude/agents/*.md`의 두 섹션 밖을 건드리지 않음(스크립트가 자기 diff를 `integrityCheck`로 로컬 선검사). 실패 → PR을 열어둔 채 `factory:needs-human` 라벨을 PR에 붙이고 종료(사람이 `:proposal`로 본다).
- 성숙도 승격 감지(§5.2.1 초기 규칙 3): (a) 매니페스트에 외부 SDK 추가됐는데 `[test.fakes]`에 없음, (b) DB 스키마 파일(`prisma/schema.prisma`, `**/migrations/**`, `*.sql`)이 있는데 M0, (c) HTTP 라우트(`express|fastify|hono|koa|next` 사용 또는 `routes/` 디렉토리)가 있는데 M1 이하. 결정적 스크립트(`lib/retro/maturity.js`)가 판정하고 에이전트는 이유 문장만 보탠다. 이슈 제목 `harness: promote to M<n> — <reason>`으로 dedup.
- 격리 등록: `factory:flaky` 라벨 이슈가 `factory:needs-human`(K 초과)에 도달했고 아직 `quarantine.toml`에 없으면 등록(`id`는 이슈 제목 `flaky: <id>`에서; `since`=지금; `reason`=needs-human 사유; `evidence`=run 링크). 상한 `quarantine_max` 초과 시 등록하되 back-pressure가 implement claim을 막는다(§5.2.5-⑤ — 방치 불가). 격리 등록/복귀/만료는 모두 해당 flaky 이슈에 코멘트를 남긴다.
- TTL 만료(sweeper가 `expired`로 표시) → retro가 "다른 레벨에서 다시 쓰는" 이슈(`backlog` + `factory:flaky`, 제목 `rewrite flaky test at another level: <id>`)를 만든다(dedup). 그 이슈가 다시 K회 실패하면 **삭제 후보**를 `_retro.md`에 기록하고 `docs/factory/DECISIONS.md` append는 **제안 PR**로 낸다(삭제는 사람 머지 — 조용히 일어나지 않는다).
- N 자가 조정(§8.4 표): yield = 채택된 lesson+예시/관점 추가+harness 이슈+제안 PR 수; 0 → `round(n×1.5)`, 1~2 → 유지, ≥3 또는 마지막 retro 이후 needs-human ≥2 → `round(n×0.5)`; `[min,max]` clamp; 이력은 `_retro.md`에.
- `_retro.md`는 records 브랜치의 `docs/factory/runs/_retro.md`(hydrate/sync 재사용). 기계 블록은 JSON 펜스 + 마커 `<!-- factory-retro-state:v1 -->`; 사람용 통계 표는 그 위.
- 스크립트는 인증 방식을 참조하지 않는다; retro 잡은 `claude` 설치(full일 때만 호출), `GH_TOKEN` PAT.

## Rulings baked into this plan

| # | 결정 | 근거 |
|---|---|---|
| P4-R1 | 경량 수확은 LLM 없이 결정적으로(§8.4 "경량 추출") — must_fix 주장·dissent·flaky id·needs-human 사유·usage를 후보로 축적 | 매 머지마다 도는 잡이 토큰을 쓰면 안 된다 |
| P4-R2 | lessons/예시/관점 PR은 retro.js가 **스스로 머지**한다(L0 = integrity만, ADR-015 보강). merge 스테이지는 관여하지 않는다 | §8.1 "다크" |
| P4-R3 | 격리 등록의 트리거는 `factory:flaky` 이슈의 `needs-human` 도달(K 초과) — retro가 등록한다(sweeper가 아님) | §5.2.5-⑤ "K회 자가 수정 실패 후"; retro는 이슈 이력을 읽는 유일한 잡 |
| P4-R4 | `retro.v1` 에이전트 출력은 **후보 + 근거 run 목록**만이고, 채택 여부·N 조정·이슈/PR 생성은 전부 L1 | 위조 불가 |
| P4-R5 | `factory-retro.yml`은 `pull_request: closed` + `if: merged == true`; `factory run retro`는 `--force`로 N 무시 전체 실행 | §8.4 |
| P4-R6 | retro 에이전트는 1명(`factory-retro`, opus) + loader 없음 — 워크플로 `factory-retro.js`는 후보 파일 경로만 인자로 받는다(`args.candidates = .factory/out/retro-candidates.json`, L1이 쓴다) | 단순성 |
| P4-R7 | 통계(리뷰 라운드 평균·리뷰어별 reject 기여·needs-human 수·사용량)는 L1이 handoff/records에서 계산해 `_retro.md`와 제안 PR 본문에 쓴다 | §8.3 통계 절 |

---

## File Structure

```
templates/factory/
├── github/workflows/factory-retro.yml
├── claude/commands/factory-retro.md           # 디스패처 (Plan 2 형식)
├── claude/workflows/factory-retro.js
└── claude/agents/factory-retro.md             # roles.toml [retro.analyst]
factory/
├── lib/retro/
│   ├── state.js          # parseRetroState(md)/renderRetroState(state); nextN(n, yield, needsHumanSince, {min,max}); shouldRunFull(state, charterRetro, force)
│   ├── harvest.js        # harvest({records, issues, comments, since}) → {candidates:{lessons[], examples[], flaky[], needs_human[]}, stats}
│   ├── maturity.js       # detectMaturityGaps({files, harness, manifest}) → [{target:'M1'|'M2', reason}]
│   ├── lessons.js        # applyLessons({lessonsText, adopted, today}) → {text, added[], evicted[]}; evidence check (≥2 distinct runs)
│   ├── role-additions.js # applyRoleAdditions({agentText, examples, perspectives}) → {text, added[]} with caps 8/8/6
│   ├── proposals.js      # renderProposalPr({period, proposals, stats}) → markdown (§8.3); evidence windows check
│   ├── quarantine-ops.js # registerFromFlakyIssues({issues, comments, quarantine, now}) → {q, registered[]}; expiredIssues({expired, existing}) → issues to create
│   └── publish.js        # openAndMergeLessonsPr({run, gh, cwd, files, date}) / openProposalPr(...) — branch, commit (plumbing or worktree), PR, poll checks, merge
├── bin/retro.js          # orchestration: hydrate _retro.md → harvest → (full?) claude -p → validate retro.v1 → apply → publish → nextN → sync
├── lib/schemas.js        # (수정) retro.v1
├── cli/run.js            # (수정) `factory run retro [--force]`
└── test/ (retro-state, retro-harvest, retro-maturity, retro-lessons, retro-role-additions, retro-proposals, retro-quarantine, retro-publish, retro-bin, workflows(+retro), agent-md(+retro), templates(+yml/command), yml-lint(+retro))
docs/
├── factory/DECISIONS.md                       # ADR-017
└── superpowers/specs/…factory-design.md       # §8 sync
```

---

### Task 1: retro 상태와 트리거 — `lib/retro/state.js`

**Interfaces:**
- `parseRetroState(md) → { cursor: {last_retro_at: ISO|null, last_record_offsets: {issue: lineCount}}, merges_since: number, n: number, history: [{at, yield, n_before, n_after, needs_human_since}], candidates: {...}, stats: {...} }` — 마커 `<!-- factory-retro-state:v1 -->` 뒤 첫 ```json 펜스; 파일 없음/마커 없음 → 기본 상태 `{merges_since: 0, n: charter.initial, history: [], candidates: {lessons: [], examples: [], flaky: [], needs_human: []}, stats: {}}`.
- `renderRetroState(state, {statsTable}) → md` — 사람용 표(마지막 retro·머지 수·N·이력 5줄) + 마커 + JSON.
- `nextN(n, { yield, needsHumanSince }, { min, max }) → number` — §8.4 표, `Math.round`, clamp.
- `shouldRunFull({ state, retro: charter.retro, force }) → { full: boolean, reason }` — `force` → true; `state.merges_since + 1 >= state.n` → true(이번 머지 포함); 아니면 light.

- [ ] 테스트: 기본 상태; 라운드트립(render→parse); `nextN`(0→×1.5, 2→유지, 3→×0.5, needsHuman 2→×0.5, clamp min/max, 반올림); `shouldRunFull`(초기 n=1이면 첫 머지에 full; n=3 merges_since=1 → light; force). 구현 → 커밋 `feat(factory): retro state file and N self-adjustment`.

### Task 2: 경량 수확과 통계 — `lib/retro/harvest.js` + `retro.v1` schema

**Interfaces:**
- `harvest({ records /*Map<issue,text>*/, issues /*[{number,title,labels,state,closedAt}]*/, handoffsByIssue /*Map<issue, parsed handoffs[]>*/, since /*ISO|null*/ }) → { candidates: { lessons: [{role, text, runs:[issue], source:'must_fix'|'dissent'|'needs_human'}], examples: [{role, kind:'good'|'bad', text, runs}], flaky: [{id, issue}], needs_human: [{issue, reason, at}] }, stats: { merged, review_rounds_avg, rejects_by_role: {}, needs_human, usage: {cost_usd, tokens} } }`
  - must_fix(reject) 항목 → lessons 후보(role = 그 리뷰어, text = claim의 일반화는 에이전트 몫이므로 원문 claim 저장), 같은 claim 텍스트가 다른 이슈에서 반복되면 `runs`에 누적.
  - dissent_log(unresolved) → skeptic/architect 예시 후보; needs-human 전이 코멘트(`factory-transition:v1 … to=factory:needs-human`) 사유 → `needs_human`.
  - `factory:flaky` 라벨 이슈 → `flaky` 후보(제목에서 id).
  - stats는 `since` 이후 병합된 이슈만(`closedAt > since`), usage는 `lib/usage.js` 재사용.
- `schemas.js` `retro.v1`: `{ period: {from, to}, lessons: [{role, text, evidence_runs: [number]≥1}], examples: [{role, kind, text, evidence_runs}], perspectives: [{role, text, evidence_runs}], harness: [{target, reason}], proposals: [{kind: 'gate'|'threshold'|'role-change'|'role-new'|'test-delete', title, body, evidence_runs}], summary }` (배열은 비어도 됨).

- [ ] 테스트: 픽스처 handoff(review reject ×2 같은 claim 다른 이슈 → runs 2), dissent, needs-human 코멘트, flaky 라벨, since 필터, stats 계산; `validate('retro.v1')` 정상/오류. 커밋 `feat(factory): deterministic retro harvest and retro.v1 schema`.

### Task 3: 성숙도 감지·lessons·역할 추가·격리 — 순수 모듈 4개

- `maturity.js`: `detectMaturityGaps({ files, harness, manifestDeps })` — 규칙 (a)(b)(c) 위 Global Constraints; 반환 `[{target, reason, rule}]`; 이미 그 성숙도면 빈 배열.
- `lessons.js`: `applyLessons({ text, adopted: [{text, evidence_runs}], today, minEvidence = 2 }) → { text, added: [{id, text}], rejected: [{text, reason}], evicted: [id] }` — id `L-<today>-NN`(당일 연번), 형식은 integrity `lessonsFormat`을 통과해야 한다(테스트가 `integrity.js`의 검사 함수로 확인 — export 필요 시 최소 export), `max` 초과 시 `인용: 0회` 오래된 것부터 evict, 중복 텍스트 거부, 근거 run 수 < min 거부.
- `role-additions.js`: `applyRoleAdditions({ text, examples: [{kind, text}], perspectives: [{text}], caps: {good: 8, bad: 8, perspectives: 6} }) → { text, added, skipped }` — `parseAgentMd`로 섹션 위치를 찾고 해당 소제목 끝에 `- ` 항목 append; 상한/중복 skip; 다른 바이트는 불변(테스트: 결과에서 추가 줄을 제거하면 원문과 동일).
- `quarantine-ops.js`: `registerFromFlakyIssues({ issues, commentsByIssue, quarantine, now }) → { q, registered: [{id, issue}] }` (needs-human + flaky 라벨 + 미등록); `rewriteIssuesForExpired({ expired: [id], openIssues }) → [{title, body, labels}]`(dedup); `deletionCandidates({ rewriteIssues, K })`.

- [ ] 각 모듈 테스트(형식 검증은 실제 integrity 검사 함수로) → 커밋 `feat(factory): maturity detection, lessons/role-addition writers, quarantine registration`.

### Task 4: 제안 PR 렌더링과 publish — `proposals.js`, `publish.js`

- `proposals.js`: `filterByEvidence(proposals) → {accepted, deferred}`(gate ≥3 인용, threshold ≥20 run, role-change/new ≥10 run, test-delete = 항상 accepted — 삭제 제안은 사람 판단); `renderProposalPr({ period, proposals, stats }) → { title, body }` §8.3 형식(`<!-- factory-retro:v1 period=… -->`, P1…Pn, 통계 절).
- `publish.js`(모두 `run`/`gh` 주입, 워킹 트리는 **임시 worktree**에서만 조작 — 러너의 checkout은 건드리지 않는다):
  - `openAndMergeLessonsPr({ run, gh, cwd, defaultBranch, files: {path: content}, date, pollMs, maxPolls, integrityCheck }) → { pr, merged: boolean, reason }` — worktree `git worktree add <tmp> origin/<default>` → 파일 쓰기 → `integrityCheck({base: origin/<default>})` 로컬 선검사(RED면 PR 안 열고 `{merged:false, reason}`) → commit(`factory-bot`) → push `factory/lessons-<date>` → `gh pr create` (title `retro: lessons/examples <date>`, body 목록) → `gh pr checks` 폴링 `factory/integrity` success → `gh pr merge --squash --delete-branch` → 실패/타임아웃 시 PR에 라벨 `factory:needs-human` + 코멘트 → worktree 제거(finally).
  - `openProposalPr({ run, gh, cwd, defaultBranch, files: {path: content} /* docs/factory/retro/<date>.md + 선택적 DECISIONS append */, title, body, date }) → { pr }` — 라벨 `factory:retro-proposal`; 머지하지 않는다.

- [ ] 테스트: fake gh/run으로 argv 시퀀스·폴링(success/pending→timeout)·integrity RED 경로·finally worktree 제거; 렌더 스냅샷. 커밋 `feat(factory): retro proposal rendering and PR publishing (dark lessons merge, human proposals)`.

### Task 5: retro 에이전트·워크플로·디스패처 + schema 배선

- `templates/factory/claude/agents/factory-retro.md`(roles.toml `[retro.analyst]` opus; deny-all-writes 훅; Lens: 후보를 **일반화된 체크 문장**으로 다듬기(위치·조건·확인 방법), 같은 실패가 2개 이상 이슈에서 반복될 때만 lesson, gate 승격은 정적 검사로 표현 가능한 것만, 역할 신설은 어떤 렌즈에도 없던 reject 패턴에만, 삭제 제안은 대체 검증이 있을 때만; Examples/Perspectives/Lessons(`.factory/lessons/factory-retro.md` 골격 추가)).
- `factory-retro.js`: `args.candidates`(경로) → `phase('Analyze')` 단일 agent(`agentType:'factory-retro'`, model opus, schema RETRO_V1 리터럴) → null 1회 재spawn → return `{...out, orchestration:'workflow', guarantee:'structural'}`; 프롬프트는 `.factory/out/retro-candidates.json`(L1이 harvest 결과+stats+`_retro.md` 이력을 써 둔다), `docs/factory/runs/*.md`(hydrate된), `.factory/lessons/*.md`(현재 상한 여유), `.claude/agents/*.md`(현재 Examples 수)를 읽으라고 지시.
- `templates/factory/claude/commands/factory-retro.md` 디스패처(Plan 2 형식, `args: { candidates: ".factory/out/retro-candidates.json" }`).
- `lib/agent-md` 훅 규칙에 `factory-retro` 추가; templates/agent-md/workflows 테스트 갱신(lessons 15, agents 15, workflows 5).

- [ ] 테스트(vm 하네스: 호출 1회·재spawn·return 검증; lint) → 커밋 `feat(factory): retro analyst agent, workflow and dispatcher`.

### Task 6: `bin/retro.js` 오케스트레이션 + yml + `factory run retro`

- `runRetro({ deps, force }) → 0|1|2` (`bin/retro.js`에 export; `main()`이 실제 deps 조립):
  1. `hydrate`: records 브랜치에서 `docs/factory/runs/*.md` + `_retro.md` 복원(`readRecords`), `state = parseRetroState`.
  2. `merges_since += 1`(트리거가 머지 이벤트일 때; `--force`면 증가 없음).
  3. `harvest` → 후보를 state.candidates에 병합(중복 runs 합치기), `stats` 갱신.
  4. `shouldRunFull` 아니면 → `renderRetroState` → `syncRecords`(`_retro.md`만) → 기록 `retro: light (merges_since=<k>/<n>)` → 0.
  5. full: `.factory/out/retro-candidates.json` 작성 → `claude -p "/factory-retro" --max-turns 5 --output-format json --permission-mode dontAsk` → stdout 저장 `.factory/out/retro.json` → `extractJson` + `validate('retro.v1')` 실패 → 기록 + `_retro.md`에 `last_full_failed` + 0 (retro 실패는 공장을 멈추지 않는다; 다음 머지에 다시).
  6. 집행(각각 try/catch 격리, 결과를 `applied` 목록에): `applyLessons` per role → `applyRoleAdditions` per agent → `openAndMergeLessonsPr`; `detectMaturityGaps` → `gh.createIssue`(dedup by title, labels `factory:queue`,`factory:harness`); `registerFromFlakyIssues` → `saveQuarantine` + 코멘트; `rewriteIssuesForExpired`(sweeper 결과는 `quarantine.toml`에 없고 flaky 이슈 코멘트로만 남으므로 — Task 3의 `expiredIssues`는 `_retro.md`의 `expired` 기록에서 읽는다: sweeper가 만료 처리할 때 `_retro.md`가 아닌 flaky 이슈에 코멘트 `<!-- factory-quarantine expired id=… -->`를 남기도록 sweeper를 **수정**(Plan 1b 이월 "expired 코멘트")하고 retro는 그 코멘트를 읽는다); `filterByEvidence(proposals)` → `openProposalPr`.
  7. `yield` = added lessons + added examples/perspectives + harness issues + proposal PR(1) → `nextN` → history push → `renderRetroState` → `syncRecords` → run 기록 `docs/factory/runs/_retro.md`가 아닌 `retro` 섹션은 `_retro.md` 자체의 사람용 표에 남긴다.
- `factory-retro.yml`: `on: pull_request: types: [closed]`, job `if: github.event.pull_request.merged == true`, `concurrency: { group: factory-retro, cancel-in-progress: false }`, timeout 30, setup action `claude: "true"`, `test-env: "false"`, env `GH_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`, `run: node .factory/bin/retro.js`, upload `.factory/out/` with `include-hidden-files`. yml-lint 테스트에 추가; `templates.test.js` 8 ymls.
- `cli/run.js`: `factory run retro [--force]` → `node .factory/bin/retro.js [--force]`(Plan 2의 "retro arrives with Plan 4" 메시지 제거).
- sweeper 수정: 만료·복귀 시 해당 flaky 이슈(제목 `flaky: <id>` 검색)에 코멘트(마커 `<!-- factory-quarantine <returned|expired> id=<id> -->`).

- [ ] 테스트: `runRetro` with fake deps(light 경로; full 경로 — 각 집행 단계 호출·격리·yield·nextN; validate 실패 경로; force); yml 텍스트; run CLI; sweeper 코멘트. 커밋 `feat(factory): retro job orchestration, workflow template, factory run retro, quarantine comments`.

### Task 7: 문서 — ADR-017 + 스펙 §8/§5.2.5 동기화

- ADR-017 "Plan 4 판결 — 경량 수확은 결정적, lessons PR 자체 머지, 격리 등록은 retro, `_retro.md` 상태": P4-R1..R7 + 실행 판결.
- 스펙: §8.1 표(처리 주체 스크립트 이름 실제 파일명으로), §8.4(`_retro.md` 위치·마커), §5.2.5-⑤(등록 주체 retro, 코멘트 마커), §4.1 표 retro 행 "(Plan 4)" 제거, §2.1 `factory run retro`.
- README 한 줄. `npm test` 전체, `factory init` 임시 repo에 retro 파일 5개 설치 확인.

- [ ] 커밋 `docs(factory): ADR-017 and spec sync for Plan 4 retro`.

---

## Self-Review

**Spec coverage.** §8.1 lesson(다크, Task 3·4·6) / gate 승격·역할 변경 제안(사람, Task 4·6) / 예시·관점 추가(다크, Task 3·4) ✓; §8.3 형식(Task 4) ✓; §8.4 트리거·N·delta·최소 근거 창·직렬(Task 1·6, yml concurrency) ✓; §5.2.1 승격 감지 3규칙(Task 3) ✓; §5.2.5-④⑤ 등록·TTL·삭제 제안(Task 3·6) ✓; Plan 1b 이월 "expired 코멘트"(Task 6 sweeper) ✓, "F7 per-suite 자동복귀" — 등록이 생기면 기존 `applyPolicy` 복귀 경로가 도달 가능해진다(Task 6 sweeper 코멘트로 가시화) ✓. 갭: 통계 기반 임계 조정 제안의 구체 규칙(예: "quarantine_max 도달 3회 → 상향")은 에이전트 판단 + ≥20 run 창으로만(1.0).

**Placeholder scan.** 각 Task는 인터페이스·규칙·테스트 항목을 문장으로 고정. 프롬프트/에이전트 파일은 Plan 3의 형식·린터를 따른다.

**Type consistency.** `retro.v1` 필드 ↔ 워크플로 schema 리터럴 ↔ `bin/retro.js` 집행 입력; `_retro.md` 상태 ↔ `nextN`/`shouldRunFull`; `readRecords/syncRecords`(Plan 2) 재사용; `parseAgentMd`(Plan 3) 재사용.
