import { applyPolicy } from "./quarantine.js";
import { quarantineComment } from "./retro/quarantine-ops.js";
import { BLOCKED_ORIGIN, TRANSITION_TO, blockedOrigin, lastTransition } from "./retro/issue-comments.js";
import { STATES } from "./labels.js";
const HB = /<!--\s*factory-heartbeat issue=(\d+)\s*-->[\s\S]*?last:\s*(\S+)/;
const RETRY = /<!--\s*factory-retry issue=(\d+) count=(\d+)\s*-->/;

/**
 * **대기 상태 → 그 상태에서 돌아야 할 스테이지** (KTB-8의 세 번째 팔).
 *
 * 앞의 두 팔은 "런이 있었다"는 흔적을 전제한다 — `factory:in-progress`는 하트비트를, `factory:blocked`는
 * 스테이지가 남긴 라벨을 본다. 그런데 데모 #2가 죽은 방식은 **런이 아예 만들어지지 않은 것**이었다:
 * 라벨 이벤트가 만든 5개 런이 한 concurrency 그룹에서 서로를 취소해 `factory-plan`이 1초 만에 밀려났고,
 * 이슈는 `factory:ready`에 하트비트도 blocked 라벨도 없이 앉아 있었다. 두 팔 모두에게 보이지 않는다.
 *
 * 라벨을 다시 붙여 되살릴 수도 없다(같은 라벨은 `labeled` 이벤트를 만들지 않는다) — 그래서 재점화는
 * `workflow_dispatch`뿐이고, 그 손잡이를 스테이지 워크플로 5개에 달았다.
 */
const STALLED_STAGE = {
  "factory:ready": "plan",
  "factory:planned": "implement",
  "factory:awaiting-review": "review",
  "factory:approved": "merge",
};
/** 재점화 마커 — 이것 자체가 "이미 밀어 봤다"는 기록이다(dedupe의 유일한 근거). */
export const restartComment = (stage, issue) => `<!-- factory-sweeper restarted stage=${stage} issue=${issue} -->`;

/**
 * ADR-020 KTB-28 (d) — **같은 이슈+스테이지를 몇 번까지 다시 미는가.** 데모 #15는 네 번 밀렸고 네 번
 * 모두 같은 벽(`claim()`의 고아 락)에 부딪혔다. 재점화는 "런이 만들어지지 않은 사고"를 되돌리려는
 * 것인데, 두 번 밀어도 같은 자리에 멈춰 있으면 사라진 것은 런이 아니라 **가정**이다 — 그때부터는
 * 사람이 봐야 한다(밀 때마다 plan 한 번 ~$12가 나갈 수 있다).
 *
 * 세는 것은 이슈 이력에 남은 재점화 마커 개수다(마커가 곧 기록이다 — 별도 카운터를 두면 둘이 갈라진다).
 */
export const STALLED_RESTART_LIMIT = 2;
export const stalledRestartLimitReason = `stalled restart limit (${STALLED_RESTART_LIMIT}) reached`;

/**
 * blocked 팔 전용 재시도 마커(KTB-19 review I-1). 예전에는 `restartComment`(stalled 팔과 **같은**
 * 마커)를 재사용했는데, 정상적인 흐름 하나가 그 dedupe를 조용히 무력화했다: `factory:approved`에서
 * 멈춘 이슈를 stalled 팔이 먼저 `factory-merge.yml`을 dispatch하며 `restartComment("merge", n)`을
 * 남기고, 그 머지 런이 실패해 blocked으로 떨어지면(origin=approved) blocked 팔이 "merge를 한 번
 * 다시 밀어볼 차례"인데 — 마커 텍스트가 stalled 팔의 것과 똑같아서 이미 있는 것으로 보여 곧장
 * needs-human으로 에스컬레이션했다. "한 번의 공짜 재시도"가 이 경로에서는 아예 일어나지 않았다.
 * 별도 마커로 완전히 갈라 stalled 팔의 재점화와 blocked 팔의 재점화가 서로의 dedupe를 밟지 않게
 * 한다. "origin 마커보다 최신인가"로 범위를 좁히지 않는다 — 사람이 손으로 다시 blocked을 만들며
 * origin 마커를 새로 남기면, 옛 재점화 마커는 "그 이전 것"이 돼 무한히 다시 밀리는 루프가 된다.
 * "이슈+스테이지당 평생 한 번"이 이 마커의 계약이다 — **단, KTB-22의 API 쿼터/장애 origin은 예외다**
 * (아래 `API_ERROR_MAX_RETRIES`): 그 계약은 "몇 번째 재시도인가"를 마커 자체에 싣도록 넓어졌다.
 *
 * `attempt`(선택, 1부터)를 생략하면 예전과 같은 마커 문자열이 난다 — 그래서 기존 dedupe(이슈+스테이지당
 * 평생 한 번, `origins`가 그 스테이지 자신의 정상 진입 라벨일 때)는 바이트 하나 안 바뀐다. `attempt`를
 * 주면 그 시도 번호가 마커에 실려, 같은 이슈+스테이지에 여러 번 재시도(최대 3회)할 수 있게 된다.
 */
export const blockedRetryComment = (stage, issue, attempt) => `<!-- factory-sweeper blocked-retry stage=${stage} issue=${issue}${attempt ? ` attempt=${attempt}` : ""} -->`;

/**
 * KTB-22 — `factory-blocked-origin` 마커가 실어 온 사유(`blockedOrigin(comments).reason`)가 API
 * 쿼터/장애(`claude -p api error …`)를 말하면, "한 번은 공짜"를 3번으로 넓힌다. 사유가 대개 몇 분~
 * 몇 시간 안에 풀리는 조직 지출/속도 한도라서, sweep 간격(기본 30분)만큼 띄워 세 번 다시 밀어보는
 * 것이 사람을 부르는 것보다 싸다 — 그래도 안 풀리면(3번째마저 실패) 사람에게 넘긴다(무한 재시도는
 * 죽은 크레딧 카드를 향해 계속 돈을 태우는 것과 같다).
 */
export const API_ERROR_MAX_RETRIES = 3;

