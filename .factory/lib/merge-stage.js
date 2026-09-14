import { verdictLine } from "./gates.js";
import { isMergeBaseError, MERGE_BASE_BLOCKED_REASON, GIT_DIFF_BLOCKED_REASON } from "./blocked-errors.js";
import { isGitDiffError } from "./changed-files.js";
import { LESSONS_POLICY_RULE as LESSONS_RULE_RE, HARNESS_SECTION_POLICY_RULE as HARNESS_SECTION_RULE_RE, TESTS_MODIFIED_POLICY_RULE as TESTS_RULE_RE } from "./integrity.js";
import { blockedOriginMarker } from "./retro/issue-comments.js";
import { parseBlocks } from "./harness-request.js";
import { verifyReviewQuorum, verifyReviewProvenance, NOT_BOUND } from "./review-quorum.js";

/**
 * 외부 감사 2026-09-14 H1b — 머지 직전에 **게시자까지** 확인하는 두 상태. `factory/integrity`는 빠져
 * 있다: 그것은 L0 required check(브랜치 보호)라 GitHub 자신이 강제하고, 사람이 여는 PR에도 붙는다.
 * 이 둘은 **이슈 파이프라인을 탄 PR에만** 게시자가 있는 상태이고(run-stage가 PR head sha에 올린다),
 * 곧 "리뷰가 실제로 돌았다"의 기계적 흔적이다.
 */
export const REVIEW_EVIDENCE_STATUSES = ["factory/review", "factory/gates"];

/**
 * KTB-46 — **"이 `factory:needs-human`은 자동 머지 거부에서 왔는가"의 유일한 표식.**
 *
 * `handToHuman`이 만드는 사유 문구(보호 경로·역할 섹션·lessons 삭제·harness.toml 얼어붙은 섹션·
 * 기존 테스트 편집)는 전이 코멘트에 그대로 실려 이슈에 남는다. sweeper의 `sweepHumanMerged` 팔은
 * 그 한 줄만 보고 "사람이 머지해 주기를 기다리는 이슈"와 나머지 모든 needs-human(재점화 한도,
 * 락 소유자 불명, 리뷰 라운드 소진…)을 가른다 — 그 둘을 섞으면 사람이 아직 보지도 않은 이슈를
 * 머지된 것으로 이으려 든다.
 *
 * 그래서 문구와 판정은 **같은 출처**에서 나온다: 리터럴이 먼저이고 정규식이 그것에서 만들어지며,
 * 아래 다섯 사유는 전부 그 리터럴로 조립된다. 문구를 고치면 판정이 따라 움직이고, 둘이 조용히
 * 갈라질 수 없다(sweeper가 어제의 문구를 찾는 동안 merge 스테이지가 오늘의 문구를 쓰는 일 —
 * 이 팔이 죽는 가장 조용한 방식이다). 방향이 이쪽인 이유(r3 nit 1): 반대로 하면 정규식의 `source`가
 * 사람이 읽는 문장이 되고, 누군가 앵커·대안(`|`)·이스케이프를 하나 넣는 순간 다섯 개의 거부 메시지가
 * 정규식 문법으로 바뀐다.
 */
const HUMAN_MERGE_REQUIRED_TEXT = "human merge required";
export const HUMAN_MERGE_REQUIRED = new RegExp(HUMAN_MERGE_REQUIRED_TEXT);

