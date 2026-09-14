import { verdictLine } from "./gates.js";
import { isMergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON } from "./blocked-errors.js";
import { isGitDiffError } from "./changed-files.js";
import { LESSONS_POLICY_RULE as LESSONS_RULE_RE } from "./integrity.js";
import { blockedOriginMarker } from "./retro/issue-comments.js";
import { parseBlocks } from "./harness-request.js";

/** GitHub은 mergeable을 비동기로 계산한다 — UNKNOWN은 "영영 모름"이 아니라 "아직 안 끝남"이다.
 * 한 번만 재확인한다: 그사이 끝나면 믿고, 아니면 사람이 본다(무한정 기다리지 않는다). */
const MERGEABILITY_REPOLL_MS = 5000;

/**
 * KTB-15b I1 / KTB-19 — draft→ready 플립(`gh pr ready`, 아래 (6a))은 GitHub의 `ready_for_review` PR
 * 이벤트를 만든다. 이 저장소 자신의 워크플로는 그 이벤트를 듣지 않도록 고쳤지만(`factory-integrity.yml`,
 * yml-lint의 `ready-for-review-trigger` 규칙), **대상 저장소**(팩토리가 설치된 다른 레포)는 그
 * 이벤트에 반응하는, 팩토리가 모르는 자신만의 필수 체크 워크플로를 달아 뒀을 수 있다 — 그러면
 * diff는 그대로인데 머지 직전에 새 체크 런이 또 시작된다.
 *
 * KTB-19(데모 #8 재시도): 처음에는 이걸 `mergeGates()`를 몇 번 다시 부르는 것으로만 재확인했는데
 * (고정 3회·10초 간격), 그 방식은 **체크가 아직 queued인 채로 재확인 창이 끝나버리면** 그대로
 * blocked였다 — PR 브랜치가 업그레이드 전의 낡은 `integrity.yml`(`ready_for_review` 트리거 포함)을
 * 그대로 갖고 있었고, ready 플립이 새 필수 체크를 막 밀어 넣은 참이었다. 그래서 이제는 재확인
 * "횟수"가 아니라 **필수 체크가 더 이상 진행 중이 아닐 때까지** 기다린다(queued/pending/in_progress가
 * 하나도 없을 때까지, `harness.factory.merge_check_wait_sec` 만큼 상한, `MERGE_CHECK_POLL_INTERVAL_MS`
 * 간격) — 그런 뒤에만 GREEN/RED를 판정한다. 그래도 닫히지 않는 틈은 남는다: `gh pr checks`가 아직
 * **존재하지도 않는** 체크 런을 볼 수는 없다(대상 저장소가 그 이벤트에 반응해 체크를 만드는 데
 * 걸리는 지연). 그 마지막 틈의 방어선은 이 폴링이 아니라 **브랜치 보호**다 — 그 체크가 실제로
 * required로 걸려 있다면 아직 없는 채로 `gh pr merge`가 불려도 GitHub 쪽에서 거부되고, 그 실패는
 * 아래 (6)에서 `factory:blocked`로 떨어져 재시도(§KTB-15b)로 풀린다.
 */
const MERGE_CHECK_POLL_INTERVAL_MS = 15000;
const DEFAULT_MERGE_CHECK_WAIT_SEC = 600;

/** `gh pr checks`의 한 체크가 아직 끝나지 않았는가 — `bucket`(최신 gh)과 원시 `state` 둘 다 받는다. */
const CHECK_RUNNING_STATES = new Set(["queued", "pending", "in_progress"]);
function checkStillRunning(check) {
  if (check?.bucket === "pending") return true;
  return CHECK_RUNNING_STATES.has(String(check?.state ?? "").toLowerCase());
}
function checkPassed(check) {
  return check?.bucket ? check.bucket === "pass" : String(check?.state ?? "").toUpperCase() === "SUCCESS";
}
/** `required`가 있으면 그 이름의 체크만, 없으면 전부 — `allChecksGreen`(lib/gh.js)과 같은 필터 규칙. */
function relevantChecks(checks, required) {
  return required ? checks.filter((c) => required.includes(c.name)) : checks;
}

