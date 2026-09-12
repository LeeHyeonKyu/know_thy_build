import { verdictLine } from "./gates.js";
import { isMergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON } from "./blocked-errors.js";
import { isGitDiffError } from "./changed-files.js";
import { LESSONS_POLICY_RULE as LESSONS_RULE_RE } from "./integrity.js";

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
 *    mergePr(pr), transition({to,reason,mergeGatesResult?}), closeIssue(pr), sleep?(ms),
 *    protectedPaths() → { ok, files, reason? } (KTB-5 — base 브랜치 코드로 계산한 보호 경로 목록),
 *    policyViolations() → { ok, files, reason? } (KTB-6 — `additive_only` 섹션 규칙을 벗어난 역할 파일).
 *    둘 다 ok:false거나 dep이 없으면 "위반 없음"이 아니라 **판정 불가**라 blocked다.
 *    comment?(number, body) → 그 번호(여기서는 PR)에 코멘트(best-effort).
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

  // (3) 보호 경로가 PR 범위에 있으면 **자동 머지는 없다** — 사람이 머지한다(KTB-5, §5.1/ADR-020).
  // L0의 `factory/integrity` 체크는 변조만 RED로 만든다(보호 경로 변경은 알림일 뿐) — 그렇지
  // 않으면 required context가 그것 하나뿐이라 사람의 머지까지 영영 막힌다. 그래서 "봇은 못 하고
  // 사람은 할 수 있다"는 구분을 여기, 자동 머지 경로 안에 둔다.
  //
  // **게이트보다 먼저다**(fix round 1). `d.gates()`는 `harness.commands`를 bash로 실행한다 — 곧 PR이
  // 쓴 코드를 머지 잡 안에서 돌린다. 보호 경로를 실은 PR은 애초에 자동 머지 후보가 아니므로, 그
  // 코드를 **한 줄도 실행하기 전에** 거른다. (게이트가 돌 때도 자격증명은 자식 env에서 빠진다 —
  // `lib/exec.js`의 `scrubEnv`, `lib/gates.js`가 감싼다.)
  //
  // 이 판정은 **base 브랜치의 코드**로 계산된다: 이 프로세스의 모듈은 checkoutHead보다 먼저,
  // 워크플로의 기본 체크아웃(base) 상태에서 로드됐고 harness도 그때 읽혔다(run-stage.js의
  // charterReady). PR의 `.factory/bin/integrity.js`를 하위 프로세스로 부르지 않는 이유가 이것이다 —
  // 그랬다면 에이전트 PR이 자기 자신을 화이트리스트하는 integrity를 실어 보낼 수 있다.
  //
  // 계산 자체가 안 된 것(git 실패·merge-base 없음·dep 미배선)은 GREEN도 RED도 아닌 **판정 불가**라
  // `factory:blocked`다 — 게이트·mergeGates의 typed-error와 같은 처리다(needs-human은 "사람이
  // 판단할 것이 있다"는 뜻이고, 여기서는 판단할 재료 자체가 없다).
  //
  // 두 정책을 같은 자리에서 묻는다: 보호 경로(KTB-5)와 역할 파일의 섹션 규칙(KTB-6). 둘 다
  // "이 diff가 틀렸다"가 아니라 "이 diff는 사람이 머지해야 한다"이고, 거부의 모양도 같다.
  //
  // 사유는 **이슈**의 전이 코멘트로 간다(한 줄 포인터: 어느 PR을 사람이 봐야 하는지). 상세 코멘트는
  // **PR**에 붙는다 — 사람이 머지 버튼을 누르는 자리가 거기이고, 본문이 그 diff를 가리키기 때문이다.
  // 코멘트는 부수 효과다 — 실패해도 거부 자체를 잃지 않는다(전이 코멘트가 사유를 이미 싣는다).
  //
  // `sections`는 **규칙별로** 하나씩이다(KTB-10 I3): 한 PR이 두 규칙을 동시에 어길 수 있고(역할 파일
  // 편집 + lessons 삭제), 그때 한 제목으로 뭉치면 사람이 목록의 절반을 엉뚱한 설명으로 읽는다.
  const handToHuman = async ({ reason, sections }) => {
    try {
      await d.comment?.(pr, [
        ...sections.flatMap(({ heading, why, files }) => [
          `**${heading} — 팩토리가 자동 머지하지 않습니다.**`, "", ...why, "",
          ...files.map((f) => `- \`${f}\``), "",
        ]),
        "diff를 확인한 뒤 사람이 직접 머지해 주세요 — `factory/integrity` 체크는 변조만 보므로 GREEN일 수 있습니다.",
        `추적 이슈 #${issue}는 \`factory:needs-human\`으로 옮겼습니다.`,
      ].join("\n"));
    } catch (e) { record([`merge: human-merge comment failed — ${e?.message || e}`]); }
    const t = await d.transition({ to: "factory:needs-human", reason: `${reason} (see PR #${pr})` });
    record([`merge: ${reason}`, ...refusal(t)]);
    return 2;
  };
  const undecidable = async (what, reason) => {
    const line = `${what} could not be computed: ${reason || "unknown"}`;
    const t = await d.transition({ to: "factory:blocked", reason: line });
    record([`merge: ${line}`, ...refusal(t)]);
    return 2;
  };

  const prot = d.protectedPaths ? await d.protectedPaths() : { ok: false, files: [], reason: "protectedPaths dep not wired" };
  if (!prot?.ok) return await undecidable("protected-path check", prot?.reason);
  if (prot.files.length) {
    return await handToHuman({
      reason: `protected paths changed — human merge required: ${prot.files.join(", ")}`,
      sections: [{
        heading: "보호 경로 변경",
        why: [
          "이 PR은 `[protected].factory` 경로를 바꿉니다. 게이트 정의·워크플로·CHARTER의 변경은",
          "사람의 판단이 곧 판결이라, 팩토리가 스스로 머지하지 않고 사람에게 넘깁니다(ADR-020).",
          "", "변경된 보호 경로:",
        ],
        files: prot.files,
      }],
    });
  }
  record(["merge: no protected paths in the PR range"]);

  // 역할 파일의 섹션 규칙(KTB-6). `[protected].additive_only`는 "`.claude/agents/*.md`는 `## Examples`·
  // `## Perspectives`에 **추가만**"이라는 정책이다 — retro의 다크 추가(§8.1)가 통과하는 좁은 문이고,
  // 그 밖의 편집은 역할의 정의를 바꾸는 일이라 사람이 봐야 한다. 보호 경로와 달리 섹션 판정에는
  // 파일 내용이 필요한데, `policyViolations`는 워킹 트리가 아니라 `git show <rev>:<file>`로 읽는다.
  const pol = d.policyViolations ? await d.policyViolations() : { ok: false, files: [], reason: "policyViolations dep not wired" };
  if (!pol?.ok) return await undecidable("agent-section policy check", pol?.reason);
  // 거부 사유가 두 종류다 — 한 제목으로 뭉치면 사람이 엉뚱한 곳을 본다(KTB-10 I3). `policyViolations`는
  // `additive_only` 규칙 위반과 **사라진 lessons 파일**(`.factory/lessons/**`의 삭제·이동)을 같은
  // `violations` 배열에 싣는데, 둘은 원인도 사람이 해야 할 일도 다르다: 앞은 역할 정의를 바꾼 diff이고,
  // 뒤는 누적된 교훈이 통째로 사라지는 diff다. 그래서 파일 목록을 규칙으로 갈라 각자의 제목으로 낸다.
  if (pol.files.length) {
    const lessons = [...new Set((pol.violations || []).filter((v) => LESSONS_RULE_RE.test(v.rule)).map((v) => v.file))];
    const additive = pol.files.filter((f) => !lessons.includes(f));
    const sections = [], reasons = [];
    if (additive.length) {
      reasons.push(`agent role sections edited outside Examples/Perspectives — human merge required: ${additive.join(", ")}`);
      sections.push({
        heading: "역할 프롬프트의 허용 섹션 밖 편집",
        why: [
          "`.claude/agents/*.md`는 `## Examples`·`## Perspectives`에 **추가만** 허용됩니다",
          "(`[protected].additive_only`). 그 밖의 편집은 역할의 정의를 바꾸는 일이라, 팩토리가",
          "스스로 머지하지 않고 사람에게 넘깁니다(ADR-020 KTB-6).",
          "", "허용 섹션 밖에서 바뀐 파일:",
        ],
        files: additive,
      });
    }
    if (lessons.length) {
      reasons.push(`lessons files deleted or moved away — human merge required: ${lessons.join(", ")}`);
      sections.push({
        heading: "lessons 파일 삭제/이동",
        why: [
          "`.factory/lessons/**`는 retro가 쌓아 온 교훈의 유일한 저장소입니다. 삭제·이동은 `[protected].except`라",
          "L0 `factory/integrity`에도, 내용 규칙(사라진 파일은 읽을 내용이 없다)에도 걸리지 않아 **아무 신호 없이**",
          "빠져나갈 수 있습니다. 역할을 은퇴시키며 지우는 것은 정상 작업이라 변조로 다루지는 않지만,",
          "무엇이 사라지는지는 사람이 보고 머지해야 합니다(ADR-020 KTB-10).",
          "", "사라진 lessons 파일:",
        ],
        files: lessons,
      });
    }
    return await handToHuman({ reason: reasons.join("; "), sections });
  }
  record(["merge: agent role sections within policy"]);

  // (4) 게이트: BLOCKED은 판정 불가(사람이 본다), 그 외 GREEN이 아니면 needs-human. base/diff를 못 구한
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

  // (5) 필수 체크와 무결성 — 조회 자체가 안 됐으면 플래그가 서지 않는다(fail closed). 둘 다 실패면
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

  // (6) 실제 머지. gh 호출 실패는 blocked로 세운다 — needs-human이 아니라 blocked인 건 아직
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

  // (7) 라벨 전이. 이 시점부터는 되돌릴 수 없다 — 거부돼도 needs-human 코멘트는 transition() 자신이
  // 남기므로 여기서는 record만 하고 계속 진행한다(이슈는 그래도 닫는다).
  const t = await d.transition({ to: "factory:merged", mergeGatesResult: mg });
  record([...(t.ok ? [`transition: ${t.to}`] : refusal(t))]);

  // (8) 추적 이슈를 닫는다 — 코드는 이미 머지됐다. 이것도 실패해도 머지 자체는 되돌릴 게 없으므로
  // 흔적만 남기고 성공으로 끝낸다.
  try {
    await d.closeIssue(pr);
    record([`merge: issue #${issue} closed via PR #${pr}`]);
  } catch (e) {
    record([`merge: issue close failed — ${e?.message || e}`]);
  }

  return 0;
}
