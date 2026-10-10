// Scope change (#230): dw5 requires the retro maturity-promotion issue (also a `factory:harness` issue) to get a comment shaped like `notQueuedComment`; must_fix arch1 requires the create-in-backlog → transition → not-queued-comment tail to have one implementation (`createBacklogIssueAndQueue`) that both `ensureHarnessIssue` and retro's `makeRetroCreateIssue` call, with an option to drop the "a parked feature waits on this issue" sentence that is false for a retro promotion.
import { HARNESS_LABEL } from "./label-catalog.js";

/**
 * ADR-020 KTB-23 — builder가 "보호 경로를 고쳐야 이 이슈를 끝낼 수 있다"고 말하는 유일한 경로.
 *
 * 데모 #2(feature 001이 `pg` 패키지를 필요로 했다)가 드러낸 것: builder는 `package.json`을 편집할 수
 * 없고(훅 + L2 deny — 의도된 설계다), 프롬프트가 시키는 대응은 **PR 본문에 "Harness change needed"라고
 * 산문으로 쓰고 마무리**하는 것이었다. 그런데 그 산문을 읽는 기계가 아무 데도 없었다: verifier는 그저
 * "done_when에 대응하는 테스트가 없다"를 보고 reject했고, 등급은 needs-human이 됐고, 사람이 손으로
 * 재큐하면 같은 일이 다시 일어났다 — 네 라운드, ≈$67, 머지 0건. 산문은 신호가 아니다.
 *
 * 그래서 이 요청은 **handoff의 필드**(`implement.v1`의 선택 필드 `harness_needed[]`)가 되고, L1이
 * 그것을 읽어 `factory:harness` 이슈 하나를 열고 피처 이슈를 `factory:needs-info`로 주차한다.
 * 하네스 이슈는 KTB-20의 변형 경로를 그대로 탄다(builder가 테스트 인프라 파일을 실제로 쓸 수 있다)
 * — 그리고 여전히 사람이 머지한다(L1의 보호 경로 거부는 한 글자도 바뀌지 않는다).
 *
 * 이 모듈은 순수 함수만 둔다(fs도 gh도 만지지 않는다) — 제목·본문·파싱이 `run-stage`(이슈를 만드는
 * 쪽)와 `merge-stage`(머지 뒤 차단을 푸는 쪽) 양쪽에서 **같은 문법**이어야 하기 때문이다. 두 곳이
 * 갈라지면 하네스 이슈가 머지돼도 피처 이슈가 영원히 needs-info에 남는다.
 */

/** 제목 한 줄에 실을 수 있는 `change` 길이. 넘으면 자른다 — 제목은 dedupe 키이자 사람이 읽는 줄이다. */
const CHANGE_MAX = 80;

const oneLine = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
const clip = (v, n) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** `harness_needed` 항목 중 형식이 맞는 것만(file·change·why 모두 비어 있지 않은 문자열). */
export function harnessNeeded(data) {
  const list = Array.isArray(data?.harness_needed) ? data.harness_needed : [];
  return list.filter((e) => e && ["file", "change", "why"].every((k) => typeof e[k] === "string" && e[k].trim() !== ""));
}

/**
 * 사람이 읽는 제목. 항목이 여럿이면 첫 항목의 `change`에 나머지 개수를 붙인다 — 전부 이어 붙이면
 * 제목이 문단이 된다. **dedupe 키가 아니다**(ADR-020 KTB-23 fix): 예전에는 이 문자열이 열린 harness
 * 이슈와의 비교 기준이었는데, 제목은 사람이 고쳐도 되는 줄이고 builder의 `change` 문구가 라운드마다
 * 한 글자만 달라져도 같은 피처에 대해 두 번째 하네스 이슈가 열렸다. 키는 본문의 기계 마커다
 * (`harnessRequestMarker`) — 피처 이슈 하나당 열린 하네스 이슈 하나가 그 계약이다.
 */
export function harnessIssueTitle(entries, issue) {
  const first = clip(oneLine(entries[0]?.change), CHANGE_MAX);
  const more = entries.length > 1 ? ` (+${entries.length - 1} more)` : "";
  return `harness: ${first}${more} — for #${issue}`;
}