/**
 * 외부 감사 H1b의 판정 (d)를 **순수 함수로** 꺼낸 것. 이 커밋에 `factory/review`·`factory/gates`
 * 상태가 붙어 있고, 그 둘이 success이고, **팩토리 자신의 계정이 올린 것**인가.
 *
 * 상태는 repo 스코프 토큰을 쥔 무엇이든 쓸 수 있다 — 그래서 "success다"는 아무것도 증명하지 않고,
 * 게시자까지 대조해야 비로소 "리뷰·게이트가 실제로 돌았다"의 기계적 흔적이 된다. 조회 대상 sha가 곧
 * 그 상태가 붙은 커밋이므로 target sha 검사는 구조적으로 참이다(호출자가 PR head로 묻는다).
 *
 * KTB-46이 이것을 꺼낸 이유: 사람이 머지한 보호 경로 PR을 sweeper가 `factory:merged`로 이을 때
 * **같은 판정**이 필요한데, 그 팔에는 체크아웃도 이번 런의 게이트 파일도 없다. 머지는 이미 일어났고
 * 되돌릴 수 없으며, 그 커밋에 대해 남아 있는 증거는 GitHub이 들고 있는 이 두 상태다. 판정을 두 번
 * 구현하면 두 판정이 갈라진다 — 같은 함수를 두 곳이 부른다.
 *
 * 순수 함수다: 조회(로그인 해석·상태 조회)와 그 실패 처리는 호출자의 몫이고, 여기서는 **이미 읽은
 * 것**만 본다. `logins`가 비면 통과가 아니라 거부다(게시자를 대조할 기준이 없다 = 판정 불가).
 */
export function verifyFactoryStatuses({ sha, statuses, logins }) {
  const short = String(sha || "").slice(0, 7);
  const known = new Set((logins || []).filter(Boolean).map((l) => String(l).toLowerCase()));
  if (!known.size) return { ok: false, reason: `the factory's own account could not be resolved — there is no way to tell who posted ${REVIEW_EVIDENCE_STATUSES.join(" / ")}` };
  if (!Array.isArray(statuses)) return { ok: false, reason: `commit statuses for ${short} unreadable — no list returned` };
  for (const context of REVIEW_EVIDENCE_STATUSES) {
    // 같은 context가 여러 번 게시됐으면 **가장 최근 것**이 유효한 상태다 — GitHub의 목록 API가
    // 최신순이므로 첫 항목을 본다(호출자가 그 순서를 지킨다).
    const posted = statuses.filter((s) => s?.context === context);
    if (!posted.length) return { ok: false, reason: `no ${context} commit status on PR head ${short} — the review stage never posted it for this commit` };
    const latest = posted[0];
    if (String(latest.state).toLowerCase() !== "success") return { ok: false, reason: `${context} on ${short} is "${latest.state}", not success` };
    const by = String(latest.creatorLogin || "").trim();
    if (!by) return { ok: false, reason: `${context} on ${short} names no creator — the poster cannot be identified` };
    if (!known.has(by.toLowerCase())) {
      return { ok: false, reason: `${context} on ${short} was posted by @${by}, which is not a factory account (${[...known].map((l) => `@${l}`).join(", ")}) — a commit status is writable by anything holding a repo-scoped token, so an unrecognised poster is a forged review signal` };
    }
  }
  return { ok: true };
}

/**
 * 외부 감사 2026-09-14 H6 — 머지 전이 코멘트가 **사람의 서명이 어디 있었는지**를 한 줄로 말한다.
 * `merge.human_gate`(CHARTER)는 설정이 아니라 선언이다: true면 `factory-merge` 환경의 required
 * reviewer가 이 잡을 PR마다 한 번 멈춰 세웠고, false면 사람은 토큰을 한 번 등록했을 뿐이다.
 */