/**
 * KTB-19 — ready 플립 뒤 필수 체크가 더 이상 queued/pending/in_progress가 아닐 때까지 기다린다.
 * 첫 조회는 즉시(대개 이미 안정돼 있다 — 대상 저장소가 `ready_for_review`를 안 듣거나 이미 ready).
 * `waitSec` 안에 안정되지 않으면 `{ ok:false, timeout:true }` — pending인 채로 시간 초과.
 * 안정되면(전부 진행 중이 아니면) `{ ok:true, checks }` — GREEN/RED 판정은 호출자 몫이다.
 */
async function waitForChecksSettled({ prChecks, pr, required, sleep, waitSec = DEFAULT_MERGE_CHECK_WAIT_SEC, intervalMs = MERGE_CHECK_POLL_INTERVAL_MS }) {
  const attempts = Math.max(1, Math.ceil((waitSec * 1000) / intervalMs));
  let checks = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    checks = await prChecks(pr);
    if (!relevantChecks(checks, required).some(checkStillRunning)) return { ok: true, checks };
  }
  return { ok: false, timeout: true, checks };
}

/**
 * merge 스테이지는 claude -p를 부르지 않는다 — PR이 이미 approved다, 여기서 물을 건 "지금 이 순간
 * 머지해도 되는가"뿐이다: PR이 열려 있는가, 충돌은 없는가, 게이트는 GREEN인가, 필수 체크와 무결성은
 * 확인됐는가. 전부 통과해야만 gh pr merge를 부른다 — 머지는 되돌릴 수 없으므로 매 단계 fail closed.
 *
 * d: prInfo() → PR view(number,state,mergeable,…) | null, gates() → factory.gates.v1 | null (null은 "통과"가
 *    아니라 **판정 없음**이다 — needs-human "gates missing at merge"로 떨어진다. MergeBaseError/
 *    GitDiffError를 던질 수 있다), mergeGates() → { checksGreen, integrityGreen } (마찬가지),
 *    prReady?(pr) — draft PR을 ready로 뒤집는다(KTB-15; mergePr 직전. 없으면 건너뛰고 기록만 남긴다),
 *    mergePr(pr), transition({to,reason,mergeGatesResult?}), closeIssue(pr), sleep?(ms),
 *    twoActor?(bool) + approvePr?(pr) — ADR-021 두 배우 모드: base 브랜치가 승인 1건을 요구하므로
 *    머지 배우(`FACTORY_MERGE_TOKEN`)가 머지 **직전에** 승인한다. 단일 배우 모드면 `twoActor`가
 *    falsy이고 이 경로는 통째로 없다(오늘까지의 동작 그대로),
 *    protectedPaths() → { ok, files, reason? } (KTB-5 — base 브랜치 코드로 계산한 보호 경로 목록),
 *    policyViolations() → { ok, files, reason? } (KTB-6 — `additive_only` 섹션 규칙을 벗어난 역할 파일).
 *    둘 다 ok:false거나 dep이 없으면 "위반 없음"이 아니라 **판정 불가**라 blocked다.
 *    comment?(number, body) → 그 번호(여기서는 PR)에 코멘트(best-effort).
 * headSha: review·merge가 checkoutHead로 고정한 PR head — 없으면 gates().head_sha로 대신한다(둘 다
 * 없으면 "unknown"으로 남긴다. 아무것도 지어내지 않는다).
 * postStatus({context,state,description,sha}): run-stage의 상태 게시 헬퍼(no-sha skip + best-effort 포함) —
 * 여기서 다시 구현하지 않고 그대로 주입받는다.
 * record(lines): run-record 한 줄(들)을 남긴다. refusal(t): 거부된 전이를 record 줄로 바꾼다(runStage와 동일 계약).
 * retryFromBlocked(KTB-15b, KTB-19 review I-2): run-stage가 이미 "이 blocked이 approved에서 왔다"를
 * 이슈 코멘트로 확인했을 때, 그 origin 라벨(`"factory:approved"`) 그대로 넘긴다 — falsy(`false`)면
 * 재시도가 아니다. 여기서는 그 사실을 다시 검증하지 않고, 게이트가 다시 GREEN으로 확인되는 시점
 * (아래 (4) 직후, (4b))에 라벨을 `factory:approved`로 되돌린다. 그래야 (7)의 `approved → merged`
 * 전이가 그래프를 통과한다(`factory:blocked → factory:merged` 엣지는 없다 — 머지 재시도는 반드시
 * approved를 거쳐야 한다). 그 전이가 거부되면(이론상 그 사이 다른 사람이 라벨을 옮겼을 때) 나머지
 * 단계는 돌지 않는다 — 머지는 아직 일어나지 않았으므로 되돌릴 것이 없다.
 *
 * (4b) **이전**에는 이슈 라벨이 여전히 `factory:blocked`다 — 그런데 그 사이(protectedPaths·
 * policyViolations·gates)에서 또 판정 불가/BLOCKED가 나면, "전이"는 `factory:blocked → factory:blocked`
 * 자기 자신이 된다. 이 그래프는 자기 전이를 두지 않으므로(다른 어떤 상태도 자신에게 돌아가지 않는다)
 * `canTransition`이 거부하고, 그러면 진짜 사유(게이트 BLOCKED 등) 대신 "그래프가 이 전이를 허용하지
 * 않는다"는 엉뚱한 코멘트가 남는다. `toBlocked()` 헬퍼가 이 경우를 가른다: 라벨을 안 바꾸는 것
 * 자체가 맞는 결과이므로 전이를 부르지 않고 기록만 남기되, `factory-blocked-origin` 마커는
 * (transition()을 안 거치므로) 직접 새로 남긴다 — sweeper의 blocked 팔이 여전히 유효한 origin을 본다.
 */
