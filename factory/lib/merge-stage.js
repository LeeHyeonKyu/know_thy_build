import { verdictLine } from "./gates.js";

/**
 * merge 스테이지는 claude -p를 부르지 않는다 — PR이 이미 approved다, 여기서 물을 건 "지금 이 순간
 * 머지해도 되는가"뿐이다: PR이 열려 있는가, 충돌은 없는가, 게이트는 GREEN인가, 필수 체크와 무결성은
 * 확인됐는가. 전부 통과해야만 gh pr merge를 부른다 — 머지는 되돌릴 수 없으므로 매 단계 fail closed.
 *
 * d: prInfo() → PR view(number,state,mergeable,…) | null, gates() → factory.gates.v1 | null,
 *    mergeGates() → { checksGreen, integrityGreen }, mergePr(pr), transition({to,reason,mergeGatesResult?}),
 *    closeIssue(pr), reportStatus?({context,state,description,sha}).
 * record(lines): run-record 한 줄(들)을 남긴다. refusal(t): 거부된 전이를 record 줄로 바꾼다(runStage와 동일 계약).
 */
export async function runMergeStage({ issue, defaultBranch, d, record, refusal }) {
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

  // (2) 충돌은 게이트로 잡을 수 없다 — rebase가 필요하니 rework로 돌려보낸다.
  if (info.mergeable === "CONFLICTING") {
    const reason = `merge conflict — rebase onto ${defaultBranch}`;
    const t = await d.transition({ to: "factory:rework", reason });
    record([`merge: PR #${pr} conflicting`, ...refusal(t)]);
    return 2;
  }
  record([`merge: PR #${pr} not conflicting (${info.mergeable})`]);

  // (3) 게이트: BLOCKED은 판정 불가(사람이 본다), 그 외 GREEN이 아니면 needs-human. 상태 게시는
  // 부수 효과라 실패해도 머지 판단을 막지 않는다(best-effort).
  const gates = await d.gates();
  if (gates && d.reportStatus) {
    try {
      await d.reportStatus({ context: "factory/gates", state: gates.status === "GREEN" ? "success" : "failure", description: verdictLine(gates), sha: gates.head_sha });
    } catch (e) { record([`status: factory/gates post failed — ${e?.message || e}`]); }
  }
  if (gates?.status === "BLOCKED") {
    const reason = gates.blocked_reason || "gates could not be decided";
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: gates BLOCKED — ${reason}`, ...refusal(t)]);
    return 2;
  }
  if (gates && gates.status !== "GREEN") {
    const reason = `gates ${gates.status} at merge`;
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: gates ${gates.status}`, ...refusal(t)]);
    return 2;
  }
  record([`merge: gates ${gates ? gates.status : "none"}`]);

  // (4) 필수 체크와 무결성 — 조회 자체가 안 됐으면 플래그가 서지 않는다(fail closed). 어느 쪽이
  // 문제인지 이름을 남긴다: 체크를 먼저 본다.
  const mg = await d.mergeGates();
  if (!mg?.checksGreen || !mg?.integrityGreen) {
    const reason = !mg?.checksGreen ? "required checks not GREEN" : "integrity not GREEN";
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: mergeGates — ${reason}`, ...refusal(t)]);
    return 2;
  }
  record([`merge: mergeGates — checks GREEN, integrity GREEN`]);

  // (5) 실제 머지. gh 호출 실패는 blocked로 세운다 — needs-human이 아니라 blocked인 건 아직
  // 머지되지 않았고(irreversible 아님) 재시도 판단이 필요해서다.
  try {
    await d.mergePr(pr);
  } catch (e) {
    const reason = `merge API failed: ${e?.message || e}`;
    const t = await d.transition({ to: "factory:blocked", reason });
    record([`merge: mergePr FAIL — ${reason}`, ...refusal(t)]);
    return 2;
  }
  record([`merge: PR #${pr} merged via API`]);

  // (6) 라벨 전이. 이 시점부터는 되돌릴 수 없다 — 거부돼도 needs-human 코멘트는 transition() 자신이
  // 남기므로 여기서는 record만 하고 계속 진행한다(이슈는 그래도 닫는다).
  const t = await d.transition({ to: "factory:merged", mergeGatesResult: mg });
  record([...(t.ok ? [`transition: ${t.to}`] : refusal(t))]);

  // (7) 추적 이슈를 닫는다 — 코드는 이미 머지됐다.
  await d.closeIssue(pr);
  record([`merge: issue #${issue} closed via PR #${pr}`]);

  return 0;
}
