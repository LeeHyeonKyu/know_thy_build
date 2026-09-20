import { applyPolicy } from "./quarantine.js";
import { quarantineComment } from "./retro/quarantine-ops.js";
import { BLOCKED_ORIGIN, TRANSITION_TO, blockedOrigin, commentsSinceRequeue, lastTransition, transitionRefusedMarker } from "./retro/issue-comments.js";
import { STATES } from "./labels.js";
import { HUMAN_MERGE_REQUIRED, verifyFactoryStatuses } from "./merge-stage.js";
import { allChecksGreen, GH_NO_CHECKS_RE } from "./gh.js";
import { latestHandoff } from "./handoff.js";
import { findOpenHarnessIssueFor } from "./harness-request.js";
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
  /**
   * ADR-020 최종 리뷰 MF-1 — `factory:queue`가 이 표에서 빠져 있었다. KTB-31이 `factory:rework`에서
   * 고친 결함과 **글자 하나 다르지 않은** 결함이 라벨 하나에 더 남아 있었던 것이다: 아무 팔도 보지
   * 않는 대기 상태.
   *
   * 여기가 특히 아픈 이유는 `sweepHarnessUnpark`(아래)의 목적지가 바로 이 라벨이기 때문이다.
   * 주차 해제는 `needs-info → queue` 전이를 만들고 **평생 dedupe** 마커를 남긴다 — 그 라벨 이벤트가
   * 만든 다섯 런 중 하나(`factory-triage`)가 사라지면(도그푸딩에서 두 번 관측됐다: 데모 #2의 동시성
   * 물결, #15의 Actions 장애 중 좀비 `queued`), 그 피처는 **영원히** `factory:queue`에 앉는다.
   * 마커가 있으니 주차 해제 팔은 다시 시도하지 않고, 다른 어떤 팔도 이 라벨을 보지 않았다.
   * KTB-23(하네스 주차)의 존재 이유 전체가 그 한 칸에서 끝났다. `needs-human → queue`(`:unstick`)와
   * blocked 팔의 `blocked → queue` 재시도도 같은 막다른 길이었다.
   *
   * 이 팔이 그것을 받는다 — 다른 라벨들과 똑같이 `STALL_NO_HEARTBEAT_MIN`(10분) 임계로. triage는
   * 하트비트를 찍기 전에 끝나는 일이 없으므로(스테이지가 시작하면 하트비트가 선다) "하트비트가
   * 하나도 없다 = 런이 뜨지 않았다"의 판정이 여기서도 그대로 맞는다.
   */
  "factory:queue": "triage",
  "factory:ready": "plan",
  "factory:planned": "implement",
  // ADR-020 KTB-31 — `factory:rework`이 이 표에 없어서 **아무 팔도 보지 않는 대기 상태**가 하나 남아
  // 있었다. 스펙 §3.2의 `rework --> in_progress`는 implement가 다시 들어와야 일어나는데, 그 재진입이
  // 일어나지 않으면(2026-09-13 08:58Z #15: `factory:rework` 라벨 이벤트가 만든 런 34748735031이
  // Actions 장애 직후 **잡 없이 queued인 좀비**로 굳었다) 이슈는 그냥 앉아 있는다. 하트비트도 없고
  // (스테이지가 시작조차 못 했다) blocked 라벨도 없어 1·2번 팔에도 안 걸린다 — 손으로
  // `workflow_dispatch`를 칠 때까지 65분이 그렇게 갔다.
  "factory:rework": "implement",
  "factory:awaiting-review": "review",
  "factory:approved": "merge",
};

/**
 * ADR-020 KTB-31 — **스테이지가 시작조차 못 했으면 30분을 기다리지 않는다.** 기본 임계(30분)는
 * "도는 스테이지가 하트비트를 놓쳤다"의 여유다: plan은 37분, implement는 그 이상을 한 라벨 위에서
 * 보내고 그동안 10분마다 하트비트를 찍는다. 그런데 하트비트가 **하나도 없으면** 기다리는 대상이
 * 다르다 — 런이 아예 뜨지 않았거나(#2: concurrency 물결, #15: 좀비 queued) 뜨자마자 죽은 것이고,
 * 그 사실은 10분이면 확정된다(워크플로 큐 + checkout + claim + 첫 하트비트까지 실측 1~3분).
 * 20분을 더 기다려 봐야 같은 답을 더 늦게 얻을 뿐이다.
 */
export const STALL_NO_HEARTBEAT_MIN = 10;
/** 재점화 마커 — 이것 자체가 "이미 밀어 봤다"는 기록이다(dedupe의 유일한 근거). */
export const restartComment = (stage, issue) => `<!-- factory-sweeper restarted stage=${stage} issue=${issue} -->`;

/**
 * ADR-020 KTB-28 (d) — **같은 이슈+스테이지를 몇 번까지 다시 미는가.** 데모 #15는 네 번 밀렸고 네 번
 * 모두 같은 벽(`claim()`의 고아 락)에 부딪혔다. 재점화는 "런이 만들어지지 않은 사고"를 되돌리려는
 * 것인데, 두 번 밀어도 같은 자리에 멈춰 있으면 사라진 것은 런이 아니라 **가정**이다 — 그때부터는
 * 사람이 봐야 한다(밀 때마다 plan 한 번 ~$12가 나갈 수 있다).
 *
 * 세는 것은 재점화 마커 개수다(마커가 곧 기록이다 — 별도 카운터를 두면 둘이 갈라진다). r1 SF3: 범위는
 * **마지막 재큐 이후**다(`commentsSinceRequeue`) — 이 저장소의 모든 라운드 카운터와 같은 창이다.
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
  // KTB-35: 재시도 한 번으로도 같은 자리에서 죽었다 — 그러면 EPIPE 같은 일시적 인프라가 아니라
  // 이 저장소의 테스트 명령이 테스트 **밖에서** 죽고 있다는 뜻이다(게이트 로그의 stderr 꼬리가
  // 그 자리를 가리킨다). 문장이 그렇게 말해야 사람이 제품 코드가 아니라 그곳부터 본다.
  "gates-unhandled": "blocked (test command exited non-zero with 0 failing tests — unhandled error outside tests, see the gate log) — needs human",
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
  // 최종 리뷰 nit 1 — `factory:planned`는 여기(그리고 `labels.js`의 `BLOCKED_RETRY.implement.origins`)
  // 에 **도달할 수 없는 항목**이었다: 그래프에 `planned → blocked` 엣지가 없고(`labels.js` TRANSITIONS),
  // `abortStage`는 라벨이 그 스테이지의 in-flight 라벨(`implement`면 `in-progress`)일 때만 전이한다.
  // 그러므로 `from=factory:planned`인 blocked-origin 마커는 생길 수 없다. 죽은 항목을 두면 다음 독자가
  // "planned에서도 blocked이 될 수 있구나"로 읽는다 — 표는 실제 가능한 것만 적어야 표다.
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
 * 조회 **실패**는 재점화를 막지 않는다: 아무것도 모르는 것이지 "살아 있다"가 아니고, 락이 정말 남아
 * 있으면 그 런은 (이제 시끄럽게) claim에서 물러난다.
 *
 * r1 SF4 — 그러나 **살아 있다고 들었으면** 막는다(`state: "live"`). 그 dispatch는 결과가 정해져 있다:
 * KTB-28 (b) 이후 락을 못 잡은 런은 잡을 빨갛게 끝내고 `factory-claim-refused` 코멘트를 남긴다. 게다가
 * 재점화 마커는 이미 남은 뒤라 그 실패가 **재점화 예산(2회)을 태운다** — 길게 도는 스테이지 하나가
 * 하트비트만 늦어도 예산을 다 쓰고 사람에게 올라갔다. 락이 살아 있다는 것은 그 스테이지가 돌고
 * 있다는 뜻이므로, 멈춘 것이 아니다: 아무것도 하지 않고 다음 sweep에 다시 본다.
 *
 * r2 MF1 — **"모른다"는 "살아 있다"가 아니다.** r1은 둘을 한 불리언으로 합쳤고, 그래서 로컬 러너가
 * 남긴 락(`runner=local/<host>` — §4.2.5의 지원되는 진입 경로다)이나 Actions 조회 실패 하나가 두
 * dispatch 팔을 **영원히, 조용히** 세웠다(리뷰 finding 1: 30분마다 stdout 한 줄, 이슈에는 아무것도,
 * 에스컬레이션도 없음). 이제 `state`는 셋이다 — `live`(물러난다) · `none`/`stale`(민다) ·
 * `unknown`(밀지 않되 **사람을 부른다**, 아래 `escalateUnknownLock`). 배선이 아예 없으면(`releaseIfStale`
 * 미주입 — 구형 호출자·테스트 더블) 예전처럼 아무 의견도 내지 않는다(`stale`).
 */