/** 본문의 마지막 줄 `Blocks: #<n>`이 merge 스테이지가 읽는 유일한 연결고리다(§parseBlocks). */
export const blocksLine = (issue) => `Blocks: #${issue}`;

/**
 * 본문 첫 줄의 네임스페이스 마커 — **이것이 dedupe 키다**(ADR-020 KTB-23 fix). `for=<n>`은 이 하네스
 * 작업이 막고 있는 피처 이슈 번호이고, 그래서 "피처 이슈 하나당 열린 하네스 이슈 하나"가 계약이 된다:
 * 같은 피처가 rework로 다시 돌아 문구가 조금 다른 요청을 내놓아도 이슈가 쌓이지 않는다.
 * `Blocks: #<n>` 줄과 같은 사실을 싣지만 둘의 역할은 다르다 — `Blocks:`는 사람도 쓰는 사람의 줄이고,
 * 이 마커는 기계만 쓰는 기계의 줄이다(사람이 `Blocks:`를 손으로 더해도 dedupe가 흔들리지 않는다).
 */
export const harnessRequestMarker = (issue) => `<!-- factory-harness-request for=${issue} -->`;

/** 본문에서 `factory-harness-request` 마커가 가리키는 피처 이슈 번호(없으면 null). */
export function parseHarnessRequestFor(body) {
  const m = /<!--\s*factory-harness-request for=(\d+)\s*-->/.exec(String(body ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * `origin`은 **누가 이 요청을 냈는가**다(기본은 빌더). 두 번째 생산자가 생겼다 — 피드백 루프(Task 3)는
 * **머지된** 이슈의 증거를 분류해, 원인 파일이 그 저장소 소유(`owner: user`)인 발견을 같은 harness
 * 이슈로 보낸다. 마커(`for=<n>`)도 제목도 그대로라 dedupe는 한 글자도 바뀌지 않지만, 본문의 두 문장은
 * 거짓이 된다: 그 요청은 implement handoff의 `harness_needed`가 아니고, 가리키는 이슈는 이미 머지돼
 * 주차 해제될 것이 없다(`factory:merged`는 막다른 상태라 `Blocks:`는 거부되는 전이만 만든다).
 * 그래서 origin이 `feedback`이면 머리 문장을 바꾸고 `Blocks:` 줄을 싣지 않는다 — 기본값 경로의
 * 바이트는 그대로다.
 */
export function harnessIssueBody({ entries, issue, pr = null, origin = "implement" }) {
  const rows = entries.map((e) => `| \`${oneLine(e.file)}\` | ${oneLine(e.change)} | ${oneLine(e.why)} |`);
  const feedback = origin === "feedback";
  return [
    harnessRequestMarker(issue),
    feedback
      ? `머지된 #${issue}의 증거를 회고가 분류한 결과입니다(피드백 루프 Task 3). 아래 파일의 주인은 **이 저장소**입니다 — 설치 매니페스트가 \`owner: user\`로 싣는 파일이므로 KTB가 아니라 여기서 고칩니다(spec §2).`
      : `#${issue}의 implement가 **보호 경로 변경 없이는 끝낼 수 없다**고 보고했습니다(implement handoff의 \`harness_needed\`).`,
    "",
    "| file | change | why |",
    "| --- | --- | --- |",
    ...rows,
    "",
    pr == null ? "" : `그때까지의 작업은 PR #${pr}에 있습니다.`,
    "이 이슈는 평소의 파이프라인(triage → plan → implement → review)을 그대로 타되, `factory:harness`",
    "라벨 덕분에 builder가 테스트 인프라·빌드 설정 파일을 실제로 쓸 수 있고(ADR-020 KTB-20),",
    "**머지는 사람이 합니다** — 보호 경로를 실은 PR의 자동 머지는 L1이 계속 거부합니다.",
    feedback ? "" : "이 이슈가 닫히면(사람이 PR을 머지하면) sweeper가 아래 이슈를 `factory:needs-info → factory:queue`로 되돌립니다.",
    "",
    feedback ? "" : blocksLine(issue),
  ].filter((l) => l !== "").join("\n");
}

/** 피처 이슈에 남길 주차 사유. 전이 코멘트 한 줄에 그대로 실린다. */
export const parkedReason = (harnessIssue) => `waiting for harness issue #${harnessIssue}`;

/**
 * 본문에서 `Blocks: #<n>`이 가리키는 이슈 번호들. merge 스테이지가 방금 머지한 이슈의 본문을 읽어
 * "이 하네스 작업이 무엇을 막고 있었는가"를 판단한다 — 한 줄에 여러 개도 받는다(`Blocks: #2, #5`).
 * 본문이 없거나 그런 줄이 없으면 빈 배열이다(평범한 이슈의 머지는 아무 일도 하지 않는다).
 */
export function parseBlocks(body) {
  const out = [];
  for (const line of String(body ?? "").split("\n")) {
    if (!/^\s*Blocks:/i.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

/**
 * `factory:harness` 이슈를 **하나만** 만든다. 이 피처 이슈를 가리키는 마커
 * (`<!-- factory-harness-request for=<n> -->`)를 본문에 가진 열린 harness 이슈가 이미 있으면 그것을
 * 그대로 쓴다 — implement가 (rework로) 다시 돌아 문구가 조금 다른 요청을 내놓아도 이슈가 쌓이지 않는다.
 * 예전에는 제목으로 비교했는데(KTB-23), `change` 한 글자만 달라져도 두 번째 이슈가 열렸다.
 * 조회가 실패하면 만들지 않는다(fail closed): 중복 이슈를 여는 것보다 이번 런이 needs-human으로
 * 가는 편이 낫다 — 사람은 어느 쪽이든 보게 되지만, 중복 이슈는 사람이 손으로 치워야 한다.
 *
 * #136 (S2b, 설계 2026-09-30 §8.2) — 새 이슈는 **`backlog` + `factory:harness`로 태어나고**, 큐로 가는
 * 한 걸음은 호출자가 주입한 `transitionIssue`(= 문: 리허설 + 큐 진입 심사)만이 만든다. 예전에는
 * `factory:queue`로 바로 태어났다 — 문을 지나지 않는 유일한 큐 진입 경로였고, 그러면 자기생성 상한은
 * 상한이 아니다. 아래 `ensureHarnessIssue`와 `notQueuedComment`를 보라.
 */
/**
 * 이미 열려 있는 하네스 이슈의 표에 **빠진 줄만** 덧붙인다(T3 리뷰 SF-2). 예전에는 기존 이슈를
 * 찾으면 그대로 돌려주고 끝이었다 — 재진입 멱등성을 그 조기 반환으로 샀는데, 그 대가로 **새로**
 * 나온 요청이 조용히 사라졌다(액션 줄에는 `created:false`만 남는다). 같은 줄인지는 표의 `file` 셀로
 * 본다: 같은 파일에 대한 요청은 문구가 달라도 한 줄이면 충분하고, 다른 파일은 언제나 새 사실이다.
 * 덧붙일 것이 없으면 본문을 **건드리지 않는다**(같은 머지를 다시 읽어도 표가 자라지 않는다).
 */
export function appendHarnessEntries(body, entries) {
  const text = String(body ?? "");
  const have = new Set([...text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1].trim()));
  const missing = (entries || []).filter((e) => !have.has(oneLine(e.file)));
  if (!missing.length) return { body: text, added: [] };
  const rows = missing.map((e) => `| \`${oneLine(e.file)}\` | ${oneLine(e.change)} | ${oneLine(e.why)} |`);
  const lines = text.split("\n");
  // 표의 마지막 줄 뒤에 끼워 넣는다 — 표 아래의 산문(사람이 덧붙인 메모 포함)은 그대로 둔다.
  let last = -1;
  lines.forEach((l, i) => { if (/^\|/.test(l)) last = i; });
  if (last === -1) return { body: `${text}\n${rows.join("\n")}`, added: missing };
  return { body: [...lines.slice(0, last + 1), ...rows, ...lines.slice(last + 1)].join("\n"), added: missing };
}

/** 문이 배선되지 않은 호출자(피드백 루프 등)의 반환 사유. 이슈는 `backlog`에서 사람의 `:next`를 기다린다. */
export const HARNESS_TRANSITION_UNWIRED = "no transition is wired for this caller — the harness issue stays in backlog until a person runs `/know-thy-build:next` on it";

const labelNames = (it) => (Array.isArray(it?.labels) ? it.labels : []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
/** 재사용할 열린 하네스 이슈가 아직 `backlog`에 서 있는가(큐 라벨 없음). 라벨을 모르면 false — 발명하지 않는다. */
const stillInBacklog = (it) => { const ls = labelNames(it); return ls.includes("backlog") && !ls.some((l) => l.startsWith("factory:") && l !== HARNESS_LABEL); };
/** 재사용 경로의 사유: 이슈는 앞서 큐에 못 들어갔고, 이 경로는 문을 다시 두드리지 않는다. */
export const stillBacklogReason = (n) => `harness issue #${n} already exists and is still in backlog — it was not queued earlier and reuse does not retry the queue door; a person's \`/know-thy-build:next\` on #${n} is needed`;

/** 하네스 이슈가 큐에 들어가지 못했다는 기계 마커(flaky 수확의 `factory-flaky-not-queued`와 같은 모양). */
export const notQueuedMarker = (n) => `<!-- factory-harness-not-queued issue=${n} -->`;

/** 심사 거부 사유 문구 → 발동한 상한의 이름. `lib/admission.js`가 쓰는 괄호 표기를 그대로 읽는다(import하지 않는다). */
const CAP_RE = /\((back_pressure\.queue_max|self_generated\.open_max|self_generated\.depth_max)\)/g;
const CAP_EXIT = {
  "back_pressure.queue_max": "큐가 상한 아래로 줄어든 뒤(다른 이슈가 triage를 지나간 뒤)",
  "self_generated.open_max": "진행 중인 자기생성 이슈(개선·하네스·flaky)가 끝나거나 닫혀 상한 아래로 내려간 뒤",
  "self_generated.depth_max": "사람이 이 작업을 직접 하거나 CHARTER의 상한을 바꾼 뒤(상한 변경은 사람 전용)",
};

/**
 * `backlog`에 남은 하네스 이슈에 남기는 코멘트. 사유는 **그대로** 싣고, 다음 걸음은 거부의 종류로 가른다:
 *   - 심사 거부(`queue admission refused — …`): 발동한 상한을 이름으로 대고, `:next`만으로는 같은 상한에 다시
 *     거부된다고 말한다 — 상한이 풀릴 때까지 `:next`는 헛걸음이다.
 *   - 문이 던졌다: 일시적 실패일 수 있다 — 그대로 `:next`로 다시 시도.
 *   - 문 배선 누락(`no … is wired into this transition`): 공장 배선의 결함이다 — 리허설을 권하지 않는다.
 *   - 리허설 거부(사유에 rehearsal): `factory rehearse`를 돌린 뒤 `:next`.
 *   - 그 밖(상태 라벨·전이 그래프 거부 등): 라벨을 확인한 뒤 `:next` — 리허설을 권하지 않는다.
 */
const UNWIRED_RE = /^no (queue admission|rehearsal checker) is wired into this transition\b/;
const REHEARSAL_RE = /rehears/i;
export function notQueuedComment({ issue, reason, threw = false, parkedFeature = true }) {
  const why = String(reason ?? "unknown");
  const head = `${notQueuedMarker(issue)}\n이 하네스 이슈는 \`backlog\`에 머물러 있습니다 — 큐 전이${threw ? "가 실패했습니다" : "가 거부됐습니다"}: ${why}`;
  let next;
  if (!threw && /^queue admission refused\b/.test(why)) {
    const caps = [...new Set([...why.matchAll(CAP_RE)].map((m) => m[1]))];
    const named = caps.length ? caps.map((c) => `\`${c}\``).join(", ") : "심사(사유 참조)";
    const exit = caps.map((c) => CAP_EXIT[c]).filter(Boolean);
    next = `발동한 상한: ${named}. \`/know-thy-build:next\` alone will be refused again — 같은 문이 같은 상한으로 다시 거부합니다. ${exit.length ? `${exit.join("; ")} \`/know-thy-build:next\`로 큐에 넣으세요.` : "사유를 고친 뒤 `/know-thy-build:next`로 큐에 넣으세요."}`;
  } else if (threw) {
    next = "일시적인 실패일 수 있습니다 — `/know-thy-build:next`로 다시 큐에 넣으세요.";
  } else if (UNWIRED_RE.test(why)) {
    next = "이 문을 부른 공장 코드의 배선이 빠졌습니다(리허설이나 상한의 문제가 아닙니다) — 그 배선은 사람이 고칠 일이고, 그동안은 사람이 `/know-thy-build:next`(리허설과 심사를 모두 배선한 문)로 큐에 넣으세요.";
  } else if (REHEARSAL_RE.test(why)) {
    next = "하네스를 러너에서 한 번 돌린 뒤(`factory rehearse`) `/know-thy-build:next`로 큐에 넣으세요(ADR-025).";
  } else {
    next = "이슈의 상태 라벨이 큐로 가는 전이를 허락하지 않습니다(리허설이나 상한의 문제가 아닙니다) — 라벨을 확인해 `backlog`에 세운 뒤 `/know-thy-build:next`로 큐에 넣으세요.";
  }
  // #230 — retro의 성숙도 승격 이슈를 기다리는 피처는 없다(`parkedFeature: false`) — 그 문장은 거기서 거짓이다.
  return `${head}\n\n${next}${parkedFeature ? "\n\n이 이슈를 기다리는 피처는 이 이슈가 큐에 들어가 머지될 때까지 주차돼 있습니다(#136)." : ""}`;
}

/**
 * `transitionIssue`(선택): `({ issue, to, reason }) => { ok, reason }` — 호출자가 리허설과 큐 진입 심사를 실어
 * 배선한 문(run-stage의 `makeHarnessIssueDep`, gates.js의 flaky 수확과 같은 모양). 이 모듈은 문을 import하지
 * 않는다(순수 어댑터 — 테스트가 진짜 문을 합성해 붙인다).
 *
 * 새 이슈의 반환값은 `queued`를 싣는다: 큐에 들어갔으면 true, 아니면 false와 `queue_reason`. 큐에 못 넣은 경우
 * (거부·문이 던짐·문 없음) 이슈는 `backlog`에 남고 — 이 함수는 **던지지 않는다**(이슈는 이미 만들어졌고,
 * 그 번호를 잃으면 주차된 피처가 가리킬 곳이 없다). 거부·던짐이면 이유를 코멘트로 남기고, 그 코멘트
 * 쓰기의 실패도 삼킨다(반환값이 진실을 말한다). 재사용 경로는 문을 다시 두드리지 않는다(범위 밖 — plan non_goals).
 */
export async function ensureHarnessIssue({ gh, issue, entries, pr = null, origin = "implement", transitionIssue = null }) {
  const title = harnessIssueTitle(entries, issue);
  const open = await gh.issueList({ labels: [HARNESS_LABEL], state: "open" });
  const found = (open || []).find((i) => parseHarnessRequestFor(i.body) === Number(issue));
  if (found) {
    // skeptic #136 f2/f3 — 재사용 경로는 문을 다시 두드리지 않는다(plan non_goals). 대신 이슈가 **지금** backlog에 서 있으면
    // 그 사실을 반환값에 싣는다: 싣지 않으면 호출자(피드백 영수증·주차 사유·런 기록)는 "고쳐지는 중"이라고 말하게 된다.
    // 라벨을 모르면(라벨 없는 목록) 발명하지 않는다 — 반환값은 예전 그대로다.
    const still = stillInBacklog(found) ? { queued: false, queue_reason: stillBacklogReason(found.number) } : {};
    // 덧붙이기는 어댑터가 본문 편집을 줄 때만 한다(그 능력이 없는 호출자의 동작은 한 글자도 안 바뀐다).
    if (typeof gh.editIssueBody === "function") {
      const { body, added } = appendHarnessEntries(found.body, entries);
      if (added.length) {
        await gh.editIssueBody(found.number, body);
        return { issue: found.number, created: false, appended: added.length, title: found.title ?? title, ...still };
      }
    }
    return { issue: found.number, created: false, appended: 0, title: found.title ?? title, ...still };
  }
  const made = await createBacklogIssueAndQueue({
    gh, title,
    body: harnessIssueBody({ entries, issue, pr, origin }),
    labels: ["backlog", HARNESS_LABEL],
    reason: `harness request for #${issue}`,
    transitionIssue,
  });
  return { issue: made.issue, created: true, title, queued: made.queued, ...(made.queued ? {} : { queue_reason: made.queue_reason }) };
}

/**
 * #230 (리뷰 arch1) — "`backlog`로 이슈를 만들고 → 큐 문(`transitionIssue`)을 두드리고 → 거부·던짐이면 `backlog`에 둔 채
 * `notQueuedComment`를 단다"의 **유일한** 구현. 하네스 요청(`ensureHarnessIssue`)과 retro의 성숙도 승격 이슈(retro.js
 * `makeRetroCreateIssue`)가 둘 다 이것을 부른다 — 사본이 갈라지면 한쪽의 수정이 다른 쪽에 닿지 않는다.
 *   (#247 — 남은 사본 하나: gates.js의 flaky 수확은 main에서부터 같은 꼬리를 자기 마커 `factory-flaky-not-queued`로 따로 갖고 있다.
 *   그 파일은 #247의 범위 밖이라 옮기지 않았다 — 후속 이슈로 넘긴다.)
 *   - `labels`는 호출자가 준 그대로(`backlog` 포함) 만든다. 번호가 없으면 던진다(만들어졌는지 모른다).
 *   - 문이 없으면 `HARNESS_TRANSITION_UNWIRED`로 `queued:false` — 코멘트는 달지 않는다(예전 그대로).
 *   - 큐에 들어가면 `{ issue, queued: true }`, 아니면 `{ issue, queued: false, queue_reason }` — 던지지 않는다(이슈는 이미 있다).
 *   - `parkedFeature: false`면 코멘트에서 "이 이슈를 기다리는 피처" 문장을 뺀다(retro 승격 이슈에는 그런 피처가 없다).
 */
export async function createBacklogIssueAndQueue({ gh, title, body, labels, reason, transitionIssue = null, parkedFeature = true }) {
  const number = await gh.createIssue({ title, body, labels });
  if (number == null) throw new Error("gh issue create returned no issue number");
  if (typeof transitionIssue !== "function") return { issue: number, queued: false, queue_reason: HARNESS_TRANSITION_UNWIRED };
  let t, threw = false;
  try { t = await transitionIssue({ issue: number, to: "factory:queue", reason }); }
  catch (e) { threw = true; t = { ok: false, reason: `queue transition threw — ${String(e?.message || e).split("\n")[0]}` }; }
  if (t?.ok === true) return { issue: number, queued: true };
  const why = t?.reason || "unknown";
  try { await gh.comment(number, notQueuedComment({ issue: number, reason: why, threw, parkedFeature })); }
  catch { /* 기록의 실패가 이슈 생성의 실패는 아니다 — 반환값이 사유를 싣는다 */ }
  return { issue: number, queued: false, queue_reason: why };
}

/**
 * ADR-020 리뷰 효율 Task 8 (Structure G) — 이 피처 이슈를 막고 있는 **열린** `factory:harness` 이슈
 * 번호(없으면 null). `ensureHarnessIssue`가 dedupe 키로 쓰는 바로 그 마커(`for=<n>`)로 찾는다:
 * "피처 이슈 하나당 열린 하네스 이슈 하나"라는 그 계약 덕분에 이것이 "미해결 제품/하네스 의존성이
 * 있는가"의 단일 진실이다. run-stage의 리뷰 진입 가드와 sweeper의 리뷰 재dispatch가 **같은** 판정을
 * 쓰도록 여기 한 곳에 둔다(두 곳이 갈리면 한쪽만 억제해 회귀가 반만 막힌다).
 *
 * 하네스 이슈가 닫히면(사람이 PR을 머지하면) `state:open`이 그것을 더는 돌려주지 않으므로 자연히
 * null이 된다 — 억제가 스스로 풀린다. **fail-safe는 호출자의 몫이다**: `gh.issueList`가 던지면 이
 * 함수도 던지고, 억제하는 쪽(run-stage/sweeper)이 그것을 잡아 "억제하지 않음"으로 기운다(놓친 억제는
 * 리뷰 한 라운드, 틀린 억제는 리뷰 가능한 이슈를 멈춰 세운다).
 */
export async function findOpenHarnessIssueFor({ gh, issue }) {
  const open = await gh.issueList({ labels: [HARNESS_LABEL], state: "open" });
  const found = (open || []).find((i) => parseHarnessRequestFor(i.body) === Number(issue));
  return found ? found.number : null;
}

export { HARNESS_LABEL };