export async function runMergeStage({ issue, defaultBranch, headSha, d, record, refusal, postStatus, retryFromBlocked = false }) {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let leftBlocked = !retryFromBlocked;             // 재시도가 아니면 애초에 "여전히 blocked"인 특수 케이스가 없다
  /**
   * `factory:blocked` 목표로 가는 모든 전이는 이 헬퍼를 거친다(KTB-19 review I-2). 재시도 중이고
   * 아직 approved로 돌아가지 못했으면(위 doc 참고) 그래프를 부르지 않고 record + origin 마커
   * 재게시로 끝낸다 — 그 외에는 평소처럼 `d.transition`을 그대로 부른다.
   */
  const toBlocked = async (reason) => {
    if (!leftBlocked) {
      record([`blocked: still blocked — no self-transition (label unchanged): ${reason}`]);
      try { await d.comment?.(issue, `${blockedOriginMarker({ from: retryFromBlocked, stage: "merge" })}\n머지 재시도가 다시 판정 불가로 멈췄습니다 — 라벨은 그대로 \`factory:blocked\`입니다. 사유: ${reason}`); }
      catch (e) { record([`blocked: origin marker re-post failed — ${e?.message || e}`]); }
      return { ok: true, from: "factory:blocked", to: "factory:blocked" };
    }
    return d.transition({ to: "factory:blocked", reason });
  };

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
    const t = await toBlocked(line);
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
    const t = await toBlocked(reason);
    record([`merge: gates BLOCKED — ${e.message}`, ...refusal(t)]);
    return 2;
  }
  if (gates && gates.diagnostic !== true && postStatus) {
    await postStatus({ context: "factory/gates", state: gates.status === "GREEN" ? "success" : "failure", description: verdictLine(gates), sha: gates.head_sha });
  }
  // KTB-21 parity with run-stage (implement/review): `[factory.test.env].compose`가 있으면 게이트가
  // 명령을 돌리기 전에 env를 한 번 더 re-up했다(멱등) — 성공/실패 둘 다 run 기록에 남긴다. `ran`이
  // 없으면(=이 하네스는 compose를 안 쓴다) 아무 줄도 붙지 않는다. merge에도 같은 dep(gates())이
  // 붙어 있으므로 결과를 흘려버리지 않는다 — 아래 세 갈래(BLOCKED/비-GREEN/GREEN) 모두에 붙인다.
  const testEnvNote = gates?.test_env_reup?.ran
    ? [`test-env: re-up ${gates.test_env_reup.ok ? "ok" : `failed — ${gates.test_env_reup.detail}`}`]
    : [];
  if (gates?.status === "BLOCKED") {
    const reason = gates.blocked_reason || "gates could not be decided";
    const t = await toBlocked(reason);
    record([`merge: gates BLOCKED — ${reason}`, ...refusal(t), ...testEnvNote]);
    return 2;
  }
  // gates가 아예 없는 것(null/undefined)은 "통과"가 아니라 **판정 없음**이다 — 게이트 파일이
  // 만들어지지 않았거나 이 런에서 게이트가 돌지 않았다는 뜻이고, 머지는 되돌릴 수 없으므로
  // 확인되지 않은 것을 통과로 읽지 않는다(fail closed, §merge gate와 같은 원칙).
  if (!gates || gates.status !== "GREEN") {
    const reason = `gates ${gates?.status ?? "missing"} at merge`;
    const t = await d.transition({ to: "factory:needs-human", reason });
    record([`merge: gates ${gates?.status ?? "missing"}`, ...refusal(t), ...testEnvNote]);
    return 2;
  }
  record([`merge: gates ${gates.status}`, ...testEnvNote]);

  // (4b) KTB-15b: blocked에서 재시도된 런이면, 게이트가 방금 다시 GREEN으로 확인된 지금이 라벨을
  // approved로 되돌릴 유일하게 정당한 시점이다(위 doc comment 참고) — 아래 mergeGates·prReady·mergePr는
  // 그대로 이어간다. 이 전이가 거부되면 머지는 아직 일어나지 않았으므로 그대로 멈춘다.
  if (retryFromBlocked) {
    const t = await d.transition({ to: "factory:approved", reason: "merge retry from blocked — gates re-verified GREEN" });
    if (!t.ok) { record([...refusal(t)]); return 2; }
    leftBlocked = true;    // KTB-19 review I-2: from here on, a "→ factory:blocked" is a normal approved→blocked edge
    record([`transition: ${t.to}`]);
  }

  // (5) 필수 체크와 무결성 — 조회 자체가 안 됐으면 플래그가 서지 않는다(fail closed). 둘 다 실패면
  // 두 이유를 모두 남긴다 — 하나만 말하면 사람이 나머지 원인을 못 보고 재시도한다.
  let mg;
  try {
    mg = await d.mergeGates();
  } catch (e) {
    if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
    const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
    const t = await toBlocked(reason);
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

  // (6a) draft를 ready로 뒤집는다(KTB-15). implement는 일부러 `--draft`로 PR을 열지만
  // (리뷰 중인 PR을 사람이 실수로 머지하지 못하게 하는 신호다) 아무도 되돌리지 않았고, GitHub은
  // draft PR의 머지를 GraphQL 단에서 거부한다 — `gh pr merge failed (1): GraphQL: Pull Request is
  // still a draft`. 그래서 **어떤 PR도** 자동 머지될 수 없었다(데모 #8, 라운드 3).
  //
  // 자리가 여기인 것이 요점이다: 보호 경로·섹션 정책·게이트·필수 체크·무결성이 **전부** 통과한
  // 뒤, 머지 직전이다. 그 앞에 두면 거부된 PR이 ready로 남아 사람이 실수로 머지할 수 있게 된다 —
  // draft가 막으려던 바로 그 사고다. 이미 ready인 PR에 불러도 `gh pr ready`는 exit 0이므로 멱등이고,
  // 재시도 런이 상태를 따로 묻지 않는다.
  //
  // 실패는 머지 실패와 같은 등급(`factory:blocked`)이다 — 아직 머지되지 않았으므로 되돌릴 것이
  // 없고, 재시도로 풀릴 수 있다(재시도 경로: `factory run merge <n> --remote` — KTB-15b, run-stage의
  // 진입 가드가 이 blocked이 approved에서 왔는지 `factory-blocked-origin` 마커로 확인한다. sweeper의
  // blocked 팔도 같은 조건이면 사람보다 먼저 한 번 자동으로 이 경로를 시도한다).
  if (d.prReady) {
    // 불변식(KTB-15b I1): 이 호출 **자체가** `ready_for_review` 이벤트를 만들 수 있다(이미 ready인
    // PR이면 GitHub이 이벤트를 내지 않지만, 여기서는 어느 쪽인지 구분하지 않는다 — 구분해도 얻는 게
    // 없고, 아래 재확인은 이미 green인 경우 0회 추가 대기로 끝난다). 그래서 이 호출 뒤에는 gates도
    // mergeGates도 "아직 유효하다"고 그냥 믿지 않는다 — 아래에서 반드시 다시 확인한다.
    try {
      await d.prReady(pr);
      record([`merge: PR #${pr} ready for review`]);
    } catch (e) {
      const reason = `ready-for-review failed: ${e?.message || e}`;
      const t = await toBlocked(reason);
      record([`merge: prReady FAIL — ${reason}`, ...refusal(t)]);
      return 2;
    }

    // (6a-ii) KTB-15b I1 / KTB-19(데모 #8 재시도): ready로 뒤집은 직후 required checks·integrity를
    // 다시 확인한다 — 대상 저장소가 `ready_for_review`에 반응하는 자신만의 워크플로를 달아 뒀다면,
    // 방금 확인한 (5)의 GREEN이 이미 낡은 값일 수 있다. 고정 횟수 재확인(예전 방식)은 그 새 체크가
    // 재확인 창이 끝날 때까지도 `queued`이면 그대로 blocked였다 — 그래서 이제 "몇 번"이 아니라
    // **필수 체크가 더 이상 queued/pending/in_progress가 아닐 때까지** 기다린다(`d.prChecks`,
    // `harness.factory.merge_check_wait_sec` 상한 — 기본 600초, 15초 간격). 안정된 뒤에만 GREEN/RED를
    // 묻는다: RED가 있으면 그 체크 이름을 대며 blocked, 시간 안에 안정되지 않으면 "몇 초 기다렸는지"를
    // 대며 blocked — 둘 다 재시도로 풀린다(§KTB-15b).
    if (!d.prChecks) {
      return await undecidable("post-ready required-check wait", "prChecks dep not wired");
    }
    let settle;
    try {
      settle = await waitForChecksSettled({
        prChecks: d.prChecks, pr, required: d.requiredChecks ?? null, sleep,
        waitSec: d.mergeCheckWaitSec ?? DEFAULT_MERGE_CHECK_WAIT_SEC,
      });
    } catch (e) {
      const reason = `post-ready check poll failed: ${e?.message || e}`;
      const t = await toBlocked(reason);
      record([`merge: prChecks poll — ${reason}`, ...refusal(t)]);
      return 2;
    }
    if (!settle.ok) {
      const waitSec = d.mergeCheckWaitSec ?? DEFAULT_MERGE_CHECK_WAIT_SEC;
      const reason = `checks still pending after ${waitSec}s`;
      const t = await toBlocked(reason);
      record([`merge: required checks — ${reason}`, ...refusal(t)]);
      return 2;
    }
    const settled = relevantChecks(settle.checks, d.requiredChecks ?? null);
    const failed = settled.filter((c) => !checkPassed(c));
    if (failed.length) {
      const reason = `required check(s) failed: ${failed.map((c) => c.name).join(", ")}`;
      const t = await toBlocked(reason);
      record([`merge: required checks — ${reason}`, ...refusal(t)]);
      return 2;
    }
    record(["merge: required checks settled — all GREEN"]);

    // 체크는 GREEN이지만, 무결성(§KTB-5/6, base 코드로 계산)은 `prChecks`가 보지 못한다 —
    // `mergeGates()`를 한 번 더 불러 그것까지 확인한다(그리고 checksGreen도 다시 얻어 mg를 채운다).
    let reverified;
    try {
      reverified = await d.mergeGates();
    } catch (e) {
      if (!isMergeBaseError(e) && !isGitDiffError(e)) throw e;
      const reason = isMergeBaseError(e) ? MERGE_BASE_BLOCKED_REASON : GIT_DIFF_BLOCKED_REASON;
      const t = await toBlocked(reason);
      record([`merge: mergeGates re-check after ready — BLOCKED — ${e.message}`, ...refusal(t)]);
      return 2;
    }
    if (!reverified?.checksGreen || !reverified?.integrityGreen) {
      const reasons = [];
      if (!reverified?.checksGreen) reasons.push("required checks not GREEN");
      if (!reverified?.integrityGreen) reasons.push("integrity not GREEN");
      const reason = reasons.join("; ");
      const t = await toBlocked(reason);
      record([`merge: mergeGates re-check after ready — ${reason}`, ...refusal(t)]);
      return 2;
    }
    mg = reverified;
    record(["merge: mergeGates re-check after ready — checks GREEN, integrity GREEN"]);
  } else {
    // dep이 없다고 머지를 멈추지는 않는다 — 이미 ready인 PR(또는 `--draft`를 쓰지 않는 하네스)이면
    // 아무 문제가 없고, draft라면 바로 아래 mergePr가 GitHub의 거부를 그대로 blocked로 옮긴다.
    record(["merge: prReady dep not wired — merging without the draft flip"]);
  }

  // (6b) ADR-021 — **두 배우 모드에서는 승인이 머지보다 먼저다.** 두 배우 모드의 base 브랜치는
  // 승인 1건을 요구하므로(`required_pull_request_reviews`), 승인 없이 부른 `gh pr merge`는 GitHub이
  // 거부한다. 승인은 **머지 배우**(`FACTORY_MERGE_TOKEN`, 이 잡의 `GH_TOKEN`)로 나가고, PR을 연
  // 계정은 에이전트 배우라 서로 다르다 — 그래서 이 승인은 유효하다. 반대로 에이전트 스테이지가
  // 자기 토큰으로 같은 호출을 해도 GitHub이 422(`Can not approve your own pull request`)로 막는다:
  // 이 설계가 "명령 열거"가 아니라 "권한"으로 서 있는 지점이 여기다.
  //
  // **자리가 여기인 이유**: 승인은 PR head sha에 묶이고 `dismiss_stale_reviews: true`라 새 커밋이
  // 들어오면 무효가 된다 — 모든 게이트·체크가 끝난 뒤, 머지 직전이 승인이 낡지 않는 유일한 자리다.
  //
  // **거부는 `needs-human`이지 `blocked`이 아니다.** blocked은 sweeper와 재시도 경로가 자동으로 다시
  // 미는 상태인데(§KTB-15b), 승인 거부의 원인(같은 계정·토큰 스코프 부족·머지 배우가 협력자가 아님)은
  // 전부 **사람이 계정 설정을 고쳐야** 풀린다. 같은 호출을 다시 하면 같은 422가 돌아올 뿐이고,
  // 그 재시도는 비용만 태운다. 그래서 한 번 실패하면 사유를 이름으로 대고 사람에게 넘긴다.
  if (d.twoActor) {
    if (!d.approvePr) {
      const reason = "two-actor mode is on but the approvePr dep is not wired — the merge actor cannot approve, and the base branch requires 1 approving review (ADR-021)";
      const t = await d.transition({ to: "factory:needs-human", reason });
      record([`merge: ${reason}`, ...refusal(t)]);
      return 2;
    }
    try {
      await d.approvePr(pr);
      record([`merge: PR #${pr} approved by the merge actor (two-actor mode)`]);
    } catch (e) {
      const reason = `two-actor approval refused — the merge actor could not approve PR #${pr}: ${e?.message || e}. The approving account must differ from the PR author (GitHub rejects self-approval with 422) — check that FACTORY_MERGE_TOKEN belongs to an admin account other than the FACTORY_BOT_TOKEN account (ADR-021)`;
      const t = await d.transition({ to: "factory:needs-human", reason });
      record([`merge: approvePr FAIL — ${reason}`, ...refusal(t)]);
      return 2;
    }
  }

  try {
    await d.mergePr(pr);
  } catch (e) {
    const reason = `merge API failed: ${e?.message || e}`;
    const t = await toBlocked(reason);
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

  // (9) ADR-020 KTB-23 — 방금 머지한 것이 **하네스 이슈**였다면, 그것이 막고 있던 피처 이슈를 푼다.
  // 연결고리는 하네스 이슈 본문의 `Blocks: #<n>` 한 줄뿐이다(`lib/harness-request.js`가 그 줄을 쓰고
  // 이 자리가 읽는다 — 같은 모듈이라 두 문법이 갈라질 수 없다). 평범한 이슈의 머지는 그런 줄이
  // 없으므로 아무 일도 하지 않는다.
  //
  // **retro가 아니라 merge에서 하는 이유**: retro는 머지 N건마다 도는 학습 잡이라 "이번 머지"와 1:1이
  // 아니다(경량 회차는 아예 이 판단을 하지 않는다). 차단 해제는 머지 그 자체의 결과여야 한다 —
  // 하네스가 들어온 순간이 피처가 다시 돌 수 있게 된 순간이다.
  //
  // **여기는 빠른 경로일 뿐이다**(ADR-020 KTB-23 fix). 하네스 PR은 구성상 보호 경로를 건드리므로
  // 단계 (3)이 자동 머지를 거부하고 `needs-human`으로 넘긴다 — 실제 머지는 사람이 GitHub에서 하고,
  // 그 경로에서 이 코드는 **한 줄도 실행되지 않는다**. 해제의 1차 경로는 sweeper의 needs-info 팔
  // (`lib/sweeper.js`의 `sweepHarnessUnpark`)이고, 이 자리는 팩토리가 스스로 머지할 수 있었던 드문
  // 경우(보호 경로에 걸리지 않는 변경만 남은 재시도)를 몇 초 일찍 푸는 값이다. 둘은 마커가 아니라
  // 라벨로 겹침을 피한다: 이 전이가 성공하면 이슈는 더 이상 `factory:needs-info`가 아니라서 sweeper의
  // 조회에 잡히지 않고, 실패하면 sweeper가 다음 sweep에서 다시 시도한다.
  //
  // 전부 best-effort다: 머지는 이미 일어났고 되돌릴 것이 없다. 전이가 거부돼도(사람이 그 사이 라벨을
  // 옮겼을 수 있다) 기록만 남기고 exit 0을 유지한다 — `needs-info → queue`는 사람도 `:unstick`으로 할 수 있다.
  if (d.issueBody && d.transitionOther) {
    try {
      for (const blocked of parseBlocks(await d.issueBody())) {
        if (blocked === issue) continue;                 // 자기 자신을 가리키는 본문은 무시한다
        try {
          const t = await d.transitionOther({ issue: blocked, to: "factory:queue", reason: `harness issue #${issue} merged` });
          record([t.ok ? `merge: unblocked #${blocked} — ${t.from} → ${t.to}` : `merge: unblock #${blocked} refused — ${t.reason}`]);
        } catch (e) { record([`merge: unblock #${blocked} failed — ${e?.message || e}`]); }
      }
    } catch (e) { record([`merge: blocked-issue lookup failed — ${e?.message || e}`]); }
  }

  return 0;
}