async function releaseStaleLock({ releaseIfStale, issue, actions, step }) {
  if (!releaseIfStale) return { state: "stale", released: false };
  try {
    const r = await releaseIfStale(issue);
    if (r?.released) actions.push({ kind: "stale-lock-released", issue, runner: r.runner ?? null, step });
    // MF1: 리스가 깨졌다 = 읽은 뒤에 락 주인이 바뀌었다. 지우지 않은 것이 옳고, 그 사실은 기록에 남는다.
    if (r?.race) actions.push({ kind: "stale-lock-race", issue, runner: r.runner ?? null, step });
    // `state`가 없는 옛 더블은 `live` 불리언으로 떨어진다(그때는 unknown이라는 값이 없었다).
    return { state: r?.state ?? (r?.live === true ? "live" : "stale"), released: r?.released === true, why: r?.why ?? null };
  } catch (e) {
    // 조회 자체가 터졌다 = 이 락에 대해 아무것도 모른다. r1까지는 여기서 그냥 밀었다 — 살아 있는 락
    // 위로 미는 것이고, 그 사고는 `claim()`이 막지만(KTB-28 b) 재점화 예산은 태운다.
    actions.push({ kind: "error", step: `${step}-lock`, issue, error: String(e.message || e) });
    return { state: "unknown", released: false, why: `lock lookup failed — ${String(e.message || e)}` };
  }
}

/**
 * ADR-020 r2 MF1 — **소유자를 알 수 없는 락 위에서 스톨 임계를 넘긴 이슈는 사람에게 간다.**
 *
 * 이 자리에 오는 경우는 셋이다: 락 제목의 `runner=`가 워크플로 런이 아니거나(사람이 로컬에서
 * `factory run`을 돌리다 랩톱이 잠들었다 — §4.2.5), Actions 조회가 죽었거나(토큰 스코프·API 장애),
 * 락 조회 자체가 실패했다. 어느 쪽도 sweeper가 혼자 풀 수 없다: 지우면 살아 있는 락을 지울 수 있고,
 * 밀면 claim에서 거부당하며, 침묵하면 **그 이슈는 영영 움직이지 않는다**(리뷰 finding 1의 시나리오).
 * 그래서 셋째 길이다 — 코멘트 한 줄과 `factory:needs-human`. 이 팔이 없으면 에스컬레이션의 유일한
 * 흔적이 sweep 잡의 stdout이 되는데, 그건 아무도 읽지 않는다.
 *
 * dedupe는 시간 창(`stale`)이다: 전이가 거부되면(그래프상 막힌 자리) 다음 창의 sweep이 다시 시도한다 —
 * 마커 하나로 평생 묶으면 "한 번 말했으니 됐다"가 되고 그것이 바로 이 고침이 없애려는 침묵이다.
 */
export const lockOwnerUnknownComment = (issue) => `<!-- factory-sweeper lock-owner-unknown issue=${issue} -->`;
const lockOwnerUnknownReason = (why) => `lock owner unknowable (${why})`;

async function escalateUnknownLock({ gh, transition, issue, comments, nowMs, stale, actions, step, why, extra = {} }) {
  const detail = why || "lock owner unreadable";
  const marker = lockOwnerUnknownComment(issue);
  const prior = (comments || []).filter((c) => String(c?.body ?? "").includes(marker)).at(-1);
  if (prior && nowMs - Date.parse(prior.createdAt) <= stale) {
    actions.push({ kind: `${step}-skipped`, issue, ...extra, reason: `lock owner unknown — ${detail}` });
    return;
  }
  const reason = lockOwnerUnknownReason(detail);
  await gh.comment(issue, `${marker}\n이 이슈의 락(\`refs/heads/factory/lock-${issue}\`) 소유자를 확인할 수 없습니다 — ${detail}. 락이 살아 있을 수 있어 다시 띄우지 않고(살아 있는 스테이지를 두 번 돌리는 것이 더 비쌉니다), 스톨 임계를 넘겼으므로 \`factory:needs-human\`으로 올립니다. 소유자가 이미 끝난 것이 확실하면 그 ref를 지운 뒤 \`:unstick\`으로 재개하세요(ADR-020 MF1 r2).`);
  const t = await transition?.({ issue, to: "factory:needs-human", reason });
  actions.push(t && t.ok === false
    ? { kind: "lock-owner-unknown-refused", issue, step, ...extra, reason: t.reason ?? "unknown" }
    : { kind: "lock-owner-unknown-escalated", issue, step, ...extra, reason });
}