/**
 * ADR-020 O20 — **사람이 취소한 blocked은 공장의 실패가 아니다.** 취소(`cause=cancelled`)는 사람이
 * (또는 concurrency 규칙이) 잡을 끈 것이고, 그 이슈의 코드·환경에는 아무 문제도 없다. 그래서 두 가지가
 * 다르다: ① R 예산(heartbeat 재큐 카운터, `charter.limits.R`)을 쓰지 않는다 — 그 예산은 "같은 구현이
 * 몇 번이나 죽었는가"를 세는 것이지 사람이 몇 번 취소했는가가 아니다. ② dedupe 범위가 **평생 한 번**이
 * 아니라 **이번 취소 사건 한 번**이다(마지막 origin 마커 이후에 재시도가 있었는가). 그래도 상한은 둔다:
 * 무한히 취소되는 이슈가 무한히 다시 밀리면 그것도 사람이 볼 일이다.
 */
export const CANCELLED_MAX_RETRIES = 3;

/**
 * ADR-020 O20 — 에스컬레이션 문구는 **원인을 말한다**. 예전에는 무엇이 죽였든 "환경/크리덴셜"
 * 하나였다 — 사람이 취소한 잡도, 90분 타임아웃도 그렇게 보고됐고, 그 문장을 믿은 사람은 틀린 곳
 * (자격증명)을 먼저 본다. 사유는 `factory:needs-human` 전이 코멘트에 그대로 실리고 retro의 수확
 * 통계(`extractNeedsHuman`)가 같은 문자열을 센다.
 */
export const BLOCKED_ESCALATION_REASON = {
  "api-error": "blocked (API quota/outage) — needs human",
  timeout: "blocked (job timed out) — needs human",
  cancelled: "blocked (job cancelled) — needs human",
  gates: "blocked (gates undecided) — needs human",
  undecidable: "blocked (undecidable) — needs human",
  other: "blocked (environment/credentials) — needs human",
};
const escalationReason = (cause) => BLOCKED_ESCALATION_REASON[cause] ?? BLOCKED_ESCALATION_REASON.other;
/** 이 이슈+스테이지의 blocked-retry 마커 중 가장 큰 시도 번호(마커가 없으면 0, `attempt` 없는 옛 마커는 1). */
function lastBlockedRetryAttempt(comments, stage, issue) {
  const re = new RegExp(`<!-- factory-sweeper blocked-retry stage=${stage} issue=${issue}(?: attempt=(\\d+))? -->`);
  let last = 0;
  for (const c of comments || []) {
    const m = re.exec(String(c?.body ?? ""));
    if (m) last = Math.max(last, m[1] ? Number(m[1]) : 1);
  }
  return last;
}

/**
 * O20 — **이번 blocked 사건 안에서** 이미 다시 밀어 봤는가(마지막 `factory-blocked-origin` 마커 이후에
 * 이 스테이지의 blocked-retry 마커가 있는가). 취소 origin에만 쓴다: 취소는 같은 이슈에 여러 번
 * 일어날 수 있고 그때마다 새 사건이다. 다른 origin은 이 범위를 쓰지 않는다 — 사람이 손으로 다시
 * blocked을 만들며 origin 마커를 새로 남기면 옛 재점화 마커가 "그 이전 것"이 돼 무한히 다시 밀린다
 * (KTB-19 review I-1이 경고한 그 루프). 취소만 예외인 이유는 그 사건의 출처가 **사람**이기 때문이다.
 */
function retriedSinceOrigin(comments, stage, issue) {
  const list = comments || [];
  let from = 0;
  list.forEach((c, i) => { if (BLOCKED_ORIGIN.test(String(c?.body ?? ""))) from = i + 1; });
  const re = new RegExp(`<!-- factory-sweeper blocked-retry stage=${stage} issue=${issue}(?: attempt=(\\d+))? -->`);
  return list.slice(from).some((c) => re.test(String(c?.body ?? "")));
}

/**
 * KTB-15b I2 — `factory-blocked-origin` 마커의 `from`(그 blocked을 만든 스테이지의 정상 진입
 * 라벨)에서, 다시 밀어볼 스테이지로. `lib/labels.js`의 `BLOCKED_RETRY`와 같은 사실을 반대 방향으로
 * 본 것이다(그 표는 스테이지 → 허용 origin, 이 표는 origin → 다시 밀 스테이지) — `in-progress`도
 * `planned`와 같은 implement로 간다(원인이 뭐든 재시도는 항상 스테이지 자신을 처음부터 다시 돈다).
 */
const BLOCKED_RETRY_STAGE = {
  "factory:queue": "triage",
  "factory:ready": "plan",
  "factory:planned": "implement",
  "factory:in-progress": "implement",
  // ADR-020 KTB-24 fix: review도 한 번은 다시 밀어본다. KTB-24가 세운 `Aborted cleanup`이
  // 잘린 review 잡의 `awaiting-review`를 blocked으로 바꾸는데, 이 표에 없어서 그 이슈는 **항상**
  // 곧장 needs-human으로 갔다 — 그런데 잘린 원인은 판정이 아니라 시간이다. 다른 팔들과 같은 계약이다:
  // 한 번뿐(마커 dedupe), api-error origin만 ≤3회.
  "factory:awaiting-review": "review",
  "factory:approved": "merge",
};

const FLAKY_LABEL = "factory:flaky";
const NOTE = {
  returned: "격리에서 복귀했습니다 — 연속 통과 임계를 넘겨 `quarantine.toml`에서 내렸습니다. 이제 이 테스트의 실패는 다시 게이트를 RED로 만듭니다.",
  expired: "격리 TTL(`quarantine_ttl_days`)을 넘겼습니다. 항목은 `quarantine.toml`에 그대로 남아 있고(게이트 제외도 계속됩니다) — 이 코멘트가 만료 사실의 유일한 기록입니다. retro가 이것을 읽고 \"다른 레벨에서 다시 쓰라\"는 이슈를 만듭니다(§5.2.5-⑤).",
};

/**
 * 격리 상태가 바뀐(복귀·만료) id마다 그 flaky 이슈(제목 `flaky: <id>`)에 마커 코멘트를 남긴다.
 * 두 사건 모두 `quarantine.toml`만 봐서는 알 수 없다: 복귀한 항목은 파일에서 사라지고, 만료는
 * `applyPolicy`가 **플래그로만** 내므로(항목은 남는다) 파일에 아무 흔적이 없다. 이력은 사람이 보는
 * 이슈에 남아야 하고(§5.2.5-⑤), retro는 그 코멘트만으로 만료를 알 수 있다(P4-R3).
 * 전부 best-effort다: 이슈를 못 찾거나 코멘트가 실패해도 이미 끝난 정책 적용을 되돌리지 않고
 * actions에 흔적만 남긴다(sweeper는 절대 한 항목 때문에 통째로 죽지 않는다).
 */
