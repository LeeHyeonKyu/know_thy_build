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

export function harnessIssueBody({ entries, issue, pr = null }) {
  const rows = entries.map((e) => `| \`${oneLine(e.file)}\` | ${oneLine(e.change)} | ${oneLine(e.why)} |`);
  return [
    harnessRequestMarker(issue),
    `#${issue}의 implement가 **보호 경로 변경 없이는 끝낼 수 없다**고 보고했습니다(implement handoff의 \`harness_needed\`).`,
    "",
    "| file | change | why |",
    "| --- | --- | --- |",
    ...rows,
    "",
    pr == null ? "" : `그때까지의 작업은 PR #${pr}에 있습니다.`,
    "이 이슈는 평소의 파이프라인(triage → plan → implement → review)을 그대로 타되, `factory:harness`",
    "라벨 덕분에 builder가 테스트 인프라·빌드 설정 파일을 실제로 쓸 수 있고(ADR-020 KTB-20),",
    "**머지는 사람이 합니다** — 보호 경로를 실은 PR의 자동 머지는 L1이 계속 거부합니다.",
    "이 이슈가 닫히면(사람이 PR을 머지하면) sweeper가 아래 이슈를 `factory:needs-info → factory:queue`로 되돌립니다.",
    "",
    blocksLine(issue),
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
 * 새 이슈는 `factory:queue` + `factory:harness`로 태어난다: queue 라벨이 곧 triage 워크플로의 진입
 * 이벤트다(이 함수가 따로 dispatch하지 않는 이유).
 */
export async function ensureHarnessIssue({ gh, issue, entries, pr = null }) {
  const title = harnessIssueTitle(entries, issue);
  const open = await gh.issueList({ labels: [HARNESS_LABEL], state: "open" });
  const found = (open || []).find((i) => parseHarnessRequestFor(i.body) === Number(issue));
  if (found) return { issue: found.number, created: false, title: found.title ?? title };
  const number = await gh.createIssue({
    title,
    body: harnessIssueBody({ entries, issue, pr }),
    labels: ["factory:queue", HARNESS_LABEL],
  });
  if (number == null) throw new Error("gh issue create returned no issue number");
  return { issue: number, created: true, title };
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
