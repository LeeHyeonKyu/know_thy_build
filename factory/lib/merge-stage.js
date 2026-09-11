import { verdictLine } from "./gates.js";
import { isMergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON } from "./blocked-errors.js";
import { isGitDiffError } from "./changed-files.js";

/** GitHub은 mergeable을 비동기로 계산한다 — UNKNOWN은 "영영 모름"이 아니라 "아직 안 끝남"이다.
 * 한 번만 재확인한다: 그사이 끝나면 믿고, 아니면 사람이 본다(무한정 기다리지 않는다). */
const MERGEABILITY_REPOLL_MS = 5000;

/**
 * merge 스테이지는 claude -p를 부르지 않는다 — PR이 이미 approved다, 여기서 물을 건 "지금 이 순간
 * 머지해도 되는가"뿐이다: PR이 열려 있는가, 충돌은 없는가, 게이트는 GREEN인가, 필수 체크와 무결성은
 * 확인됐는가. 전부 통과해야만 gh pr merge를 부른다 — 머지는 되돌릴 수 없으므로 매 단계 fail closed.
 *
 * d: prInfo() → PR view(number,state,mergeable,…) | null, gates() → factory.gates.v1 | null (null은 "통과"가
 *    아니라 **판정 없음**이다 — needs-human "gates missing at merge"로 떨어진다. MergeBaseError/
 *    GitDiffError를 던질 수 있다), mergeGates() → { checksGreen, integrityGreen } (마찬가지),
 *    mergePr(pr), transition({to,reason,mergeGatesResult?}), closeIssue(pr), sleep?(ms).
 * headSha: review·merge가 checkoutHead로 고정한 PR head — 없으면 gates().head_sha로 대신한다(둘 다
 * 없으면 "unknown"으로 남긴다. 아무것도 지어내지 않는다).
 * postStatus({context,state,description,sha}): run-stage의 상태 게시 헬퍼(no-sha skip + best-effort 포함) —
 * 여기서 다시 구현하지 않고 그대로 주입받는다.
 * record(lines): run-record 한 줄(들)을 남긴다. refusal(t): 거부된 전이를 record 줄로 바꾼다(runStage와 동일 계약).
 */