/**
 * 이 id의 이 사건을 **이미 알렸는가**. `applyPolicy`는 만료 항목을 파일에 남기므로(게이트 제외를
 * 계속하려면 남아야 한다) 다음 sweep도 같은 항목을 또 만료로 판정한다 — 그때마다 코멘트를 달면
 * 이슈가 도배되고, retro는 매 창마다 "새 만료"를 읽어 재작성 이슈를 영원히 다시 만든다. 마커 자체가
 * "알렸다"는 기록이므로 그것을 보고 침묵한다.
 *
 * 단, `registered` 마커 **뒤**만 본다: 같은 id가 복귀 후 다시 등록되면(retro가 `registered`를 남긴다)
 * 그건 새 격리 주기이고 그 주기의 복귀·만료는 다시 알려야 한다. 마커 비교는 정규식이 아니라 문자열
 * 포함이다 — id에 `>`·`.`·`(` 같은 글자가 들어 있어도(테스트 이름이 id다) 그대로 맞는다.
 */
function alreadyNotified(comments, kind, id) {
  const list = Array.isArray(comments) ? comments : [];
  const registered = quarantineComment("registered", id);
  const mark = quarantineComment(kind, id);
  let from = 0;
  list.forEach((c, i) => { if (String(c?.body ?? "").includes(registered)) from = i + 1; });
  return list.slice(from).some((c) => String(c?.body ?? "").includes(mark));
}

async function commentOnQuarantineExit({ gh, actions, returned, expired }) {
  const groups = [["returned", returned], ["expired", expired]].filter(([, ids]) => ids.length);
  if (!groups.length) return;
  let issues;
  try {
    // 닫힌 flaky 이슈에도 코멘트를 남긴다(`state: "all"`) — 사람이 이슈를 닫아 둔 뒤 TTL이 지나면
    // 만료 사실이 어디에도 남지 않고, retro는 그 코멘트 없이는 "다른 레벨에서 다시 쓰라"는 후속
    // 이슈를 만들지 못한다. 격리는 이슈가 열려 있는지와 무관하게 계속 존재하는 부채다.
    issues = await gh.issueList({ labels: [FLAKY_LABEL], state: "all" });
  } catch (e) {
    actions.push({ kind: "error", step: "quarantine-comment", error: String(e.message || e) });
    return;
  }
  for (const [kind, ids] of groups) {
    for (const id of ids) {
      try {
        const it = issues.find((i) => String(i.title ?? "").trim() === `flaky: ${id}`);
        if (!it) { actions.push({ kind: "quarantine-comment-skipped", state: kind, id, reason: "no flaky issue" }); continue; }
        // 코멘트를 읽지 못하면 **말하지 않는다** — 이미 알렸는지 모르는 채 다시 말하면 도배가 되고,
        // 침묵은 다음 sweep이 되돌릴 수 있다(만료 항목은 파일에 남아 다시 판정된다).
        if (alreadyNotified(await gh.comments(it.number), kind, id)) {
          actions.push({ kind: "quarantine-comment-skipped", state: kind, id, issue: it.number, reason: "already notified" });
          continue;
        }
        await gh.comment(it.number, `${quarantineComment(kind, id)}\n${NOTE[kind]}`);
        actions.push({ kind: "quarantine-comment", state: kind, id, issue: it.number });
      } catch (e) {
        actions.push({ kind: "error", step: "quarantine-comment", id, error: String(e.message || e) });
      }
    }
  }
}

/**
 * 대기 라벨에 앉아 있는데 **아무 일도 일어나지 않은** 이슈를 찾아 그 스테이지를 dispatch로 다시 띄운다.
 *
 * "멈췄다"의 판정은 세 가지를 모두 만족할 때다:
 *   1. 마지막 **전이 코멘트**(`factory-transition:v1`)가 `staleMinutes`보다 오래됐다 — 라벨이 방금
 *      바뀐 이슈는 스테이지가 아직 뜨는 중이다. 전이 코멘트가 하나도 없으면 판단하지 않는다(사람이
 *      라벨을 API로 직접 붙인 경우 — 나이를 알 수 없는 것을 "오래됐다"로 읽지 않는다).
 *   2. `staleMinutes` 안에 갱신된 **하트비트가 없다** — 있으면 그 스테이지는 지금 돌고 있다(plan은 37분
 *      동안 `factory:ready`에 머문다). 이것이 "in-flight 런 조회"를 대신한다: gh run list보다 싸고,
 *      스테이지가 살아 있다는 1차 증거이며, 이미 이 파일이 읽는 데이터다.
 *   3. 같은 창 안에 **재점화 마커가 없다** — 한 번 민 것을 30분마다 다시 밀지 않는다.
 *
 * 그리고 back-pressure로 **일부러** 세워 둔 이슈는 애초에 멈춘 것이 아니다(M5). `factory:planned`는
 * implement가 흐름 제어에 걸려 라벨을 건드리지 않고 물러났을 때도 그대로 남는다 — 그 상태에서
 * dispatch를 밀면 새 런이 또 같은 이유로 물러나고, "다시 띄웠습니다" 코멘트만 30분마다 쌓인다.
 * 그래서 implement 재점화 직전에 `backPressure()`를 한 번 물어보고, 거부면 dispatch도 코멘트도 하지 않는다.
 *
 * 중복 dispatch를 막는 것은 위 셋뿐이다 — **락 claim은 이 경우를 막지 못한다**. claim이 fail closed로
 * 돌려세우는 것은 *동시에* 도는 두 번째 러너인데, 같은 concurrency 그룹에 PENDING으로 걸린 dispatch는
 * 원래 런이 끝나 **락이 풀린 뒤에** 시작하기 때문이다. 그 런을 실제로 되돌리는 것은 run-stage의
 * 진입 상태 가드(KTB-10, `.factory/bin/run-stage.js`)다: 이슈의 현재 상태 라벨이 그 스테이지의 진입
 * 라벨이 아니면 claude -p를 부르기 전에 exit 0으로 물러난다. 여기의 셋은 그 앞단의 비용·잡음 절감이다.
 * 전부 best-effort다: 한 이슈가 터져도 다음 이슈로 넘어간다.
 */