export function humanGateNote(humanGate) {
  if (humanGate === true) return "merged after the factory-merge environment's required reviewer approved this job (CHARTER merge.human_gate=true)";
  if (humanGate === false) return "dark merge — no per-PR human signature (CHARTER merge.human_gate=false)";
  return "dark merge — CHARTER declares no merge.human_gate, so no per-PR human signature was required (run `factory doctor`: charter.merge-human-gate-unset)";
}

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
 *    외부 감사 H1c/H1b — 머지 직전 리뷰 검증(§(6b))의 재료. **전부 필수다**: 하나라도 없으면
 *    "리뷰를 확인할 수 없다"이고 fail closed로 needs-human이다.
 *      reviewEvidence() → { ok, data(review.v1), reason? }  최신 review handoff(스키마 검증 포함)
 *      reviewRoster()   → { ok, roles: string[], reason? }  이 tier의 리뷰 로스터(정족수의 출처)
 *      reviewRecord()   → { ok, record, reason? }  `factory/records`의 run 기록에 **러너가** 쓴
 *        `review-evidence:` 줄(리뷰 batch-1 MF-2) — handoff의 출처 증명. 없거나 어긋나면 needs-human.
 *      maxRounds        → K(charter.limits.K) | null
 *      prHeadShaLive(pr)→ 지금 이 순간의 PR head sha(로컬 체크아웃이 아니라 GitHub이 답한 값)
 *      commitStatuses(sha) → [{ context, state, creatorLogin }] — **최신순**
 *      factoryLogins()  → { ok, logins: string[], reason? }  팩토리 자신의 계정 이름(값이 아니라 이름)
 *    humanGate?       → CHARTER `merge.human_gate`(boolean|undefined) — 머지 전이 텍스트에만 쓴다.
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
      reason: `protected paths changed — ${HUMAN_MERGE_REQUIRED_TEXT}: ${prot.files.join(", ")}`,
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
    // M9(ADR-023): harness.toml의 얼어붙은 섹션도 같은 배열에 실려 온다 — 세 번째 제목으로 가른다.
    const frozen = (pol.violations || []).filter((v) => HARNESS_SECTION_RULE_RE.test(v.rule));
    const frozenFiles = [...new Set(frozen.map((v) => v.file))];
    // 외부 감사 H5: 네 번째 제목 — 기존 테스트의 수정·삭제.
    const testsChanged = (pol.violations || []).filter((v) => TESTS_RULE_RE.test(v.rule));
    const testFiles = [...new Set(testsChanged.map((v) => v.file))];
    const additive = pol.files.filter((f) => !lessons.includes(f) && !frozenFiles.includes(f) && !testFiles.includes(f));
    const sections = [], reasons = [];
    if (additive.length) {
      reasons.push(`agent role sections edited outside Examples/Perspectives — ${HUMAN_MERGE_REQUIRED_TEXT}: ${additive.join(", ")}`);
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
      reasons.push(`lessons files deleted or moved away — ${HUMAN_MERGE_REQUIRED_TEXT}: ${lessons.join(", ")}`);
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
    if (frozen.length) {
      const which = [...new Set(frozen.map((v) => /\[([a-z._]+)\]/.exec(v.rule)?.[1]).filter(Boolean))];
      reasons.push(`harness.toml frozen sections edited — ${HUMAN_MERGE_REQUIRED_TEXT}: ${which.map((s) => `[${s}]`).join(", ")}`);
      sections.push({
        heading: "harness.toml의 판정 기준 섹션 편집",
        why: [
          "`factory:harness` 이슈의 builder는 `.factory/harness.toml`을 편집할 수 있지만(§5.2.1),",
          "`[protected]`·`[gates.thresholds]`·`[load_bearing]`은 **판정 기준 자체**입니다 — 보호 목록을",
          "넓히거나 임계값을 낮추면 그 PR이 스스로를 통과시키게 됩니다. 훅이나 경로 deny로는 막을 수",
          "없습니다(어느 섹션에 떨어지는 편집인지는 내용을 읽어야 압니다). 그래서 사람이 머지합니다",
          "(외부 감사 M9 / ADR-023).",
          "", `바뀐 섹션: ${which.map((s) => `[${s}]`).join(", ")}`,
        ],
        files: frozenFiles,
      });
    }
    /**
     * 외부 감사 H5 — **기존 테스트를 고치는 것은 "무엇이 통과인가"를 고치는 것이다.** 변조로 다루지
     * 않는 이유는 스펙이 바뀌면 기존 단언이 실제로 틀리기 때문이고(그때는 이슈 본문의
     * `tests_changed_allowed:`가 길을 연다 — 그 표식은 **이슈**에 있어야 한다: PR diff 안에 있으면
     * 그 PR이 스스로를 허가한다), 그럼에도 자동 머지가 안 되는 이유는 그 판단이 사람의 것이기 때문이다.
     */
    if (testsChanged.length) {
      reasons.push(`existing tests modified or deleted — ${HUMAN_MERGE_REQUIRED_TEXT}: ${testFiles.join(", ")}`);
      sections.push({
        heading: "기존 테스트의 수정·삭제",
        why: [
          "`[protected].tests_are_load_bearing`이 이 저장소의 규약입니다: 테스트는 하중을 받습니다.",
          "기존 테스트의 단언을 바꾸거나 파일을 지우는 것은 코드를 고치는 일이 아니라 **합격선을**",
          "고치는 일이라, 팩토리가 스스로 머지하지 않습니다. 스펙이 바뀌어 그 단언이 실제로 틀렸다면",
          "이슈 본문에 `tests_changed_allowed:`로 그 파일을 적으면 됩니다(외부 감사 H5 / ADR-023).",
          "", "바뀌거나 사라진 기존 테스트:",
        ],
        files: testFiles,
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

  // (6b) 외부 감사 2026-09-14 H1c/H1b — **리뷰가 실제로 있었는가.** 여기까지 오는 동안 확인된 것은
  // "게이트가 GREEN이다", "필수 체크가 GREEN이다", "무결성이 GREEN이다"뿐이고, 그 어느 것도 *리뷰어
  // 다섯이 이 diff를 봤다*를 말하지 않는다. 감사 전 코드에서는 `factory:merged` 규칙만이 리뷰를
  // 물었는데 그 규칙은 `mergePr` **뒤에** 평가되고(아래 (7)), 정족수·all-approve는 아예 묻지 않았다.
  // 그래서 위조한 review handoff 코멘트 + 위조한 commit status + 라벨 편집 하나면 리뷰어가 한 번도
  // 뜨지 않은 채 main에 들어갈 수 있었다(H1 체인).
  //
  // **자리가 여기인 이유**: PR head는 ready 플립과 체크 안정화가 끝난 지금 확정된다. 리뷰 증거는
  // 그 커밋에 묶여야 의미가 있으므로, 이 순간의 라이브 PR head를 다시 물어 그것으로 판정한다.
  // 승인(6c)보다도 **앞**이다 — 실패하면 머지도, 승인도 없다(승인 자체가 사람 눈에는 "팩토리가
  // 이 PR을 통과시켰다"는 서명이다).
  //
  // 네 가지를 묻는다:
  //   (a) 이 PR head sha에 묶인 `review.v1` handoff가 있는가
  //   (b) 정족수(= 이 tier의 로스터 크기)와 all-approve — handoff의 자기 신고 `decision`이 아니라
  //       `must_fix`에서 `aggregate`로 **다시 계산한다**(lib/review-quorum.js)
  //   (c) 라운드가 K를 넘지 않는가
  //   (d) `factory/review`·`factory/gates` 상태를 **팩토리가** 게시했는가(creator.login 대조) —
  //       그리고 그 상태가 붙은 커밋이 PR head인가(이 sha로 조회하므로 구조적으로 참이다)
  //
  // 하나라도 확인 불가면(dep 미배선·조회 실패·로그인 미해결) GREEN이 아니라 **판정 불가**이고,
  // 머지는 되돌릴 수 없으므로 fail closed로 `needs-human`이다.
  // KTB-42 — review 런이 run 기록에 남긴 qa 증거 매니페스트의 지문. 아래 (b2)에서 채워지고
  // `factory:merged` 전이에 그대로 실린다(`lib/requirements.js` qaEvidenceGate가 다시 묻는다).
  let qaManifestRecorded = null;
  const reviewRefused = async (reason) => {
    const line = `review verification failed — ${reason}`;
    const t = await d.transition({ to: "factory:needs-human", reason: line });
    record([`merge: ${line}`, ...refusal(t)]);
    return 2;
  };
  {
    const missingDeps = ["reviewEvidence", "reviewRoster", "reviewRecord", "reviewRunId", "prHeadShaLive", "commitStatuses", "factoryLogins"].filter((k) => !d[k]);
    if (missingDeps.length) {
      return await reviewRefused(`review-evidence deps not wired (${missingDeps.join(", ")}) — the merge stage cannot prove a review happened, and an unverified review is not a passed review`);
    }

    let live;
    try { live = await d.prHeadShaLive(pr); }
    catch (e) { return await reviewRefused(`PR #${pr} head sha unreadable: ${e?.message || e}`); }
    if (!live) return await reviewRefused(`PR #${pr} head sha unreadable — no sha returned`);
    // checkoutHead가 고정한 sha와 지금의 PR head가 다르면, 게이트·리뷰가 본 트리가 아닌 것이 머지된다.
    if (sha && live !== sha) return await reviewRefused(`PR head moved during this run — gates verified ${sha.slice(0, 7)}, PR head is now ${live.slice(0, 7)}`);

    let ev;
    try { ev = await d.reviewEvidence(); }
    catch (e) { return await reviewRefused(`review handoff unreadable: ${e?.message || e}`); }
    if (!ev?.ok) return await reviewRefused(ev?.reason || "review handoff missing or invalid");

    let ros;
    try { ros = await d.reviewRoster(); }
    catch (e) { return await reviewRefused(`review roster unresolvable: ${e?.message || e}`); }
    if (!ros?.ok || !Array.isArray(ros.roles) || ros.roles.length === 0) {
      return await reviewRefused(ros?.reason || "review roster unresolvable — quorum cannot be checked");
    }

    const q = verifyReviewQuorum({ data: ev.data, rosterSize: ros.roles.length, rosterRoles: ros.roles, maxRounds: d.maxRounds ?? null, prHeadSha: live });
    if (!q.ok) return await reviewRefused(q.reason);
    record([`merge: review verified — ${ros.roles.length}/${ros.roles.length} approve on ${live.slice(0, 7)}, round ${ev.data.round}${Number.isInteger(d.maxRounds) ? ` (K=${d.maxRounds})` : ""}, decision recomputed from must_fix`]);

    // (b2) 리뷰 batch-1 MF-2 — **그 handoff는 실제로 돈 review 런의 것인가.** 위 (b)까지가 보는 것은
    // handoff의 *내용*뿐이고, 그 코멘트는 모든 스테이지가 공유하는 봇 계정으로 나간다(`gh issue comment`는
    // 훅이 일부러 열어 둔 문이다) — 곧 all-approve handoff를 손으로 지어내면 (b)를 그대로 통과했다.
    // 그래서 `factory/records`의 run 기록에 **러너가** 남긴 `review-evidence:` 줄과 대조한다: 같은 커밋,
    // 같은 verdict 집합, 같은 라운드여야 한다. 기록을 못 읽는 것도 통과가 아니다(fail closed).
    //
    // 리뷰 batch-2 MF-2 — 그런데 **어느 줄이 그 런의 것인가**를 파일 순서로 정하면("마지막 줄") 그
    // 기록 파일에 줄을 덧붙일 수 있는 누구든 판정을 대신 쓸 수 있다(재리뷰가 rc=0으로 확인했다).
    // 그래서 런 id를 먼저, **기록과 다른 채널**에서 읽는다: 이 이슈의 review 하트비트가 싣는
    // `runner: gha-<run id>`. 그 값을 기대값으로 넘겨 같은 런이 쓴 줄만 고르고, 대조한다.
    let expected;
    try { expected = await d.reviewRunId(); }
    catch (e) { return await reviewRefused(`${NOT_BOUND} — the review run id could not be read from this issue: ${e?.message || e}`); }
    if (!expected?.ok || !expected.runId) return await reviewRefused(`${NOT_BOUND} — ${expected?.reason || "the review run that produced this handoff could not be named"}`);

    let rec;
    try { rec = await d.reviewRecord({ runId: expected.runId }); }
    catch (e) { return await reviewRefused(`${NOT_BOUND} — the records branch could not be read: ${e?.message || e}`); }
    if (!rec?.ok) return await reviewRefused(`${NOT_BOUND} — ${rec?.reason || "the review run record is unavailable"}`);
    const prov = verifyReviewProvenance({ handoff: ev.data, record: rec.record, prHeadSha: live, expectedRunId: expected.runId });
    if (!prov.ok) return await reviewRefused(prov.reason);
    record([`merge: review evidence bound to the factory/records run record — review run ${rec.record.runId} (${rec.record.runnerId || "unknown"}) on ${String(rec.record.headSha).slice(0, 7)}, round ${rec.record.round ?? "?"}`]);

    /**
     * ── ADR-024 / KTB-42 — **qa 증거도 그 줄에서 읽는다.** ──────────────────────────────────────
     * 매니페스트 파일(`.factory/out/qa/<issue>/manifest.json`)은 커밋되지 않으므로 머지 스테이지의 새
     * 체크아웃에는 존재하지 않는다. 볼 수 있는 것은 review 런이 run 기록에 남긴 지문 하나뿐이고,
     * 그 자리는 러너만 쓴다(에이전트 세션의 `factory/records` push는 훅이 막는다).
     * 로스터에 `qa`가 있는데 그 지문이 없다 = 유효한 증거가 있었다는 증인이 없다 = 판정 불가.
     * KTB #3의 교훈을 뒤집어 적용한다: "증거가 없다"는 이제 빌더를 가리키지 않고, **되돌릴 수 없는
     * 단계 앞에서 멈추는 이유**가 된다.
     */
    if (ros.roles.includes("qa")) {
      qaManifestRecorded = rec.record.qaManifest ?? null;
      if (!qaManifestRecorded) {
        return await reviewRefused(`${NOT_BOUND} — this tier's roster includes qa, but the review run recorded no qa_manifest digest for ${live.slice(0, 7)}. A valid qa evidence manifest (\`node .factory/bin/qa-evidence.js finish --issue ${issue}\`) is what that digest names, and without it nothing witnesses that the evidence existed`);
      }
      record([`merge: qa evidence manifest ${qaManifestRecorded.slice(0, 12)} bound to the review run record`]);
    }

    // (d) 게시자. 에이전트 스테이지가 쥔 토큰으로도 `POST /statuses/<sha>`는 나갈 수 있으므로
    // (감사 H1b — 훅은 그 위의 한 겹일 뿐이다), "상태가 success다"만으로는 아무것도 증명되지 않는다.
    // 팩토리 자신의 계정(들)을 `gh api user`로 한 번 해석하고 그것과 대조한다. 해석 실패는 통과가
    // 아니라 **판정 불가**다.
    let logins;
    try { logins = await d.factoryLogins(); }
    catch (e) { logins = { ok: false, reason: `${e?.message || e}` }; }
    if (!logins?.ok || !Array.isArray(logins.logins) || logins.logins.length === 0) {
      return await reviewRefused(`the factory's own account could not be resolved (gh api user) — there is no way to tell who posted ${REVIEW_EVIDENCE_STATUSES.join(" / ")}: ${logins?.reason || "unknown"}`);
    }
    let statuses;
    try { statuses = await d.commitStatuses(live); }
    catch (e) { return await reviewRefused(`commit statuses for ${live.slice(0, 7)} unreadable: ${e?.message || e}`); }

    // KTB-46: 판정 자체는 `verifyFactoryStatuses`(위) 하나다 — sweeper의 사람-머지 반영 팔이 같은
    // 함수를 부른다. 여기서 하던 일과 문구는 한 글자도 바뀌지 않았다(r3 nit 5: "목록이 아니다"
    // 검사는 그 함수 안에 한 벌만 남긴다 — 문장이 같으므로 여기서 먼저 접던 줄을 지웠다).
    const posted = verifyFactoryStatuses({ sha: live, statuses, logins: logins.logins });
    if (!posted.ok) return await reviewRefused(posted.reason);
    record([`merge: ${REVIEW_EVIDENCE_STATUSES.join(" + ")} on ${live.slice(0, 7)} posted by the factory`]);
  }

  // (6c) ADR-021 — **두 배우 모드에서는 승인이 머지보다 먼저다.** 두 배우 모드의 base 브랜치는
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
  //
  // 외부 감사 H6 — **사람의 서명이 이 머지에 있었는가를 전이 텍스트가 말한다.** `merge.human_gate`가
  // true이면 이 잡 자체가 `factory-merge` 환경의 required reviewer 앞에서 한 번 멈췄다는 뜻이고
  // (곧 사람이 PR마다 "돌려라"를 눌렀다), false이면 사람의 서명은 토큰 등록 1회뿐이다 — 그것이
  // 다크 루프의 정의이고, 기록에 소리 내어 남아야 한다. 값이 없으면(구형 CHARTER) 그 사실을 적는다.
  const t = await d.transition({ to: "factory:merged", reason: humanGateNote(d.humanGate), mergeGatesResult: mg, qaManifestRecorded });
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