async function sweepStalled({ gh, nowMs, staleMinutes, dispatchStage, backPressure, transition, releaseIfStale, actions }) {
  if (!dispatchStage) return;
  const stale = staleMinutes * 60e3;
  // KTB-31: 하트비트가 **하나도** 없으면(스테이지가 시작조차 못 했다) 임계는 10분이다. 둘 중 짧은
  // 쪽을 쓴다 — 호출자가 staleMinutes를 10분보다 짧게 주면 그 뜻이 이긴다.
  const noHeartbeatStale = Math.min(stale, STALL_NO_HEARTBEAT_MIN * 60e3);
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
        let lastIdx = -1;
        comments.forEach((c, i) => { if (TRANSITION_TO.test(String(c?.body ?? ""))) lastIdx = i; });
        if (lastIdx === -1) continue;
        const lastTransition = comments[lastIdx];
        // KTB-31: **이번 스테이지의** 하트비트만 센다 — 마지막 전이 뒤에 찍힌 것들이다. 지난 스테이지의
        // 하트비트가 남아 있다고 해서 "이번 스테이지는 시작했다"가 되지는 않는다.
        const hb = comments.slice(lastIdx + 1).map((c) => HB.exec(String(c?.body ?? ""))).filter(Boolean).at(-1);
        if (hb && nowMs - Date.parse(hb[2]) <= stale) continue;          // 스테이지가 살아 있다
        if (nowMs - Date.parse(lastTransition.createdAt) <= (hb ? stale : noHeartbeatStale)) continue;
        const marker = restartComment(stage, it.number);
        // r1 SF3 — 재점화 예산도 **마지막 재큐 이후**로 센다. 이 저장소의 다른 모든 라운드 카운터가
        // 그렇다(KTB-25: 재큐는 새 주기의 시작이고, 그 앞의 시도는 다른 코드에 대한 것이다). 이것만
        // 이력 전체를 보고 있었다 — 예전 주기에서 두 번 다시 밀렸던 이슈는 고쳐져 재큐된 뒤 **첫**
        // 스톨에서, 이번 주기에 단 한 번도 밀어보지 않은 채 `stalled restart limit (2) reached`로
        // 사람에게 올라갔다(사람은 이번 주기의 재점화를 하나도 볼 수 없다).
        const cycle = commentsSinceRequeue(comments);
        const restarts = cycle.filter((c) => String(c?.body ?? "").includes(marker));
        const restarted = restarts.at(-1);
        if (restarted && nowMs - Date.parse(restarted.createdAt) <= stale) continue;
        // 흐름 제어로 세워 둔 `factory:planned`는 멈춘 것이 아니다(M5) — 조용히 넘어간다.
        if (stage === "implement") {
          const reason = await parked();
          if (reason) { actions.push({ kind: "stalled-restart-skipped", issue: it.number, stage, label, reason: `back-pressure — ${reason}` }); continue; }
        }
        // 리뷰 효율 Task 8 (Structure G): 리뷰는 **미해결 하네스 의존성에 막힌** 이슈를 재dispatch하지
        // 않는다 — 그 라운드는 이슈 안의 변경으로 못 고칠 must_fix를 재확인할 뿐이다(KTB #3 spec1×2).
        // run-stage의 리뷰 진입 가드가 어차피 주차하지만, 여기서 걸러 워크플로 런 한 번(+재점화 마커)의
        // 낭비도 없앤다. 판정은 run-stage와 **같은** 단일 진실이다(이 피처를 막는 열린 factory:harness
        // 이슈). fail-safe: `gh.issueList` 미배선(구형 더블)이거나 조회가 던지면 평소대로 dispatch한다
        // (놓친 억제는 리뷰 한 라운드, 틀린 억제는 리뷰 가능한 이슈를 멈춰 세운다). 마커/락보다 앞이다 —
        // 억제할 이슈에는 예산도 락 조작도 쓰지 않는다.
        if (stage === "review" && typeof gh.issueList === "function") {
          let harnessDep = null;
          try { harnessDep = await findOpenHarnessIssueFor({ gh, issue: it.number }); }
          catch (e) { actions.push({ kind: "error", step: "stalled-restart", issue: it.number, error: `harness-dep check — ${String(e.message || e)}` }); harnessDep = null; }
          if (harnessDep != null) { actions.push({ kind: "stalled-restart-skipped", issue: it.number, stage, label, reason: `blocked on harness issue #${harnessDep}` }); continue; }
        }
        // KTB-28 (c) + r1 SF4: 락이 **살아 있으면** 이 이슈는 멈춘 것이 아니다 — 마커도 남기지 않고
        // (=예산을 쓰지 않고) 넘어간다. 잔해면 여기서 지운다(dispatch는 락을 보지 않으므로).
        // 에스컬레이션보다 **앞**이다: 살아 있는 스테이지를 "재점화가 안 먹혔다"로 읽어 사람을 부르면
        // 그 비용은 두 번 나간다(사람의 시간 + 돌고 있던 라운드).
        const lock = await releaseStaleLock({ releaseIfStale, issue: it.number, actions, step: "stalled-restart" });
        if (lock.state === "live") { actions.push({ kind: "stalled-restart-skipped", issue: it.number, stage, label, reason: `lock still live — ${lock.why}` }); continue; }
        // r2 MF1: 소유자를 모르는 락이면 밀지 않는다 — 하지만 조용히 넘어가지도 않는다. 이 자리에
        // 왔다는 것은 이미 스톨 임계를 넘겼다는 뜻이므로(위의 두 검사), 곧장 사람에게 올린다.
        if (lock.state === "unknown") {
          await escalateUnknownLock({ gh, transition, issue: it.number, comments, nowMs, stale, actions, step: "stalled-restart", why: lock.why, extra: { stage, label } });
          continue;
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
 * **이 팔은 계속 `→ queue`다**(KTB-36 라운드). 같은 라운드에서 사람에게 `needs-info → 중단 지점`
 * 재시도가 열렸지만(KTB-32 보강, `transition.js --human --retry`), 그 엣지는 **사람 전용**이고
 * 스크립트는 밟을 수 없다 — 그리고 그것이 옳다: "하네스 수정이 플랜을 한 글자도 건드리지 않았다"는
 * **판단**이고, 이 팔은 하네스 이슈가 닫혔다는 **사실**만 안다. 잘못 이어붙인 재개는 낡은 플랜으로
 * implement를 돌리지만, 잘못 재큐한 이슈는 plan 한 판을 더 돌 뿐이다 — 싼 쪽으로 기운다. 플랜이
 * 그대로임을 아는 사람은 sweeper보다 먼저 `:unstick`의 `retry`를 골라 그 한 판을 아낄 수 있다.
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

export const humanMergedComment = (issue, pr) => `<!-- factory-sweeper human-merged issue=${issue} pr=${pr} -->`;
/**
 * 이 팔 자신의 **거부** 마커 — PR 번호까지 싣는다(r3 must_fix 3). 성공 마커와 같은 이유다: 거부는
 * "이 이슈는 영영 안 된다"가 아니라 **"이 PR로는 안 된다"**이다. 보호 경로 이슈는 `:unstick`으로
 * 재큐돼도 다음 주기의 PR이 또 보호 경로를 건드리고(그것이 이 이슈가 이 경로에 있는 이유다) 또
 * 사람이 머지한다 — 이슈 단위 마커는 그 두 번째 머지를 영원히 막았다.
 */
export const humanMergeRefusedComment = (issue, pr) => `<!-- factory-sweeper human-merge-refused issue=${issue} pr=${pr} -->`;
/**
 * `transition()`이 요구조건 미달로 거부할 때 **스스로** 남기는 마커. 손으로 베끼지 않고 생산자와
 * 같은 생성자를 부른다(r3 should_fix 3) — 예전에는 같은 문자열이 두 파일에 각각 적혀 있어서, 한쪽
 * 형식이 바뀌면 dedupe가 **테스트가 전부 초록인 채로** 아무것도 찾지 못했다.
 *
 * r5: **dedupe는 더 이상 이것을 보지 않는다.** 이 마커에는 PR 번호가 없어서(transition은 PR을 모른다)
 * 한 주기 안의 **다른** PR에 대한 거부까지 삼켰다 — 이전 주기에서 머지된 PR이 이번 주기의 sha 바인딩에
 * 걸려 거부되면, 그 뒤에 사람이 이번 주기의 PR을 제대로 머지해도 영원히 조용했다. 이제 `!t.ok` 경로도
 * PR 범위 마커를 남기고 dedupe는 그것 하나만 본다. 이 상수는 사람이 이슈에서 두 마커를 같은 언어로
 * 읽도록 코멘트 본문에 함께 실린다.
 */
export const HUMAN_MERGE_REFUSED_MARKER = transitionRefusedMarker({ from: "factory:needs-human", to: "factory:merged" });

/**
 * 후보 이슈의 상한(r5 should_fix 2). `sort:updated-desc`가 "가장 최근에 움직인 것부터" 주므로, 그
 * 앞쪽 50개를 넘어가면 그것은 사람이 방금 머지한 이슈가 아니다 — 그리고 상한이 없으면 이 팔은
 * 30분마다 최대 200개(열린 것 + 저장소 수명 내내 쌓이는 닫힌 것)에 코멘트 조회를 낸다.
 */
export const HUMAN_MERGE_CANDIDATE_CAP = 50;
/**
 * 닫힌 이슈를 보는 나이 상한. 열린 `factory:needs-human`은 몇 개뿐이라 나이를 묻지 않지만, 닫힌
 * 것은 무한히 쌓인다 — 30일을 넘긴 채 아직 `factory:needs-human`인 닫힌 이슈는 sweeper가 조용히
 * 되살릴 일이 아니라 `:unstick`의 몫이다.
 */
export const HUMAN_MERGE_CLOSED_MAX_DAYS = 30;

/**
 * 이 이슈가 **마지막으로 실제로 도달한** 전이. `reason=refused` 마커는 건너뛴다.
 *
 * 그 마커는 상태가 바뀐 기록이 아니라 **바뀌지 않았다는 기록**이다(ADR-020 r2 SF3이 거부에도 전이
 * 문법을 붙인 이유는 라벨-셋 복구 팔이 에스컬레이션을 되돌리지 않게 하려는 것이었다). 그런데 아래
 * 팔의 판정 근거는 오직 "마지막 전이의 사유"이고, 거부는 `from`도 `to`도 `factory:needs-human`인 데다
 * 사유 문법마저 다르다 — 그것을 마지막 전이로 읽으면 **거부 한 번이 원래 사유를 영구히 가린다**.
 * 그러면 그 팔은 이슈를 다시는 보지 않고, 그 침묵에는 액션 한 줄도 남지 않는다(KTB-23이 죽었던
 * 방식 그대로다). 진짜 전이(`→ queue` 재큐 등)는 그대로 읽으므로, 재큐된 이슈는 이 팔이 정확히
 * 거절한다 — 그 이슈는 더 이상 사람의 머지를 기다리고 있지 않다.
 */
function lastRealTransition(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = TRANSITION_TO.exec(String(list[i]?.body ?? ""));
    if (!m || m[4] === "refused") continue;
    return lastTransition([list[i]]);
  }
  return null;
}

/**
 * ── 최종 리뷰 A-MF2 — **이 head가 `factory:approved`에 실제로 닿았는가.** ──────────────────────
 *
 * `requirements.js`의 `humanMerged` 분기가 `qaEvidenceGate`보다 **먼저** `pass`를 돌려주는 것은 옳은
 * 판단이다(sweep 잡에는 records 브랜치 체크아웃도 `qa_manifest` 다이제스트도 없다). 그 판단은 전제
 * 하나에 기대고 있었다: *"이 head의 매니페스트 존재·유효성은 `factory:approved` 전이 때 이미 검사됐다."*
 * 그런데 그 전제가 깨지는 길이 있었다 —
 *
 *   1주기: 리뷰 승인 → `factory:approved` 통과 → 머지 스테이지가 보호 경로에서 멈춤
 *          → `factory:needs-human (… — human merge required: …)`.
 *   2주기: 새 head Y. 리뷰 런이 `factory/review`·`factory/gates`를 **게이트보다 먼저** Y에 게시하고
 *          (`run-stage.js` postReviewStatus), 그 다음 `factory:approved` 전이가 **거부된다**
 *          (qa 증거 미검증·로스터 미해결·매니페스트 head 불일치). 거부는 `to=factory:needs-human …
 *          reason=refused`로 남고, `lastRealTransition`은 그것을 건너뛰므로 이 팔은 여전히 1주기의
 *          "사람의 머지를 기다린다"를 마지막 전이로 읽는다.
 *   그리고 사람이 PR을 머지하면 `verifyMergedPrEvidence`는 2주기가 남겨 둔 상태들을 찾아 통과하고,
 *   되돌릴 수 없는 `factory:merged`가 붙는다 — qa 증거 요구조건이 **그 커밋에 대해 한 번도 통과한 적
 *   없는 채로**.
 *
 * 그래서 여기서 그 전제를 **직접 확인한다**: 완료된 `→ factory:approved` 전이 마커가 있는가. 거부된
 * 승인 시도는 `to=factory:approved` 마커를 아예 남기지 않으므로(거부는 `→ needs-human`으로 적힌다),
 * 이 한 줄이 qa 게이트를 포함한 `factory:approved`의 **모든** 요구조건을 한꺼번에 대신 묻는다.
 * 추가 API 호출은 없다 — `comments`는 이미 손에 있다.
 *
 * **이번 주기의** 승인만 센다: 창은 마지막 재큐 이후다(`commentsSinceRequeue` — KTB-25가 라운드
 * 카운터에 쓰는 바로 그 창). 지난 주기의 승인이 이번 주기의 증거가 되지 않는다. 머지된 head가 이번
 * 주기의 것인지는 바로 위 stale-cycle 가드가 이미 확인했다(review handoff의 `head_sha`와 대조).
 */
export function approvedThisCycle(comments) {
  return commentsSinceRequeue(Array.isArray(comments) ? comments : []).some((c) => {
    const m = TRANSITION_TO.exec(String(c?.body ?? ""));
    return !!m && m[2] === "factory:approved" && m[4] !== "refused";
  });
}

/**
 * "이 머지된 PR의 증거가 GitHub에 남아 있는가"의 조회 껍데기. 판정 자체는 두 개의 공유 함수다 —
 * `verifyFactoryStatuses`(merge 스테이지 §(6b)의 판정 (d))와 `allChecksGreen`(merge 스테이지의
 * 머지 게이트가 쓰는 바로 그 함수). 여기서는 조회와 **조회 실패**만 다룬다.
 *
 * r3 must_fix 2 — 돌려주는 실패는 **두 종류**이고 호출자가 그 둘을 다르게 다룬다:
 *   - `transient: true` — 조회가 안 됐다(로그인 해석·상태·체크 조회의 throw, head sha 부재). 시간이
 *     푸는 종류다. 마커도 코멘트도 남기지 않고 다음 sweep이 그대로 다시 본다. 여기에 영구 마커를
 *     남기면 `502` 한 번이 그 이슈에서 이 팔을 **영원히** 끈다(= KTB-46 그 자체가 다시 생긴다).
 *   - 그냥 `{ ok:false, reason }` — 판정이다(머지되지 않았거나, 상태가 없거나, success가 아니거나,
 *     팩토리가 올린 것이 아니거나, 필수 체크가 GREEN이 아니다). 시간이 풀지 않는다 — 사람이 볼
 *     것이고, 그래서 마커가 남는다.
 *
 * r3 must_fix 4 — **필수 체크도 여기서 확인한다.** 예전 라운드는 "보호 브랜치가 `factory/integrity`를
 * required로 걸고 있으니 머지된 것 자체가 증거"라고 주장했는데, 그 전제는 두 군데서 거짓이다:
 * 보호가 없는 저장소는 지원되는 상태이고(doctor는 FAIL이 아니라 WARN이다), `harness.factory.required_checks`는
 * `factory/integrity` 말고도 더 걸 수 있다(브랜치 보호는 L0 하나만 강제한다). 게다가 `factory/integrity`는
 * **check run**이라 `commitStatuses`(commit **status** API)에는 아예 나타나지 않는다 — `gh.prChecks`가
 * 그것을 보는 유일한 창이다. 그래서 그 함수로 직접 본다.
 */
async function verifyMergedPrEvidence({ gh, factoryLogins, requiredChecks, pr, info }) {
  if (!info?.headSha) return { ok: false, transient: true, reason: `PR #${pr} reports no head sha — the merged commit cannot be named` };
  // r3 should_fix 4 — `mergedPrForBranch`의 `--state merged` 필터에만 기대지 않는다. 머지 사실은
  // 이 팔의 **전제**이므로 그 전제를 스스로 한 번 확인한다(다음 호출자도 보호한다).
  if (!info.mergedAt) return { ok: false, reason: `PR #${pr} is not merged — it reports no mergedAt` };
  const headSha = info.headSha;
  let lg;
  try { lg = await factoryLogins(); }
  catch (e) { return { ok: false, transient: true, reason: `the factory's own account could not be resolved (gh api user): ${e?.message || e}` }; }
  if (!lg?.ok || !Array.isArray(lg.logins) || !lg.logins.length) {
    return { ok: false, transient: true, reason: `the factory's own account could not be resolved (gh api user): ${lg?.reason || "unknown"}` };
  }
  let statuses;
  try { statuses = await gh.commitStatuses(headSha); }
  catch (e) { return { ok: false, transient: true, reason: `commit statuses for ${headSha.slice(0, 7)} unreadable: ${e?.message || e}` }; }
  // r5 nit 4: "목록이 아닌 것이 돌아왔다"는 조회가 이상한 것이지 판정이 아니다 — 영구 마커를 남기지
  // 않는다. (`verifyFactoryStatuses`의 같은 가드는 merge 스테이지 쪽에 그대로 남는다.)
  if (!Array.isArray(statuses)) return { ok: false, transient: true, reason: `commit statuses for ${headSha.slice(0, 7)} unreadable — no list returned` };
  const posted = verifyFactoryStatuses({ sha: headSha, statuses, logins: lg.logins });
  if (!posted.ok) return posted;
  let checks;
  try { checks = await gh.prChecks(pr); }
  catch (e) {
    /**
     * r5 should_fix 1 — `gh pr checks`는 **체크가 하나도 없는 PR**에서 0이 아닌 코드로 끝난다
     * (`GH_NO_CHECKS_RE`). 그것은 조회 실패가 아니라 `allChecksGreen([])`이 이미 내리는 그 판정이고,
     * merge 스테이지도 같은 throw를 판정으로 접는다(`mergeGates`의 catch가 `checksGreen`을 세우지
     * 않으면 `requirements.js`가 "required checks not verified GREEN"으로 거부한다). 그것을 transport로
     * 분류하면 체크 없이 머지된 PR이 30분마다 조용한 error 줄만 남기며 영원히 재시도된다.
     */
    if (GH_NO_CHECKS_RE.test(String(e?.message || e))) {
      return { ok: false, reason: `no checks reported on the merged head of PR #${pr} — a merge with no checks at all is not a verified merge` };
    }
    return { ok: false, transient: true, reason: `checks for PR #${pr} unreadable: ${e?.message || e}` };
  }
  if (!allChecksGreen(checks ?? [], requiredChecks ?? null)) {
    return { ok: false, reason: `required checks on PR #${pr} are not all GREEN (${(requiredChecks ?? ["<all>"]).join(", ")}) — the merge went in without them` };
  }
  return { ok: true };
}

/**
 * KTB-46 — **사람이 머지한 보호 경로 PR을 이슈에 잇는다.**
 *
 * KTB #3(2026-09-14 13:59Z)이 그 구멍을 라이브로 보여 줬다: 리뷰 R3가 4/4 승인했고, merge 스테이지는
 * 단계 (3)에서 `protected paths changed — human merge required: …`로 자동 머지를 거부하며 이슈를
 * `factory:needs-human`으로 올렸다(설계대로다 — §12.3-2). 소유자가 PR #4를 손으로 squash-merge 했다.
 * 그런데 그 뒤에 이슈를 움직이는 것이 **아무것도 없었다**: 그래프에 `needs-human → merged` 엣지가
 * 없었고, `Closes #n`은 걸리지 않아 이슈는 열린 채였고, 머지 뒤에 도는 merge 단계 (9)는 이 경로에서
 * 애초에 실행되지 않는다(KTB-23의 하네스 주차 해제가 죽었던 것과 **정확히 같은** 구멍이다).
 * 운영자가 손으로 라벨을 붙이고 닫았다.
 *
 * 판정은 넷이고, **merge 스테이지가 자동 머지 앞에서 묻는 것과 같은 것들**이다(그래야 사람의 머지를
 * 잇는 문이 팩토리 자신의 문보다 싸지 않다):
 *   1. 마지막 **실제** 전이가 `→ factory:needs-human`이고 그 사유가 `HUMAN_MERGE_REQUIRED`와 맞는가.
 *      `factory:needs-human`은 이 공장에서 가장 많은 뜻을 겸하는 라벨이다(재점화 한도, 락 소유자
 *      불명, 리뷰 라운드 소진, 게이트 RED…). 사유 한 줄만이 "사람이 머지해 주기를 기다리는 중"을
 *      나머지와 가른다 — 그 문구의 출처는 `merge-stage.js`가 내보내는 정규식 하나뿐이다.
 *   2. `claude/fq-<n>`에서 머지된 PR이 있는가(`mergedPrForBranch` + `mergedAt`). builder는 언제나
 *      그 브랜치에서 작업하므로 브랜치 이름이 곧 이슈 번호다.
 *   3. **게이트·체크 증거**(`verifyMergedPrEvidence`): 그 head sha의 `factory/gates`·`factory/review`
 *      상태가 success이고 팩토리 계정이 올린 것인가, 그리고 그 PR의 필수 체크가 전부 GREEN인가.
 *      이 팔에는 체크아웃도 이번 런의 `.factory/out/gates.json`도 없고 있을 수도 없다 — 머지는 이미
 *      일어났고, 그 커밋에 대해 남아 있는 증거는 GitHub이 들고 있는 이것들이다.
 *   4. 그리고 **전이 자신의 요구조건**(`requirements.js`의 `factory:merged`): review handoff가 이 PR
 *      head sha에 묶여 있는가, 그리고 **이 tier의 로스터로** 정족수 all-approve와 K를 `must_fix`에서
 *      다시 계산한 결과가 통과인가. 그 로스터와 K는 이 팔이 직접 실어 보낸다 — r3 must_fix 1까지
 *      보내지 않아서, 4명짜리 로스터의 이슈가 **1명의 approve**로도 통과했다(정족수 검사는 잴 자가
 *      없으면 통째로 무음이 된다). tier도 merge 스테이지와 같은 것을 쓴다(r4): diff를 다시 내는 대신
 *      review handoff에 기록된 `tier_effective`를 읽어 선언 tier와 `maxTier`로 합친다 — 로스터는
 *      어느 쪽보다도 작아지지 않는다. **사람의 머지가 예외이지 증거가 예외인 것이 아니다**(§12.3-2).
 *
 * **닫힌 이슈도 본다**(`state: "all"`). `Closes #n`이 실제로 걸리는 경우 이슈는 `factory:needs-human`
 * 라벨을 그대로 단 채 닫히고 — 그건 "끝났다"가 아니라 **상태 라벨이 거짓말을 하는 이슈**다(retro의
 * 수확 통계가 그것을 needs-human 한 건으로 센다).
 *
 * 후보를 자르는 것은 세 가지다(r3 should_fix 1·2 + r5 should_fix 2):
 *   - **API 쪽 정렬**(`sort:updated-desc`). 판정을 `updatedAt` **시간 창**으로 하지는 않는다: 그것은
 *     *이슈*의 활동이라 사람이 PR만 머지하면 움직이지 않고 — 이 경로의 이슈는 정확히 그렇게 며칠씩
 *     앉아 있다 — 창은 그 이슈를 조용히 떨어뜨렸다. 정렬만 옮기면 같은 200개가 "번호가 큰 200개"가
 *     아니라 "가장 최근에 움직인 200개"가 된다.
 *   - **닫힌 이슈는 30일까지**(`HUMAN_MERGE_CLOSED_MAX_DAYS`). 열린 needs-human은 몇 개뿐이지만 닫힌
 *     것은 저장소 수명 내내 쌓인다. 그보다 오래된 채 아직 이 라벨인 닫힌 이슈는 `:unstick`의 몫이다.
 *   - **실제로 들여다보는 후보 50개**(`HUMAN_MERGE_CANDIDATE_CAP`). 코멘트 조회는 이슈당 한 번이고,
 *     상한이 없으면 30분마다 최대 200번이 나간다. 목록이 이미 최근 갱신순이므로 그 앞쪽을 본다.
 * 셋 다 걸릴 때마다 사유와 함께 한 줄을 남긴다 — 잘린 것도 소리를 낸다.
 *
 * **cron 전용이다**(`quick`이 아니다, r3 nit 3). 사람이 머지 버튼을 누르는 사건은 스테이지 잡이
 * 끝나는 순간과 아무 상관이 없고 30분 안에 반영되면 충분하다 — 매 스테이지마다 돌리면 주차된
 * 이슈마다 "아직 머지 안 됨" 줄만 쌓인다.
 *
 * 실패가 기우는 방향: 성공 마커는 **전이가 성공한 뒤에** 남기고, **판정**으로 거부한 것만 PR 범위의
 * 거부 마커를 남긴다. 조회 실패(transient)는 액션 한 줄뿐이라 다음 sweep이 그대로 다시 시도한다.
 * 그리고 모든 건너뜀은 **소리를 낸다**(`human-merged-skipped` + 사유) — 조용한 건너뜀이 바로
 * KTB-23과 이 티켓이 열린 이유다.
 */
async function sweepHumanMerged({ gh, transition, factoryLogins, reviewRoster, requiredChecks, charter, nowMs, actions }) {
  // 구형 배선(테스트 더블 포함)은 조용히 건너뛴다 — 다른 dep들과 같은 계약("안 쓴다"와 "에러났다"를
  // 가른다). 조회 함수가 하나라도 없으면 증거를 **확인할 수 없다**는 뜻이고, 확인할 수 없는 것을
  // 통과로 읽지 않는다: 이 팔은 아예 돌지 않는다.
  /**
   * 최종 리뷰 B-nit 1 — **건너뛸 때도 소리를 낸다.** "구형 배선은 조용히 건너뛴다"는 테스트 더블에는
   * 맞는 말이지만 프로덕션에는 틀렸다: `bin/sweep.js`에서 dep 하나가 빠지는 리팩터 한 번이 이 팔을
   * 통째로 끄고, 그 침묵에는 액션 한 줄도 남지 않는다 — KTB-23과 이 티켓이 열린 바로 그 모양이다.
   */
  const missingDep = [...["mergedPrForBranch", "prMergeInfo", "commitStatuses", "prChecks"].filter((fn) => typeof gh[fn] !== "function"),
    ...(typeof factoryLogins !== "function" ? ["factoryLogins"] : []),
    ...(typeof reviewRoster !== "function" ? ["reviewRoster"] : [])];
  if (missingDep.length) {
    actions.push({ kind: "human-merged-skipped", reason: `wiring incomplete: ${missingDep.join(", ")} — this arm did not run` });
    return;
  }
  let issues;
  try { issues = await gh.searchIssues("factory:needs-human", { state: "all", sort: "updated-desc" }); }
  catch (e) { actions.push({ kind: "error", step: "human-merged", error: String(e.message || e) }); return; }
  let considered = 0;
  for (const it of issues) {
    try {
      /**
       * r5 should_fix 2 — **후보에는 바닥이 있다.** 시간 창(r2)이 틀린 시계였다고 해서 상한 자체가
       * 필요 없어진 것은 아니었다: 그 창은 "코멘트 조회를 몇 개까지 낼 것인가"도 함께 막고 있었고,
       * r3가 그것을 대체 없이 지웠다. 이제 둘로 막는다 — 닫힌 이슈는 30일까지만(그보다 오래된 채
       * 아직 `factory:needs-human`인 닫힌 이슈는 sweeper가 조용히 되살릴 것이 아니라 `:unstick`의
       * 몫이다), 그리고 실제로 들여다보는 후보는 앞에서 50개까지(목록은 이미 최근 갱신순이다).
       * 열린 이슈는 나이를 묻지 않는다 — 그쪽은 공장이 지금 붙들고 있는 몇 개뿐이다.
       */
      const isClosed = String(it.state ?? "").toUpperCase() === "CLOSED";
      const updatedMs = Date.parse(it.updatedAt ?? "");
      if (isClosed && Number.isFinite(updatedMs) && nowMs - updatedMs > HUMAN_MERGE_CLOSED_MAX_DAYS * 86400e3) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, reason: `closed and untouched for over ${HUMAN_MERGE_CLOSED_MAX_DAYS} days — :unstick territory, not the sweeper's` });
        continue;
      }
      if (considered >= HUMAN_MERGE_CANDIDATE_CAP) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, reason: `candidate cap (${HUMAN_MERGE_CANDIDATE_CAP}) reached — the list is newest-updated first, so anything past it was not merged just now` });
        break;
      }
      considered += 1;
      const comments = await gh.comments(it.number);
      const last = lastRealTransition(comments);
      if (!last || last.to !== "factory:needs-human" || !HUMAN_MERGE_REQUIRED.test(last.reason || "")) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, reason: `not parked on a human merge — last transition ${last ? `→ ${last.to} (${last.reason || "no reason"})` : "none"}` });
        continue;
      }
      let pr;
      try { pr = await gh.mergedPrForBranch(`claude/fq-${it.number}`); }
      catch (e) { actions.push({ kind: "error", step: "human-merged", issue: it.number, error: String(e.message || e) }); continue; }
      if (pr == null) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, reason: `no merged PR on claude/fq-${it.number} — waiting for a person to merge` });
        continue;
      }
      if (comments.some((c) => String(c?.body ?? "").includes(humanMergedComment(it.number, pr)))) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, pr, reason: "already reconciled" });
        continue;
      }
      let info;
      try { info = await gh.prMergeInfo(pr); }
      catch (e) { actions.push({ kind: "error", step: "human-merged", issue: it.number, error: String(e.message || e) }); continue; }
      /**
       * r5 must_fix (a) — **이 머지된 PR이 이번 주기의 것인가.** `mergedPrForBranch`는 브랜치 이름
       * 하나로 찾으므로, 이번 주기의 PR이 아직 머지되지 않았으면 **지난 주기에 머지된 PR**을 돌려준다.
       * 그 PR의 옛 head에도 팩토리가 올린 상태와 초록 체크가 그대로 남아 있어 증거 검사를 통과하고,
       * 전이는 sha 바인딩에서 거부되며, 그 거부가 이번 주기를 오염시켰다 — 그 뒤에 사람이 이번 주기의
       * PR을 제대로 머지해도 영원히 조용했다(= KTB-46이 한 주기 깊은 곳에서 되살아난다).
       *
       * 가르는 기준은 **최신 review handoff의 `head_sha`**다: 그것이 "지금 이 이슈의 리뷰가 서술한
       * 커밋"이고, `requirements.js`가 곧이어 `prHeadSha`와 대조할 바로 그 값이다. 다르면 이 PR은
       * 이 팔의 일이 아니므로 마커도 코멘트도 남기지 않고 **소리만 내고** 넘어간다.
       * review handoff가 아예 없으면 비교할 것이 없다 — 그때는 그대로 진행해 전이가 거부하게 둔다
       * (그 거부는 사람이 읽어야 할 진짜 판정이다).
       */
      const reviewHead = latestHandoff(comments, "review")?.data?.head_sha ?? null;
      if (reviewHead && info?.headSha && info.headSha !== reviewHead) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, pr, reason: `merged PR #${pr} head ${String(info.headSha).slice(0, 7)} ≠ latest review head ${reviewHead.slice(0, 7)} — that PR belongs to an earlier cycle` });
        continue;
      }
      // A-MF2 — `factory:approved`가 이 head에 대해 **실제로 통과했는가**(§approvedThisCycle).
      if (!approvedThisCycle(comments)) {
        actions.push({
          kind: "human-merged-skipped", issue: it.number, pr,
          reason: `head ${String(info?.headSha ?? "unknown").slice(0, 7)} never reached factory:approved — this issue carries no completed \`→ factory:approved\` transition for this cycle, so the requirements of that label (the qa evidence gate among them) were never satisfied for the merged commit. \`:unstick\`으로 정리하세요.`,
        });
        continue;
      }
      /**
       * 거부 dedupe는 **PR 범위 하나**다(r5 must_fix (b)). r3은 여기에 `transition()` 자신의 마커도
       * 함께 봤는데, 그 마커에는 PR 번호가 없어서(transition은 PR을 모른다) 한 주기 안의 **다른** PR에
       * 대한 거부까지 삼켰다. 이제 `!t.ok` 경로도 이 PR 범위 마커를 남기므로(아래), 이것 하나면 충분하고
       * 정확하다 — PR 번호는 저장소 안에서 다시 쓰이지 않으니 주기 범위를 따로 잡을 필요도 없다.
       */
      const refusedMark = humanMergeRefusedComment(it.number, pr);
      if (comments.some((c) => String(c?.body ?? "").includes(refusedMark))) {
        actions.push({ kind: "human-merged-skipped", issue: it.number, pr, reason: "already refused for this PR" });
        continue;
      }
      const ev = await verifyMergedPrEvidence({ gh, factoryLogins, requiredChecks, pr, info });
      if (!ev.ok) {
        // transient는 **조회가 안 된 것**이지 판정이 아니다 — 마커도 코멘트도 남기지 않는다.
        if (ev.transient) { actions.push({ kind: "error", step: "human-merged", issue: it.number, error: ev.reason }); continue; }
        await gh.comment(it.number, `${refusedMark}\nPR #${pr}이 머지돼 있지만 이 이슈를 \`factory:merged\`로 잇지 않았습니다 — ${ev.reason}. 보호 경로 PR을 사람이 머지해도 리뷰·게이트 증거는 자동 머지와 똑같이 요구됩니다(KTB-46, 스펙 §12.3-2). \`:unstick\`으로 이 이슈를 정리하세요 — sweeper는 이 PR에 대해 같은 말을 다시 하지 않습니다.`);
        actions.push({ kind: "human-merged-refused", issue: it.number, pr, reason: ev.reason });
        continue;
      }
      /**
       * 정족수의 자(尺). 이것이 없으면 `verifyReviewQuorum`은 "있는 verdict가 전부 approve인가"만 보고
       * **로스터 크기·빠진 역할·K를 전부 건너뛴다** — 검사가 있는 것처럼 보이는데 잴 자가 없는 상태다.
       * 해석은 merge 스테이지와 같은 `resolveReviewRoster`이고(실효 tier만 없다 — 머지된 뒤에는
       * `claude/fq-<n>`이 지워져 diff를 다시 낼 수 없다), 못 구하면 **거부한다**: 이 팔의 나머지와
       * 같은 원칙으로 확인 못 한 것을 통과로 읽지 않는다.
       */
      /**
       * r4 — **실효 tier의 parity.** merge 스테이지는 `base...HEAD` diff로 tier 바닥을 계산해 로스터를
       * 넓히는데(감사 H3), 이 팔은 그 diff를 다시 낼 수 없다(squash 머지와 함께 브랜치가 지워졌다).
       * 다시 계산하는 대신 **이미 계산된 값을 읽는다**: 이 PR head에 묶인 review handoff의
       * `tier_effective`는 리뷰 런이 `resolveTier`로 만든 바로 그 값이다. `resolveReviewRoster`가
       * `maxTier(선언, handoff)`로 합치므로 로스터는 **어느 쪽보다도 작아지지 않는다**.
       *
       * 1.2 이전 기록에는 그 필드가 없다 — 그때는 선언 tier로 내려가되 **조용히 내려가지 않는다**:
       * 한 줄을 남겨 "이 이슈에서는 tier parity를 확인할 수 없었다"고 말한다. 조용한 약화가 바로
       * r3 must_fix 1이 잡아낸 실패 모양이다.
       */
      const handoffTier = latestHandoff(comments, "review")?.data?.tier_effective ?? null;
      if (!handoffTier) {
        actions.push({ kind: "human-merged-note", issue: it.number, pr, note: "review handoff carries no tier_effective (pre-1.2 record) — the roster falls back to the declared tier, so tier parity with the merge stage could not be confirmed" });
      }
      const ros = await reviewRoster(comments, handoffTier);
      if (!ros?.ok || !Array.isArray(ros.roles) || !ros.roles.length) {
        const reason = ros?.reason || "review roster unresolvable — quorum cannot be checked";
        await gh.comment(it.number, `${refusedMark}\nPR #${pr}이 머지돼 있지만 이 이슈를 \`factory:merged\`로 잇지 않았습니다 — ${reason}. 정족수를 잴 자가 없으면 리뷰 증거를 확인할 수 없고, 확인 못 한 것은 통과가 아닙니다(KTB-46).`);
        actions.push({ kind: "human-merged-refused", issue: it.number, pr, reason });
        continue;
      }
      /**
       * 최종 리뷰 B-SF6 — **K를 못 읽으면 조용히 약해지지 않는다.** 예전에는 `Number.isInteger`가
       * 거짓이면 `maxRounds`를 ctxExtra에서 통째로 뺐고, `verifyReviewQuorum`은 `round > K` 검사를
       * **액션 한 줄 없이** 건너뛰었다 — 이 팔의 나머지가 전부 "확인 못 한 것은 통과가 아니다"인데
       * 여기만 반대였다(r3 must_fix 1이 죽이려던 바로 그 실패 모양). 되돌릴 수 없는 `factory:merged`
       * 앞에서 한도 하나를 모르는 채로 지나가지 않는다: 이름 있는 사유로 거부하고 사람에게 넘긴다.
       */
      if (!Number.isInteger(charter?.limits?.K)) {
        const reason = `CHARTER limits.K is ${charter?.limits?.K === undefined ? "missing" : `not an integer (${JSON.stringify(charter.limits.K)})`} — the review round limit cannot be re-derived, and an unmeasurable limit is not a satisfied one`;
        await gh.comment(it.number, `${refusedMark}\nPR #${pr}이 머지돼 있지만 이 이슈를 \`factory:merged\`로 잇지 않았습니다 — ${reason}. \`docs/factory/CHARTER.md\`의 \`limits.K\`를 고친 뒤 \`:unstick\`으로 이 이슈를 정리하세요(KTB-46).`);
        actions.push({ kind: "human-merged-refused", issue: it.number, pr, reason });
        continue;
      }
      const by = info.mergedBy || "a person";
      const t = await transition({
        issue: it.number,
        to: "factory:merged",
        reason: `PR #${pr} merged by ${by} (protected paths — human merge)`,
        /**
         * 증거는 깎지 않고 **출처만 바꾼다**. `humanMerged`는 "이 전이는 사람이 이미 만든 머지의
         * 사후 기록"이라는 뜻이고, `statusesVerified`는 그 게이트·체크 증거를 방금
         * `verifyMergedPrEvidence`로 확인했다는 뜻이다(`requirements.js`가 이 둘을 **함께** 요구한다 —
         * 앞의 것만으로는 아무것도 열리지 않는다). 나머지 넷(`prHeadSha`·`roster`·`rosterSize`·
         * `maxRounds`)은 merge 스테이지가 같은 전이에 싣는 것과 같은 값이고, `issue`는 handoff
         * 마커의 이슈 번호까지 대조하게 한다. 이 두 플래그의 **유일한 생산자는 이 자리**다 —
         * `bin/transition.js`는 `gatesChecked`·`gatesFile`만 담은 닫힌 리터럴을 넘기고 알 수 없는
         * 플래그는 파서가 거절한다.
         */
        ctxExtra: {
          issue: it.number, prHeadSha: info.headSha,
          roster: ros.roles, rosterSize: ros.roles.length,
          maxRounds: charter.limits.K,                                  // 위에서 정수임을 확인했다(B-SF6)
          humanMerged: true, statusesVerified: true,
        },
      });
      if (!t?.ok) {
        /**
         * r5 must_fix (b) — **요구조건 거부도 PR 범위로 기록한다.** `transition()`은 자기 마커를
         * 이미 남겼지만 거기에는 PR 번호가 없다(transition은 PR을 모른다) — 그것 하나로 dedupe하면
         * 같은 주기의 **다른** PR에 대한 거부까지 삼킨다. 여기서 PR 범위 마커를 한 줄 더 남겨 위의
         * dedupe가 정확히 이 PR만 보게 한다. transition의 마커도 본문에 함께 실어, 사람이 이슈에서
         * 두 기록을 같은 자리에서 읽게 한다(그 마커의 사유는 transition이 이미 적었다).
         */
        try {
          await gh.comment(it.number, `${refusedMark}\nPR #${pr}은 머지돼 있지만 \`factory:merged\` 전이가 요구조건에서 거부됐습니다 — ${t?.reason ?? "unknown"}. 바로 위 \`${HUMAN_MERGE_REFUSED_MARKER}\` 코멘트가 그 판정입니다. sweeper는 이 PR에 대해 같은 말을 다시 하지 않습니다 — \`:unstick\`으로 이 이슈를 정리하세요(KTB-46).`);
        } catch (e) {
          actions.push({ kind: "error", step: "human-merged", issue: it.number, error: String(e.message || e) });
        }
        actions.push({ kind: "human-merged-refused", issue: it.number, pr, reason: t?.reason ?? "unknown" });
        continue;
      }
      await gh.comment(it.number, `${humanMergedComment(it.number, pr)}\nPR #${pr}을 ${by}이(가) 머지했습니다 — 보호 경로 변경이라 팩토리가 자동 머지하지 않고 사람에게 넘긴 PR입니다(스펙 §12.3-2). 머지 사실과 리뷰·게이트·필수 체크 증거를 확인하고 \`factory:needs-human\`에서 \`factory:merged\`로 이었습니다(KTB-46). 이 head가 \`factory:approved\`에 실제로 도달했다는 것(= qa 증거 게이트를 포함한 그 라벨의 요구조건이 이 커밋에 대해 통과했다는 것)도 함께 확인했습니다. 다만 이 문(門)에서 **다시 계산하지 않는 검사가 둘** 있습니다 — ① \`factory/records\` run 기록과의 리뷰 provenance 대조(자동 머지의 §(6b)), ② 그 기록의 \`qa_manifest=\` 다이제스트 재대조. sweep 잡에는 records 브랜치 체크아웃이 없어서입니다. KTB-48이 둘 다 덮습니다(tier ${ros.tier}, 리뷰어 ${ros.roles.length}명).`);
      // 이슈가 아직 열려 있으면 닫는다 — `Closes #n`이 걸리지 않은 경우다(KTB #3이 그랬다).
      // `factory status`의 "Needs You"가 이미 끝난 이슈를 계속 세지 않게 하는 마지막 한 걸음이고,
      // 실패해도 전이 자체는 되돌리지 않는다(라벨이 이미 진실을 말한다).
      let closed = false;
      try {
        const st = typeof gh.issueState === "function" ? await gh.issueState(it.number) : null;
        if (st && st.state !== "CLOSED" && typeof gh.closeIssue === "function") { await gh.closeIssue(it.number); closed = true; }
      } catch (e) {
        actions.push({ kind: "error", step: "human-merged-close", issue: it.number, error: String(e.message || e) });
      }
      actions.push({ kind: "human-merged", issue: it.number, pr, mergedBy: info.mergedBy ?? null, closed });
    } catch (e) {
      actions.push({ kind: "error", step: "human-merged", issue: it.number, error: String(e.message || e) });
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
export async function sweep({ gh, charter, thresholds, now, staleMinutes = 30, transition, release, quarantine, saveQuarantine, tokenIssuedAt = null, dispatchStage = null, backPressure = null, harnessSettled = null, factoryLogins = null, reviewRoster = null, requiredChecks = null, releaseIfStale = null, quick = false }) {
  const actions = [];
  const nowMs = Date.parse(now);
  const stale = staleMinutes * 60e3;
  // r5 nit 5: 이 줄은 quick sweep이 **실제로 건너뛴 것**을 말해야 한다 — KTB-46의 사람-머지 반영 팔도
  // cron 전용이 된 뒤로 그 목록에 속한다(그 줄이 실제와 다르면 run 기록을 읽는 사람이 오해한다).
  if (quick) actions.push({ kind: "quick-sweep", skipped: ["quarantine", "token-expiry", "human-merged"] });
  /**
   * r2 SF5 — **복구 팔이 먼저 돈다.** 라벨 변경 하나가 최대 13초를 자게 된 뒤로(KTB-30 b), 이 잡의
   * 시간 예산은 유한한 자원이 됐다: 넓은 API 장애 — 곧 이 두 팔이 가장 많이 할 일이 있는 바로 그
   * 상황 — 에서는 앞선 팔들이 15분을 다 쓰고 잡이 SIGKILL될 수 있었다. 장애를 치우려고 만든 팔이
   * 장애 때 실행되지 않는 순서였다. 그래서 맨 앞으로 옮겼다(`--quick`도 같은 순서다): 이 둘은 다른
   * 팔들의 **입력**(상태 라벨)을 고치므로, 앞에 두면 같은 sweep 안에서 나머지 팔이 고쳐진 라벨을 본다.
   */
  await sweepMissingStateLabel({ gh, nowMs, actions });
  await sweepLabelSetRepair({ gh, actions });
  for (const it of await gh.searchIssues("factory:in-progress")) {
    try {
      const comments = await gh.comments(it.number);
      const hb = comments.map((c) => HB.exec(c.body)).filter(Boolean).at(-1);
      const last = hb ? Date.parse(hb[2]) : null;
      if (last && nowMs - last <= stale) continue;
      /**
       * r2 SF2 — **하트비트가 늦었다는 것은 락이 잔해라는 증명이 아니다.** 예전에는 여기서 리스도
       * 소유자 확인도 없이 `release()`를 불렀다(무조건 삭제). 하트비트는 best-effort로 패치되고
       * (`lib/heartbeat.js` — 에러를 삼키고 재시도하지 않는다) 30분 창은 GitHub 장애 하나면 지나간다:
       * 그 창에서 살아 있는 런의 락을 지우고 재큐까지 하면, 같은 이슈에 두 implement가 겹친다(로컬
       * 진입에는 concurrency 그룹조차 없다). 이제 삭제는 MF1의 리스 경로 하나뿐이고 — 읽은 sha에
       * CAS를 건다 — 소유자가 **살아 있다고 확인되면 재큐 자체를 하지 않는다**(그 재큐는 R 예산을
       * 태우는데, 태울 이유가 없다). 배선이 없는 구형 호출자는 예전의 `release()` 그대로다.
       */
      let lockNote = "lock released";
      if (releaseIfStale) {
        const lock = await releaseStaleLock({ releaseIfStale, issue: it.number, actions, step: "heartbeat-requeue" });
        if (lock.state === "live") { actions.push({ kind: "requeue-skipped", issue: it.number, reason: `lock still live — ${lock.why}` }); continue; }
        /**
         * ADR-020 최종 리뷰 MF-4 — **세 팔 중 이 하나만 r1의 계약(불리언)에 남아 있었다.** r2 MF1이
         * `live` / `none|stale` / `unknown`을 가르고 두 dispatch 팔에 "모른다"는 "돌고 있다"가
         * 아니다"를 가르쳤는데, 여기서는 `unknown`이 "락은 그냥 둔다"로만 읽히고 **재큐는 그대로
         * 진행**됐다.
         *
         * 그 차이가 만드는 사고: 로컬 `factory run implement <n>`(§4.2.5의 지원되는 진입 경로)은
         * `runner=local/<host>`로 락을 잡고, `ghaRunIdOf`가 null이라 판정은 **영구히** `unknown`이다.
         * 하트비트 패치 실패는 설계상 삼켜지므로(`heartbeat.js`) GitHub 딸꾹질 한 번이면 살아 있는
         * 런의 하트비트가 30분을 넘긴다. 그 다음 quick sweep(KTB-26 이후 **모든 스테이지 끝**에 돈다)이
         * `in-progress → planned`로 재큐하며 R 예산을 한 칸 태우고, 살아 있던 builder가 GREEN PR을
         * 밀고 `in-progress → awaiting-review`를 부르면 현재 라벨은 이미 `planned`라 그래프가 거부한다
         * — 끝난 구현이 그대로 좌초하고 다음 dispatch가 처음부터 다시 돈다. GHA 러너도 `gh run view`가
         * 실패하면(토큰 스코프, Actions 장애) 같은 문에 들어선다: 이 팔이 살아남으라고 있는 바로 그
         * 상황이다.
         *
         * 그래서 두 dispatch 팔과 **같은 판정**을 한다: 재큐하지 않고, 임계를 넘겼으면 사람을 부른다.
         * 임계는 이 팔이 이미 재고 있다 — 하트비트가 있으면 그것이 `stale`을 넘겼다는 사실로 위에서
         * 확정됐고(넘지 않았으면 `continue`), 하나도 없으면 blocked 팔과 같이 마지막 전이의 나이로 잰다.
         */
        if (lock.state === "unknown") {
          const at = hb ? Date.parse(hb[2]) : Date.parse(lastTransition(comments)?.at ?? "");
          if (Number.isFinite(at) && nowMs - at <= stale) {
            actions.push({ kind: "requeue-skipped", issue: it.number, reason: `lock owner unknown — ${lock.why}` });
            continue;
          }
          await escalateUnknownLock({ gh, transition, issue: it.number, comments, nowMs, stale, actions, step: "heartbeat-requeue", why: lock.why });
          continue;
        }
        lockNote = lock.released ? "lock released" : `lock left alone (${lock.why})`;
      } else {
        await release(it.number);
      }
      const prev = comments.map((c) => RETRY.exec(c.body)).filter(Boolean).at(-1);
      const count = (prev ? Number(prev[2]) : 0) + 1;
      await gh.comment(it.number, `<!-- factory-retry issue=${it.number} count=${count} -->\nheartbeat stale (${hb ? hb[2] : "none"}) — ${lockNote}, retry ${count}/${charter.limits.R}`);
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
            // KTB-28 (c) + r1 SF4: stalled 팔과 같은 판정을 같은 순서로 한다 — 잔해 락은 (리스를 걸고)
            // 지우고, 살아 있는 락이면 이 재시도는 시도조차 하지 않는다(마커도, 시도 번호도 쓰지 않는다).
            const lock = await releaseStaleLock({ releaseIfStale, issue: it.number, actions, step: "blocked-retry" });
            if (lock.state === "live") { actions.push({ kind: "blocked-retry-skipped", issue: it.number, stage: retryStage, cause, reason: `lock still live — ${lock.why}` }); continue; }
            /**
             * r2 MF1 — 소유자를 모르는 락: 밀지 않고, **스톨 임계를 넘겼으면** 사람에게 올린다. 여기서
             * 임계를 다시 재는 이유는 이 팔의 입구에 나이 검사가 없기 때문이다(blocked은 나이와 무관하게
             * 집는다) — 방금 blocked이 된 이슈를 그 자리에서 needs-human으로 올리면, 정상적인 재시도
             * 한 번을 빼앗는다. 아래 기본 경로(에스컬레이션)는 그대로 두고 이 분기만 사유가 다르다.
             */
            if (lock.state === "unknown") {
              const at = Date.parse(lastTransition(comments)?.at ?? "");
              if (Number.isFinite(at) && nowMs - at <= stale) {
                actions.push({ kind: "blocked-retry-skipped", issue: it.number, stage: retryStage, cause, reason: `lock owner unknown — ${lock.why}` });
                continue;
              }
              await escalateUnknownLock({ gh, transition, issue: it.number, comments, nowMs, stale, actions, step: "blocked-retry", why: lock.why, extra: { stage: retryStage, cause } });
              continue;
            }
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
  if (quick) return actions;                     // KTB-26 — 아래 팔들은 시간에 묶여 있다(cron의 몫)
  // KTB-46 (r3 nit 3): 사람이 머지 버튼을 누르는 사건은 스테이지 잡이 끝나는 순간과 무관하다 —
  // cron 주기(≤30분) 안에 반영되면 충분하고, 매 스테이지마다 돌리면 주차된 이슈마다 "아직 머지
  // 안 됨" 줄만 쌓인다. 그래서 격리·토큰 만료와 같은 쪽에 선다.
  await sweepHumanMerged({ gh, transition, factoryLogins, reviewRoster, requiredChecks, charter, nowMs, actions });
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