/**
 * ADR-020 KTB-28 (c) — **밀기 전에 잔해 락을 회수한다.** dispatch는 락을 보지 않는다: 새 런은 뜨고,
 * `claim()`에서 26~40초 만에 죽고, (KTB-28 (b) 이전에는) 아무 기록도 남기지 않았다. 데모 #15가 그렇게
 * 네 번 밀렸다. 주입된 `releaseIfStale`은 "소유자의 워크플로 런이 끝났는가"를 물어 끝났을 때만 지운다
 * (`bin/sweep.js`가 `lockHolder` + `runnerState`로 조립한다) — 살아 있으면 아무것도 하지 않는다.
 *
 * 실패는 재점화를 막지 않는다: 회수는 성공 확률을 올리는 조치이지 전제 조건이 아니고, 락이 정말 남아
 * 있으면 그 런은 (이제 시끄럽게) claim에서 물러난다.
 */
async function releaseStaleLock({ releaseIfStale, issue, actions, step }) {
  if (!releaseIfStale) return;
  try {
    const r = await releaseIfStale(issue);
    if (r?.released) actions.push({ kind: "stale-lock-released", issue, runner: r.runner ?? null, step });
  } catch (e) {
    actions.push({ kind: "error", step: `${step}-lock`, issue, error: String(e.message || e) });
  }
}

async function sweepStalled({ gh, nowMs, staleMinutes, dispatchStage, backPressure, transition, releaseIfStale, actions }) {
  if (!dispatchStage) return;
  const stale = staleMinutes * 60e3;
  // 한 sweep 안에서 흐름 제어는 한 번만 묻는다 — 이슈마다 물으면 `factory:awaiting-review` 검색이 N번 나간다.
  let bpCache;
  const parked = async () => {
    if (!backPressure) return null;
    bpCache ??= Promise.resolve().then(() => backPressure());
    const bp = await bpCache;
    return bp?.ok === false ? bp.reasons.join("; ") : null;
  };
  for (const [label, stage] of Object.entries(STALLED_STAGE)) {
    let issues;
    try { issues = await gh.searchIssues(label); }
    catch (e) { actions.push({ kind: "error", step: "stalled-restart", label, error: String(e.message || e) }); continue; }
    for (const it of issues) {
      try {
        const comments = await gh.comments(it.number);
        const lastTransition = comments.filter((c) => TRANSITION_TO.test(String(c?.body ?? ""))).at(-1);
        if (!lastTransition) continue;
        if (nowMs - Date.parse(lastTransition.createdAt) <= stale) continue;
        const hb = comments.map((c) => HB.exec(String(c?.body ?? ""))).filter(Boolean).at(-1);
        if (hb && nowMs - Date.parse(hb[2]) <= stale) continue;          // 스테이지가 살아 있다
        const marker = restartComment(stage, it.number);
        const restarts = comments.filter((c) => String(c?.body ?? "").includes(marker));
        const restarted = restarts.at(-1);
        if (restarted && nowMs - Date.parse(restarted.createdAt) <= stale) continue;
        // 흐름 제어로 세워 둔 `factory:planned`는 멈춘 것이 아니다(M5) — 조용히 넘어간다.
        if (stage === "implement") {
          const reason = await parked();
          if (reason) { actions.push({ kind: "stalled-restart-skipped", issue: it.number, stage, label, reason: `back-pressure — ${reason}` }); continue; }
        }
        // KTB-28 (d): 두 번 밀어도 같은 자리면 사라진 것은 런이 아니라 가정이다 — 사람에게 넘긴다.
        if (restarts.length >= STALLED_RESTART_LIMIT) {
          const t = await transition?.({ issue: it.number, to: "factory:needs-human", reason: stalledRestartLimitReason });
          actions.push(t && t.ok === false
            ? { kind: "stalled-restart-limit-refused", issue: it.number, stage, label, reason: t.reason ?? "unknown" }
            : { kind: "stalled-restart-limit", issue: it.number, stage, label });
          continue;
        }
        // 마커를 **먼저** 남긴다(M4). dispatch가 성공한 뒤에 코멘트가 실패하면 dedupe의 유일한 근거가
        // 사라져 다음 sweep이 30분마다 같은 스테이지를 또 민다 — 재점화는 비싸고(plan 한 번 ~$12)
        // 놓친 재점화는 사람이 `--remote`로 되살릴 수 있으므로, 실패는 **덜 재시작하는 쪽**으로 기운다.
        await gh.comment(it.number, `${marker}\n\`${label}\`에서 ${staleMinutes}분 넘게 런 없이 멈춰 있었습니다 — \`factory-${stage}.yml\`을 dispatch로 다시 띄웁니다(KTB-8).`);
        // KTB-28 (c): 새 런이 또 고아 락에 부딪히지 않도록, 밀기 직전에 잔해 락을 회수한다.
        await releaseStaleLock({ releaseIfStale, issue: it.number, actions, step: "stalled-restart" });
        // dispatch가 실패하면 "다시 띄웠다"고 적지 않는다 — 마커는 이미 남았으므로 같은 창 안에서는
        // 다시 밀지 않고, 다음 창의 sweep이 재시도한다(실패는 덜 재시작하는 쪽으로 기운다).
        if (!await safeDispatch({ dispatchStage, stage, issue: it.number, actions, step: "stalled-restart" })) continue;
        actions.push({ kind: "stalled-restart", issue: it.number, stage, label });
      } catch (e) {
        actions.push({ kind: "error", step: "stalled-restart", issue: it.number, error: String(e.message || e) });
      }
    }
  }
}

const LABEL_SET_REPAIR_TARGET = "factory:needs-human";
/**
 * 라벨-셋 복구 마커 — 이 조합을 이미 알렸는지의 유일한 근거(dedupe). `to`는 KTB-30에서 붙었다:
 * 복구가 "needs-human으로 접었다"가 아니라 "기록이 말하는 상태로 이었다"일 때 그 목적지를 싣는다
 * (생략하면 예전과 바이트가 같은 마커 — 기존 이슈의 dedupe가 그대로 맞는다).
 */
export const labelSetRepairedComment = (found, to) => `<!-- factory-label-set-repaired from=${found.join(",")}${to ? ` to=${to}` : ""} -->`;

/** 상태 라벨이 **0개**인 이슈의 복구 마커 접두 — dedupe는 목적지가 아니라 "방금 고쳤는가"로 한다. */
const NO_STATE_MARKER_PREFIX = "<!-- factory-label-set-repaired from=(none)";
/**
 * ADR-020 KTB-30 — 같은 이슈를 10분 안에 두 번 고치지 않는다. 이 팔의 dedupe는 다른 팔들과 달리
 * **시간 창**이다: 라벨이 또 사라졌다면 그건 같은 사고가 아니라 새 사고이고(스왑은 매번 새로
 * 일어난다), 평생 한 번으로 묶으면 두 번째 사고에서 다시 보이지 않게 된다.
 */
