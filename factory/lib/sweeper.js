import { applyPolicy } from "./quarantine.js";
import { quarantineComment } from "./retro/quarantine-ops.js";
import { TRANSITION_TO, blockedOrigin } from "./retro/issue-comments.js";
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
 * blocked 팔 전용 재시도 마커(KTB-19 review I-1). 예전에는 `restartComment`(stalled 팔과 **같은**
 * 마커)를 재사용했는데, 정상적인 흐름 하나가 그 dedupe를 조용히 무력화했다: `factory:approved`에서
 * 멈춘 이슈를 stalled 팔이 먼저 `factory-merge.yml`을 dispatch하며 `restartComment("merge", n)`을
 * 남기고, 그 머지 런이 실패해 blocked으로 떨어지면(origin=approved) blocked 팔이 "merge를 한 번
 * 다시 밀어볼 차례"인데 — 마커 텍스트가 stalled 팔의 것과 똑같아서 이미 있는 것으로 보여 곧장
 * needs-human으로 에스컬레이션했다. "한 번의 공짜 재시도"가 이 경로에서는 아예 일어나지 않았다.
 * 별도 마커로 완전히 갈라 stalled 팔의 재점화와 blocked 팔의 재점화가 서로의 dedupe를 밟지 않게
 * 한다. "origin 마커보다 최신인가"로 범위를 좁히지 않는다 — 사람이 손으로 다시 blocked을 만들며
 * origin 마커를 새로 남기면, 옛 재점화 마커는 "그 이전 것"이 돼 무한히 다시 밀리는 루프가 된다.
 * "이슈+스테이지당 평생 한 번"이 이 마커의 계약이다.
 */
export const blockedRetryComment = (stage, issue) => `<!-- factory-sweeper blocked-retry stage=${stage} issue=${issue} -->`;

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
async function sweepStalled({ gh, nowMs, staleMinutes, dispatchStage, backPressure, actions }) {
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
        const restarted = comments.filter((c) => String(c?.body ?? "").includes(marker)).at(-1);
        if (restarted && nowMs - Date.parse(restarted.createdAt) <= stale) continue;
        // 흐름 제어로 세워 둔 `factory:planned`는 멈춘 것이 아니다(M5) — 조용히 넘어간다.
        if (stage === "implement") {
          const reason = await parked();
          if (reason) { actions.push({ kind: "stalled-restart-skipped", issue: it.number, stage, label, reason: `back-pressure — ${reason}` }); continue; }
        }
        // 마커를 **먼저** 남긴다(M4). dispatch가 성공한 뒤에 코멘트가 실패하면 dedupe의 유일한 근거가
        // 사라져 다음 sweep이 30분마다 같은 스테이지를 또 민다 — 재점화는 비싸고(plan 한 번 ~$12)
        // 놓친 재점화는 사람이 `--remote`로 되살릴 수 있으므로, 실패는 **덜 재시작하는 쪽**으로 기운다.
        await gh.comment(it.number, `${marker}\n\`${label}\`에서 ${staleMinutes}분 넘게 런 없이 멈춰 있었습니다 — \`factory-${stage}.yml\`을 dispatch로 다시 띄웁니다(KTB-8).`);
        await dispatchStage({ stage, issue: it.number });
        actions.push({ kind: "stalled-restart", issue: it.number, stage, label });
      } catch (e) {
        actions.push({ kind: "error", step: "stalled-restart", issue: it.number, error: String(e.message || e) });
      }
    }
  }
}

const LABEL_SET_REPAIR_TARGET = "factory:needs-human";
/** 라벨-셋 복구 마커 — 이 조합을 이미 알렸는지의 유일한 근거(dedupe). */
export const labelSetRepairedComment = (found) => `<!-- factory-label-set-repaired from=${found.join(",")} -->`;

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
      const marker = labelSetRepairedComment(found);
      const comments = await gh.comments(it.number);
      if (comments.some((c) => String(c?.body ?? "").includes(marker))) {
        actions.push({ kind: "label-set-repair-skipped", issue: it.number, reason: "already repaired" });
        continue;
      }
      await gh.setFactoryLabel(it.number, LABEL_SET_REPAIR_TARGET);
      await gh.comment(it.number, `${marker}\n이 이슈에 factory 상태 라벨이 ${found.length}개(${found.join(", ")}) 붙어 있었습니다 — sweeper가 \`${LABEL_SET_REPAIR_TARGET}\`로 정리했습니다(다른 상태 라벨은 제거, tier 라벨은 유지). 사람이 확인한 뒤 \`:unstick\`으로 재개하세요.`);
      actions.push({ kind: "label-set-repaired", issue: it.number, from: found });
    } catch (e) {
      actions.push({ kind: "error", step: "label-set-repair", issue: it.number, error: String(e.message || e) });
    }
  }
}

export async function sweep({ gh, charter, thresholds, now, staleMinutes = 30, transition, release, quarantine, saveQuarantine, tokenIssuedAt = null, dispatchStage = null, backPressure = null }) {
  const actions = [];
  const nowMs = Date.parse(now);
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
      if (dispatchStage) {
        const comments = await gh.comments(it.number);
        const origin = blockedOrigin(comments);
        const retryStage = origin && BLOCKED_RETRY_STAGE[origin.from];
        if (retryStage) {
          const marker = blockedRetryComment(retryStage, it.number);
          const alreadyRetried = comments.some((c) => String(c?.body ?? "").includes(marker));
          if (!alreadyRetried) {
            // 마커를 먼저 남긴다(stalled 팔과 같은 이유 — M4). dispatch 실패는 다음 sweep이 다시 시도한다.
            await gh.comment(it.number, `${marker}\n\`factory:blocked\`이 \`${origin.from}\`에서 왔습니다 — 그 마지막 한 걸음만 실패했을 수 있어 \`factory-${retryStage}.yml\`을 한 번 다시 띄웁니다(KTB-15b). 여전히 blocked이면 다음 sweep에서 사람에게 넘어갑니다.`);
            await dispatchStage({ stage: retryStage, issue: it.number });
            actions.push({ kind: "blocked-retry", issue: it.number, stage: retryStage });
            continue;
          }
        }
      }
      await transition({ issue: it.number, to: "factory:needs-human", reason: "blocked (environment/credentials) — needs human" });
      actions.push({ kind: "blocked-escalated", issue: it.number });
    } catch (e) {
      actions.push({ kind: "error", issue: it.number, error: String(e.message || e) });
    }
  }
  await sweepStalled({ gh, nowMs, staleMinutes, dispatchStage, backPressure, actions });
  await sweepLabelSetRepair({ gh, actions });
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
