# Research: 리뷰 로스터·라운드 축소의 실측 근거 (핸드오버 후보 A·B)
Date: 2026-09-29
Question: 핸드오버(`docs/factory/handover/2026-09-29-factory-efficiency.md`) 후보 A(리뷰 로스터·K 축소)와 B(플랜 단가)는
러너가 쓴 기록으로 뒷받침되는가? 어느 역할을 빼면 라운드 판정이 달라지는가?

## Findings

### 1. 역할별 판정 — 러너가 쓴 `review-evidence:` 줄 전수 [1][2]

| 역할 | own-calendar 판정 / 거부 / 단독 거부 | 데모 판정 / 거부 / 단독 거부 |
|---|---|---|
| spec-conformance | 32 / 11 / **9** | 23 / 6 / 3 |
| correctness | 32 / 2 / 1 | 23 / 9 / **5** |
| qa | 32 / 3 / 1 | 22 / 6 / 2 |
| architecture | 32 / 1 / **0** | 22 / 2 / **0** |
| security | 7 / 0 / 0 | — (로스터에 없음) |

"단독 거부" = 그 라운드에서 거부한 역할이 그 하나뿐 — 그 역할이 없었다면 라운드가 `approved`로 끝났을 경우다.

- **architecture는 54판정 중 거부 3, 단독 거부 0.** 세 번 모두 같은 라운드에서 correctness도 거부했다
  (own-calendar #3 r2, 데모 #15 r3·#7 r3). 로스터에서 빼도 55개 라운드의 판정은 **하나도 달라지지 않는다.**
- **security는 7/7 승인.** 이미 load-bearing 전용이고 표본이 작다 — 이 데이터로는 빼야 할 근거도 남길 근거도 없다.
- **correctness는 뺄 수 없다.** own-calendar에서는 거부 2건이지만 데모에서는 단독 거부 5건으로 가장 많이 막았다.
  KTB #123이 correctness를 "승인만 한다"고 짚은 것은 창(최근 머지 5건)이 좁아서 생긴 결과다.
- **KTB #122·#123·#124의 증거는 한 사건이다.** 셋 다 own-calendar #49 r2의 "승인 뒤 거부" 1건에서 나왔고, 그 거부는
  qa가 낸 flaky 테스트(L34)였다 [3]. 세 이슈는 독립된 세 근거가 아니다. 로스터 축소의 근거는 위 표다.

### 2. 3라운드의 수확 [1][2]

3라운드까지 간 이슈 8건(own-calendar #3 #9 #49, 데모 #15 #18 #7 #76 #87) 중 r3에서 승인된 것은 #49 하나다.
나머지 7건은 r3도 `rework`였고 사람 결정으로 끝났다(#3은 사람 재시도 뒤 r4 승인). K=2면 r3 런 7개(라운드당 $6–13)를
쓰지 않고 같은 결론(사람)에 한 라운드 먼저 도달한다. 대가는 #49 같은 경우 1/8이 사람에게 간다는 것.

### 3. 후보 B는 대부분 이미 기본값이다 [4]

`factory/lib/config.js`의 `PLAN_DEFAULTS`는 `{ mode: "single", debate_tiers: ["load-bearing"] }`이고
`planRoundsFor`는 단일 모드에서 `plan_rounds`를 읽지 않는다. 핸드오버 B의 "docs/테스트 전용 이슈는 single"은
docs·standard tier 전체에 이미 적용돼 있다. 남은 것은 토론 tier(load-bearing)의 `plan_rounds.default` 3 → 2뿐이고,
own-calendar는 09-28에 이미 2로 낮췄다 [5].

### 4. 핸드오버 문서의 사실 오류

- §6이 가리키는 `.superpowers/sdd/2026-09-27-own-cal-campaign/{retro.mjs,roles.mjs}`는 그 디렉터리에 없다
  (`progress.md`, `retro.md`, `watch-issues.sh`, 후보 목록 둘만 있음). 아래 부록의 스크립트가 역할 표를 다시 만든다.

## 결론

| 제안 | 근거 | 판정 |
|---|---|---|
| standard 로스터에서 architecture 제거 | 단독 거부 0/54 | 채택 — 판정 변화 없이 역할 비용(own-calendar $127, 데모 $52) 절감 |
| security는 load-bearing 전용 유지 | 표본 7 | 변경 없음 |
| K 3 → 2 | r3 승인 1/8 | 채택 — 도그푸드 저장소에서 먼저 |
| `plan_rounds.default` 3 → 2 | L38 타임아웃, own-calendar #91·#100 통과 | 데모·템플릿에 반영 |
| correctness 축소 | 데모 단독 거부 5 | 기각 |

## Sources
1. `LeeHyeonKyu/own-calendar` `factory/records` 브랜치 `docs/factory/runs/*.md`의 `review-evidence:` 줄 (32 라운드)
2. `LeeHyeonKyu/know-thy-build-demo` 같은 경로 (23 라운드)
3. KTB 이슈 #122, #123, #124 본문의 `chain` 필드
4. `factory/lib/config.js` — `PLAN_DEFAULTS`, `planRoundsFor`
5. own-calendar `docs/factory/CHARTER.md` 프론트매터 (`plan_rounds: { docs: 2, default: 2 }`)

## 부록 — 집계 스크립트

`node roles.mjs <저장소 경로>` (먼저 `git fetch origin`).

```js
import { execFileSync } from "node:child_process";
const [repo] = process.argv.slice(2);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1e9 });
const files = git("ls-tree", "--name-only", "origin/factory/records", "docs/factory/runs/").trim().split("\n").filter(f => /\/\d+\.md$/.test(f));
const stats = {}; const rounds = []; 
for (const f of files) {
  const body = git("show", `origin/factory/records:${f}`);
  const seen = new Set();
  for (const l of body.split("\n")) {
    if (!l.startsWith("review-evidence:")) continue;
    const kv = Object.fromEntries(l.slice(16).trim().split(/\s+/).map(p => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
    const key = kv.run_id + ":" + kv.round; if (seen.has(key)) continue; seen.add(key);
    const v = Object.fromEntries((kv.verdicts || "").split(",").filter(Boolean).map(x => x.split("=")));
    rounds.push({ issue: f.match(/(\d+)\.md/)[1], round: kv.round, decision: kv.decision, v });
    const rejecters = Object.entries(v).filter(([, d]) => d !== "approve").map(([r]) => r);
    for (const [r, d] of Object.entries(v)) {
      const s = stats[r] ??= { verdicts: 0, approve: 0, reject: 0, sole: 0, other: {} };
      s.verdicts++; if (d === "approve") s.approve++; else { s.reject++; if (d !== "reject") s.other[d] = (s.other[d] || 0) + 1; if (rejecters.length === 1) s.sole++; }
    }
  }
}
console.log("rounds:", rounds.length, "decisions:", JSON.stringify(rounds.reduce((a, r) => (a[r.decision] = (a[r.decision] || 0) + 1, a), {})));
console.table(stats);
for (const r of rounds) console.log(`#${r.issue} r${r.round} ${r.decision} :: ${Object.entries(r.v).map(([k, d]) => `${k}=${d}`).join(" ")}`);
```