export const MISSING_STATE_DEDUPE_MS = 10 * 60e3;
/**
 * factory 라벨이 **하나도** 없는 이슈까지 코멘트를 뒤지는 범위. 라벨이 사라진 이슈는 사라진 그
 * 순간에 `updatedAt`이 갱신됐으므로, 최근 갱신분만 봐도 놓치지 않는다(24시간 = 30분 sweep 48번의
 * 여유). 이 경계가 없으면 저장소의 **모든** 열린 이슈에 sweep마다 코멘트 조회가 나간다 —
 * 이 고침이 막으려는 바로 그 API 불안정을 우리가 만드는 셈이다.
 */
export const MISSING_STATE_SCAN_HOURS = 24;
const FACTORY_LABEL_PREFIX = "factory:";

/**
 * L1 "라벨-셋 복구" 팔(KTB-18): 사람이 손으로 라벨을 API로 직접 붙이면(§12.4의 skip-attempt
 * probe가 재현한 것처럼 `factory:approved`를 `backlog` 위에 얹는 식) `run-stage`는 상태가
 * 모호하다는 이유로 조용히 물러난다(전이 없음 — 어느 라벨이 "진짜"인지 판단할 근거가 없다).
 * 그대로 두면 그 이슈는 두 라벨을 영원히 달고 아무도 다시 보지 않는다. 사람의 손 편집을 L1이
 * 고치는 것 — 라벨 카탈로그의 상태 목록(`STATES`, `backlog` 포함)으로 상태 라벨을 2개 이상
 * 가진 열린 이슈를 찾아 정확히 `factory:needs-human` 하나로 맞춘다(다른 상태 라벨은 제거,
 * tier 라벨은 그대로 둔다 — `gh.setFactoryLabel`이 이미 그 계약이다). 코멘트는 마커로 한 번만
 * (dedupe) — 복구 자체는 멱등이지만(다음 sweep에는 이미 단일 라벨이라 재진입하지 않는다), 마커가
 * 있는데도 여전히 다중 라벨이면(예: 복구 사이에 사람이 또 라벨을 얹었다) 또 알리지 않는다.
 * `gh.issueList`가 없는 mock(구형 테스트 더블)은 조용히 건너뛴다 — "안 쓴다"와 "에러났다"를
 * 가른다(다른 dep들과 같은 계약, 예: `dispatchStage`/`backPressure`).
 */
async function sweepLabelSetRepair({ gh, actions }) {
  if (typeof gh.issueList !== "function") return;
  let issues;
  try { issues = await gh.issueList({ state: "open" }); }
  catch (e) { actions.push({ kind: "error", step: "label-set-repair", error: String(e.message || e) }); return; }
  for (const it of issues) {
    try {
      const found = (it.labels || []).filter((l) => STATES.has(l));
      if (found.length <= 1) continue;
      const comments = await gh.comments(it.number);
      /**
       * ADR-020 KTB-30 — 라벨 스왑이 add-first가 된 뒤로 **부분 실패의 모양이 바뀌었다**: 예전에는
       * "상태 라벨 0개"(아무도 못 봄)였고 이제는 "상태 라벨 2개"(이 팔이 봄)다. 그리고 그 둘 중
       * 어느 쪽이 진짜인지도 안다 — 이슈에 남은 **최신 전이의 `to`**가 기록이다. 그럴 때는
       * needs-human으로 접지 않고 그 라벨 하나로 잇는다(공장이 계속 돈다). 기록이 둘 중 어느
       * 것도 가리키지 않으면(사람이 아무 데서나 얹은 라벨 — KTB-18의 프로브) 예전처럼 접는다.
       */
      const last = lastTransition(comments);
      const backed = found.length === 2 && last && found.includes(last.to) ? last.to : null;
      const target = backed ?? LABEL_SET_REPAIR_TARGET;
      const marker = labelSetRepairedComment(found, backed ?? undefined);
      if (comments.some((c) => String(c?.body ?? "").includes(marker))) {
        actions.push({ kind: "label-set-repair-skipped", issue: it.number, reason: "already repaired" });
        continue;
      }
      await gh.setFactoryLabel(it.number, target);
      await gh.comment(it.number, backed
        ? `${marker}\n이 이슈에 factory 상태 라벨이 2개(${found.join(", ")}) 붙어 있었습니다 — 라벨 스왑이 중간에 실패한 흔적입니다(KTB-30). 이슈에 남은 최신 전이가 \`${backed}\`를 말하므로 그 라벨 하나로 정리했습니다(다른 상태 라벨은 제거, tier 라벨은 유지).`
        : `${marker}\n이 이슈에 factory 상태 라벨이 ${found.length}개(${found.join(", ")}) 붙어 있었습니다 — sweeper가 \`${LABEL_SET_REPAIR_TARGET}\`로 정리했습니다(다른 상태 라벨은 제거, tier 라벨은 유지). 사람이 확인한 뒤 \`:unstick\`으로 재개하세요.`);
      actions.push({ kind: "label-set-repaired", issue: it.number, from: found, ...(backed ? { to: backed } : {}) });
    } catch (e) {
      actions.push({ kind: "error", step: "label-set-repair", issue: it.number, error: String(e.message || e) });
    }
  }
}

/**
 * ADR-020 KTB-30 — **상태 라벨이 하나도 없는 이슈를 되살린다.** 데모에서 4분 사이에 두 번 났다
 * (#2 08:52Z implement claim, #15 08:55Z review handoff — 27분짜리 리뷰가 그렇게 사라졌다):
 * `gh issue edit --remove-label … --add-label …` 한 번이 GitHub 장애로 중간에 끊겨 옛 라벨만
 * 지워졌다. 그 상태는 이 공장에서 **유일하게 아무도 보지 못하는** 상태다 — `labeled` 이벤트가
 * 없으니 잡이 안 뜨고, sweeper의 다른 모든 팔은 상태 라벨로 검색하며, `factory status`도 상태
 * 라벨로 조회한다. 스왑 순서를 add-first로 뒤집어 이 모양이 나올 확률은 크게 줄었지만(이제 최악은
 * 라벨 2개다), 확률이 0이 아닌 한 그것을 보는 눈이 하나는 있어야 한다.
 *
 * 되살릴 자리는 **최신 전이 코멘트의 `to`**다(그 이슈가 마지막으로 도달한 상태 — 기계가 남긴 기록).
 * 전이 이력이 없으면 어디로 보낼지 알 수 없으므로 `factory:needs-human`이다(짐작해서 파이프라인
 * 중간에 떨어뜨리지 않는다). 전이가 아니라 `setFactoryLabel`을 직접 쓴다 — `transition()`은 출발
 * 라벨을 요구하는데 그 출발 라벨이 바로 사라진 것이다.
 */