export async function runMergeStage({ issue, defaultBranch, headSha, d, record, refusal, postStatus }) {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // (1) PR이 없거나 열려 있지 않으면 머지할 대상이 없다 — 사람이 봐야 한다.
  const info = await d.prInfo();
  if (!info || info.state !== "OPEN") {
    const reason = info ? `PR #${info.number} state is ${info.state}, not OPEN` : "no PR found in the implement handoff";
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: prInfo — ${reason}`, ...refusal(t)]);
    return 2;
  }
  const pr = info.number;
  record([`merge: PR #${pr} is OPEN`]);

  // (2) mergeability. GitHub은 이를 비동기로 계산한다 — UNKNOWN은 한 번 재확인한 뒤에야 판단한다.
  // CONFLICTING은 rebase가 필요하니 rework로; 재확인해도 MERGEABLE이 아니면 사람이 본다.
  let cur = info;
  if (cur.mergeable === "UNKNOWN") {
    await sleep(MERGEABILITY_REPOLL_MS);
    cur = (await d.prInfo()) || cur;
    record([`merge: mergeability UNKNOWN — re-polled, now ${cur.mergeable}`]);
  }
  if (cur.mergeable === "CONFLICTING") {
    const reason = `merge conflict — rebase onto ${defaultBranch}`;
    const t = await d.transition({ to: "factory:rework", reason });
    record([`merge: PR #${pr} conflicting`, ...refusal(t)]);
    return 2;
  }
  if (cur.mergeable !== "MERGEABLE") {
    const reason = "mergeability unknown after re-poll";
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: mergeability ${cur.mergeable} — needs-human`, ...refusal(t)]);
    return 2;
  }
  record([`merge: PR #${pr} not conflicting (${cur.mergeable})`]);

  // (3) 게이트: BLOCKED은 판정 불가(사람이 본다), 그 외 GREEN이 아니면 needs-human. base/diff를 못 구한
  // 것도 판정 불가다(run-stage의 나머지 스테이지와 같은 typed-error 계약). 상태 게시는 부수 효과라
  // 실패해도(또는 diagnostic 결과여도) 머지 판단을 막지 않는다 — postStatus 자체가 best-effort다.
  let gates;
  try {
    gates = await d.gates();
  } catch (e) {
    if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
    const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: gates BLOCKED — ${e.message}`, ...refusal(t)]);
    return 2;
  }
  if (gates && gates.diagnostic !== true && postStatus) {
    await postStatus({ context: "factory/gates", state: gates.status === "GREEN" ? "success" : "failure", description: verdictLine(gates), sha: gates.head_sha });
  }
  if (gates?.status === "BLOCKED") {
    const reason = gates.blocked_reason || "gates could not be decided";
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: gates BLOCKED — ${reason}`, ...refusal(t)]);
    return 2;
  }
  // gates가 아예 없는 것(null/undefined)은 "통과"가 아니라 **판정 없음**이다 — 게이트 파일이
  // 만들어지지 않았거나 이 런에서 게이트가 돌지 않았다는 뜻이고, 머지는 되돌릴 수 없으므로
  // 확인되지 않은 것을 통과로 읽지 않는다(fail closed, §merge gate와 같은 원칙).
  if (!gates || gates.status !== "GREEN") {
    const reason = `gates ${gates?.status ?? "missing"} at merge`;
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: gates ${gates?.status ?? "missing"}`, ...refusal(t)]);
    return 2;
  }
  record([`merge: gates ${gates.status}`]);

  // (4) 필수 체크와 무결성 — 조회 자체가 안 됐으면 플래그가 서지 않는다(fail closed). 둘 다 실패면
  // 두 이유를 모두 남긴다 — 하나만 말하면 사람이 나머지 원인을 못 보고 재시도한다.
  let mg;
  try {
    mg = await d.mergeGates();
  } catch (e) {
    if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
    const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: mergeGates BLOCKED — ${e.message}`, ...refusal(t)]);
    return 2;
  }
  if (!mg?.checksGreen || !mg?.integrityGreen) {
    const reasons = [];
    if (!mg?.checksGreen) reasons.push("required checks not GREEN");
    if (!mg?.integrityGreen) reasons.push("integrity not GREEN");
    const reason = reasons.join("; ");
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: mergeGates — ${reason}`, ...refusal(t)]);
    return 2;
  }
  record(["merge: mergeGates — checks GREEN, integrity GREEN"]);

  // (5) 실제 머지. gh 호출 실패는 blocked로 세운다 — needs-human이 아니라 blocked인 건 아직
  // 머지되지 않았고(irreversible 아님) 재시도 판단이 필요해서다.
  const sha = headSha || gates?.head_sha || null;
  record([`merge: head ${sha ? sha.slice(0, 7) : "unknown"}`]);
  try {
    await d.mergePr(pr);
  } catch (e) {
    const reason = `merge API failed: ${e?.message || e}`;
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: mergePr FAIL — ${reason}`, ...refusal(t)]);
    return 2;
  }
  record([`merge: merged ${sha ? sha.slice(0, 7) : "unknown"} via PR #${pr}`]);

  // (6) 라벨 전이. 이 시점부터는 되돌릴 수 없다 — 거부돼도 needs-human 코멘트는 transition() 자신이
  // 남기므로 여기서는 record만 하고 계속 진행한다(이슈는 그래도 닫는다).
  const t = await d.transition({ to: "factory:merged", mergeGatesResult: mg });
  record([...(t.ok ? [`transition: ${t.to}`] : refusal(t))]);

  // (7) 추적 이슈를 닫는다 — 코드는 이미 머지됐다. 이것도 실패해도 머지 자체는 되돌릴 게 없으므로
  // 흔적만 남기고 성공으로 끝낸다.
  try {
    await d.closeIssue(pr);
    record([`merge: issue #${issue} closed via PR #${pr}`]);
  } catch (e) {
    record([`merge: issue close failed — ${e?.message || e}`]);
  }

  return 0;
}