async function sweepMissingStateLabel({ gh, nowMs, actions }) {
  if (typeof gh.issueList !== "function") return;
  let issues;
  try { issues = await gh.issueList({ state: "open" }); }
  catch (e) { actions.push({ kind: "error", step: "missing-state-label", error: String(e.message || e) }); return; }
  for (const it of issues) {
    try {
      const labels = it.labels || [];
      if (labels.some((l) => STATES.has(l))) continue;
      const hasFactoryLabel = labels.some((l) => String(l).startsWith(FACTORY_LABEL_PREFIX));
      const updatedMs = Date.parse(it.updatedAt ?? "");
      // factory 라벨이 하나도 없으면 후보는 "전이 코멘트가 있는 이슈"뿐인데, 그건 코멘트를 읽어야
      // 알 수 있다 — 그래서 최근 갱신분으로만 좁힌다(위 MISSING_STATE_SCAN_HOURS).
      if (!hasFactoryLabel && !(Number.isFinite(updatedMs) && nowMs - updatedMs <= MISSING_STATE_SCAN_HOURS * 3600e3)) continue;
      const comments = await gh.comments(it.number);
      const last = lastTransition(comments);
      if (!hasFactoryLabel && !last) continue;                  // factory가 손댄 적 없는 평범한 이슈
      const to = last && STATES.has(last.to) ? last.to : LABEL_SET_REPAIR_TARGET;
      const prior = comments.filter((c) => String(c?.body ?? "").includes(NO_STATE_MARKER_PREFIX)).at(-1);
      if (prior && nowMs - Date.parse(prior.createdAt) <= MISSING_STATE_DEDUPE_MS) {
        actions.push({ kind: "state-label-restore-skipped", issue: it.number, reason: "repaired within 10m" });
        continue;
      }
      await gh.setFactoryLabel(it.number, to);
      await gh.comment(it.number, `${labelSetRepairedComment(["(none)"], to)}\n이 이슈에 factory 상태 라벨이 **하나도** 없었습니다(라벨 스왑이 중간에 실패한 흔적 — ADR-020 KTB-30). ${last ? `최신 전이가 \`${to}\`를 말하므로 그 라벨을 다시 붙였습니다.` : `되살릴 전이 기록이 없어 \`${to}\`로 올렸습니다 — 사람이 어느 상태였는지 판단해 \`:unstick\`으로 재개하세요.`}`);
      actions.push({ kind: "state-label-restored", issue: it.number, to });
    } catch (e) {
      actions.push({ kind: "error", step: "missing-state-label", issue: it.number, error: String(e.message || e) });
    }
  }
}

/**
 * ADR-020 KTB-23 fix — **하네스 대기 주차의 해제**. 이 팔이 없으면 주차된 피처는 영원히 돌아오지 않는다.
 *
 * KTB-23은 해제를 merge 스테이지 단계 (9)에만 두었다: 하네스 PR을 머지한 뒤 본문의 `Blocks: #<n>`을
 * 읽어 피처를 `needs-info → queue`로 되돌린다. 그런데 **하네스 PR은 구성상 보호 경로를 건드린다**
 * (그것이 그 이슈의 존재 이유다) — 그래서 merge 스테이지는 단계 (3)에서 자동 머지를 거부하고
 * `needs-human`으로 넘기고, 실제 머지는 **사람이 GitHub에서** 한다. 단계 (9)는 그 경로에서 아예
 * 실행되지 않는다. 즉 KTB-23의 설계대로 도는 모든 하네스 이슈에서 해제가 일어나지 않았다.
 *
 * 그래서 해제의 1차 경로는 sweeper다: 열린 `factory:needs-info` 이슈 중 **마지막 전이의 사유**가
 * `waiting for harness issue #<m>`인 것을 찾아, 그 하네스 이슈가 닫혔으면(또는 그 브랜치의 PR이
 * 머지됐으면) 큐로 되돌린다. 단계 (9)는 빠른 경로로 그대로 남는다(팩토리가 스스로 머지할 수 있는
 * 드문 하네스 PR — 예: 보호 경로에 걸리지 않는 변경만 남은 재시도).
 *
 * "마지막 전이의 사유"로 판정하는 이유: `factory:needs-info`는 두 가지 뜻을 겸한다 — triage의
 * "이슈가 모호하다"(사람이 보강해야 한다)와 하네스 대기. 전자를 큐로 되돌리면 같은 모호함으로
 * 다시 triage를 돌린다. 마지막 전이의 사유가 그 둘을 가르는 유일한 기록이다.
 *
 * 마커 dedupe는 다른 팔들과 같은 계약이지만(`harnessUnparkedComment`), **전이가 성공한 뒤에** 남긴다
 * (r1 재리뷰 M3). 다른 팔들은 마커를 먼저 남긴다 — 거기서 마커는 "비싼 재점화를 이 창 안에 한 번만"의
 * 근거이고, 놓친 재점화는 다음 창이 되돌린다. 여기는 반대다: 마커가 억제하는 것은 재시도 자체이고,
 * 이 팔이 실패하면 주차된 피처는 **영원히** 돌아오지 않는다(해제 경로가 이것 하나뿐이다 — merge 단계
 * (9)는 하네스 PR을 사람이 머지하므로 정상 경로에서 돌지 않는다). 그래서 실패에 기우는 방향이 다르다:
 * 전이가 거부되면 아무 흔적도 남기지 않고(액션 한 줄만), 다음 sweep이 그대로 다시 시도한다.
 */
export const PARKED_ON_HARNESS = /waiting for harness issue #(\d+)/;
export const harnessUnparkedComment = (harness, issue) => `<!-- factory-sweeper harness-unparked harness=${harness} issue=${issue} -->`;

async function sweepHarnessUnpark({ gh, transition, harnessSettled, actions }) {
  if (!harnessSettled) return;                       // 구형 배선(테스트 더블 포함)은 조용히 건너뛴다
  let issues;
  try { issues = await gh.searchIssues("factory:needs-info"); }
  catch (e) { actions.push({ kind: "error", step: "harness-unpark", error: String(e.message || e) }); return; }
  for (const it of issues) {
    try {
      const comments = await gh.comments(it.number);
      const last = lastTransition(comments);
      const m = last && last.to === "factory:needs-info" ? PARKED_ON_HARNESS.exec(last.reason || "") : null;
      if (!m) continue;                              // 하네스 주차가 아닌 needs-info는 사람의 몫이다
      const harness = Number(m[1]);
      const marker = harnessUnparkedComment(harness, it.number);
      if (comments.some((c) => String(c?.body ?? "").includes(marker))) {
        actions.push({ kind: "harness-unpark-skipped", issue: it.number, harness, reason: "already unparked" });
        continue;
      }
      const settled = await harnessSettled(harness);
      if (!settled?.done) {
        actions.push({ kind: "harness-unpark-skipped", issue: it.number, harness, reason: settled?.why || "harness issue not settled" });
        continue;
      }
      const t = await transition({ issue: it.number, to: "factory:queue", reason: `harness issue #${harness} closed` });
      if (!t?.ok) { actions.push({ kind: "harness-unpark-refused", issue: it.number, harness, reason: t?.reason ?? "unknown" }); continue; }
      await gh.comment(it.number, `${marker}\n하네스 이슈 #${harness}: ${settled.why} — \`factory:needs-info\`에서 \`factory:queue\`로 되돌렸습니다(ADR-020 KTB-23). 하네스 PR은 사람이 머지하므로 이 해제는 sweeper가 합니다.`);
      actions.push({ kind: "harness-unparked", issue: it.number, harness });
    } catch (e) {
      actions.push({ kind: "error", step: "harness-unpark", issue: it.number, error: String(e.message || e) });
    }
  }
}

/**
 * ADR-020 KTB-26 — dispatch는 **경쟁하는 sweep들 사이에서 실패할 수 있다**: 이제 30분 cron만이
 * 아니라 스테이지 잡이 끝날 때마다 sweep이 돌기 때문에, 두 sweep이 같은 이슈를 같은 초에 볼 수 있다.
 * 마커 dedupe는 그 대부분을 막지만 조회-후-기록 사이의 틈은 남고, `gh workflow run` 자체도 레이트
 * 리밋·중복으로 실패할 수 있다. 그래서 dispatch 실패는 그 이슈의 처리를 통째로 error로 접지 않고
 * 자기 줄만 남긴다 — 재점화는 다음 sweep이 다시 시도하면 되는 일이다(마커는 이미 남았으므로 그
 * 재시도는 같은 창 안에서는 조용하다).
 */
async function safeDispatch({ dispatchStage, stage, issue, actions, step }) {
  try { await dispatchStage({ stage, issue }); return true; }
  catch (e) { actions.push({ kind: "error", step, issue, error: String(e.message || e) }); return false; }
}

/**
 * `quick`(KTB-26): 스테이지 워크플로의 마지막 스텝이 쓰는 모양(`sweep.js --quick`). 시간에 묶인 두 팔
 * (격리 정책 적용과 토큰 만료 이슈 생성)을 건너뛰고 **상태 복구 팔만** 돌린다 — in-progress 하트비트
 * 재큐 · blocked 처리 · 멈춘 스테이지 재점화 · 하네스 주차 해제 · 라벨-셋 복구. 그 둘을 뺀 이유는 비용이 아니라 의미다:
 * 격리 TTL은 "몇 시간이 지났는가"의 판정이라 스테이지가 끝난 그 순간에 다시 물어볼 이유가 없고,
 * `quarantine.toml`을 스테이지마다 쓰면 커밋 경쟁만 늘어난다. cron sweep은 그대로 네 팔을 다 돈다.
 */
export async function sweep({ gh, charter, thresholds, now, staleMinutes = 30, transition, release, quarantine, saveQuarantine, tokenIssuedAt = null, dispatchStage = null, backPressure = null, harnessSettled = null, releaseIfStale = null, quick = false }) {
  const actions = [];
  const nowMs = Date.parse(now);
  if (quick) actions.push({ kind: "quick-sweep", skipped: ["quarantine", "token-expiry"] });
  for (const it of await gh.searchIssues("factory:in-progress")) {
    try {
      const comments = await gh.comments(it.number);
      const hb = comments.map((c) => HB.exec(c.body)).filter(Boolean).at(-1);
      const last = hb ? Date.parse(hb[2]) : null;
      if (last && nowMs - last <= staleMinutes * 60e3) continue;
      await release(it.number);
      const prev = comments.map((c) => RETRY.exec(c.body)).filter(Boolean).at(-1);
      const count = (prev ? Number(prev[2]) : 0) + 1;
      await gh.comment(it.number, `<!-- factory-retry issue=${it.number} count=${count} -->\nheartbeat stale (${hb ? hb[2] : "none"}) — lock released, retry ${count}/${charter.limits.R}`);
      if (count <= charter.limits.R) { await transition({ issue: it.number, to: "factory:planned", reason: `sweeper requeue ${count}/${charter.limits.R}` }); actions.push({ kind: "requeue", issue: it.number, count }); }
      else { await transition({ issue: it.number, to: "factory:needs-human", reason: `retries exhausted (${count - 1}/${charter.limits.R})` }); actions.push({ kind: "retries-exhausted", issue: it.number }); }
    } catch (e) {
      actions.push({ kind: "error", issue: it.number, error: String(e.message || e) });
    }
  }
  // blocked 팔은 기본적으로 **에스컬레이션만** 한다 — 유예 시간(이 잡의 실행 주기)이 지나면
  // needs-human이다. blocked는 대개 "판정에 필요한 재료를 못 구했다"(게이트 계산 불가, 자격증명)이고,
  // 그 원인은 공장 밖에 있어 같은 런을 다시 돌려도 같은 자리에서 죽는다 — 되살리는 것은 사람의 판단이다.
  //
  // 예외(KTB-15b): 이 blocked이 **그 스테이지 자신의 정상 진입 라벨에서** 왔으면(마커, 아래
  // `BLOCKED_RETRY_STAGE`) — 즉 판정 불가가 그 스테이지의 마지막 한 걸음에서만 났으면 — 원인이
  // 대개 일시적이라(GitHub API 순간 실패, 재계산 지연) 사람 없이 **한 번은** 다시 돌아볼 값어치가
  // 있다. `run-stage`의 진입 가드(§labels.js `BLOCKED_RETRY`)가 실제 재시도 여부를 다시 한번
  // 결정적으로 가른다 — 여기서는 그저 그 스테이지를 한 번 dispatch할 뿐이다. 재점화 마커는
  // **자신만의** 마커(`blockedRetryComment`)로 남긴다(KTB-19 review I-1) — stalled 팔의
  // `restartComment`를 재사용하면, "stalled가 먼저 밀었다가 그 런이 blocked으로 떨어진" 정상 경로에서
  // blocked 팔이 stalled의 마커를 보고 "이미 밀었다"로 착각해 공짜 재시도를 건너뛰고 곧장
  // 에스컬레이션한다: 마커가 이미 있으면(=이 blocked 팔이 이미 한 번 밀었는데 여전히 blocked) 더
  // 밀지 않고 곧장 에스컬레이션한다.
  for (const it of await gh.searchIssues("factory:blocked")) {
    try {
      // 원인 등급은 dispatch 배선과 무관하게 필요하다 — 재시도를 안 하는 경로에서도 **에스컬레이션
      // 문구**가 이 등급으로 갈린다(O20).
      const comments = await gh.comments(it.number);
      const origin = blockedOrigin(comments);
      const cause = origin?.cause ?? null;
      if (dispatchStage) {
        const retryStage = origin && BLOCKED_RETRY_STAGE[origin.from];
        if (retryStage) {
          // KTB-22: API 쿼터/장애로 온 blocked만 3번까지. O20: 사람이 취소한 것도 예외지만 방식이
          // 다르다 — 평생 횟수가 아니라 **취소 사건마다** 한 번이다(그래서 R 예산을 쓰지 않는다).
          const isApiError = cause === "api-error";
          const isCancelled = cause === "cancelled";
          const maxAttempts = isApiError ? API_ERROR_MAX_RETRIES : isCancelled ? CANCELLED_MAX_RETRIES : 1;
          const lastAttempt = lastBlockedRetryAttempt(comments, retryStage, it.number);
          const episodeOpen = !isCancelled || !retriedSinceOrigin(comments, retryStage, it.number);
          if (lastAttempt < maxAttempts && episodeOpen) {
            const attempt = lastAttempt + 1;
            // 첫 시도이고 API 에러가 아니면 예전과 바이트가 같은 마커를 쓴다(`attempt` 생략) — 기존
            // dedupe·테스트는 이 경로에서 아무것도 안 바뀐 것처럼 본다. API 에러거나 2번째 이상이면
            // 시도 번호를 싣는다.
            const numbered = isApiError || attempt > 1;
            const marker = numbered ? blockedRetryComment(retryStage, it.number, attempt) : blockedRetryComment(retryStage, it.number);
            const note = isApiError
              ? `\`factory:blocked\`이 API 쿼터/장애(\`${origin.reason}\`)로 \`${origin.from}\`에서 왔습니다 — \`factory-${retryStage}.yml\`을 다시 띄웁니다(시도 ${attempt}/${maxAttempts}, KTB-22). 여전히 blocked이면 ${attempt < maxAttempts ? "다음 sweep에서 다시 시도합니다" : "다음 sweep에서 사람에게 넘어갑니다"}.`
              : isCancelled
                ? `\`factory:blocked\`이 **잡 취소**(\`${origin.reason}\`)로 \`${origin.from}\`에서 왔습니다 — 취소는 이 이슈의 실패가 아니므로 재시도 예산(R)을 쓰지 않고 \`factory-${retryStage}.yml\`을 한 번 다시 띄웁니다(O20). 이 취소 건에 대해서는 이번 한 번뿐입니다.`
                : `\`factory:blocked\`이 \`${origin.from}\`에서 왔습니다 — 그 마지막 한 걸음만 실패했을 수 있어 \`factory-${retryStage}.yml\`을 한 번 다시 띄웁니다(KTB-15b). 여전히 blocked이면 다음 sweep에서 사람에게 넘어갑니다.`;
            // 마커를 먼저 남긴다(stalled 팔과 같은 이유 — M4). dispatch 실패는 다음 sweep이 다시 시도한다.
            await gh.comment(it.number, `${marker}\n${note}`);
            // KTB-28 (c): stalled 팔과 같은 이유 — 잔해 락이 남아 있으면 이 재시도도 claim에서 죽는다.
            await releaseStaleLock({ releaseIfStale, issue: it.number, actions, step: "blocked-retry" });
            if (await safeDispatch({ dispatchStage, stage: retryStage, issue: it.number, actions, step: "blocked-retry" })) {
              actions.push({ kind: "blocked-retry", issue: it.number, stage: retryStage, cause, ...(numbered ? { attempt } : {}) });
            }
            continue;
          }
        }
      }
      await transition({ issue: it.number, to: "factory:needs-human", reason: escalationReason(cause) });
      actions.push({ kind: "blocked-escalated", issue: it.number, cause });
    } catch (e) {
      actions.push({ kind: "error", issue: it.number, error: String(e.message || e) });
    }
  }
  await sweepStalled({ gh, nowMs, staleMinutes, dispatchStage, backPressure, transition, releaseIfStale, actions });
  await sweepHarnessUnpark({ gh, transition, harnessSettled, actions });
  await sweepLabelSetRepair({ gh, actions });
  await sweepMissingStateLabel({ gh, nowMs, actions });
  if (quick) return actions;                     // KTB-26 — 아래 두 팔은 시간에 묶여 있다(cron의 몫)
  try {
    const pol = applyPolicy(quarantine, { now, thresholds });
    if (pol.returned.length || pol.expired.length) {
      saveQuarantine(pol.q);
      actions.push({ kind: "quarantine", returned: pol.returned, expired: pol.expired });
      await commentOnQuarantineExit({ gh, actions, returned: pol.returned, expired: pol.expired });
    }
  } catch (e) {
    actions.push({ kind: "error", step: "quarantine", error: String(e.message || e) });
  }
  try {
    if (tokenIssuedAt && nowMs - Date.parse(tokenIssuedAt) > 334 * 86400e3) {
      const open = await gh.searchIssues("factory:needs-human");
      if (!open.some((i) => /토큰 갱신/.test(i.title || ""))) { const n = await gh.createIssue({ title: "factory: 토큰 갱신 필요 (11개월 경과)", body: "`claude setup-token` 재실행 후 시크릿 CLAUDE_CODE_OAUTH_TOKEN을 교체하고 FACTORY_TOKEN_ISSUED_AT을 갱신하세요.", labels: ["factory:needs-human"] }); actions.push({ kind: "token-expiry", issue: n }); }
    }
  } catch (e) {
    actions.push({ kind: "error", step: "token-expiry", error: String(e.message || e) });
  }
  return actions;
}
