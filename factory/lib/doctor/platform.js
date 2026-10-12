/**
 * #234 (gap P-8, B-1·B-2) — **Actions가 막혀도 그 사실을 아는 주체는 Actions 밖에 있어야 한다.**
 *
 * 1. `actions.hosted-minutes-metered` — private 저장소가 GitHub 호스팅 러너로 돈다. 월 포함분이 떨어지는
 *    순간 스테이지 연쇄·sweeper(복구 담당)·integrity·retro·merge가 **전부 함께** 멈추고, 멈췄다고 알려 줄
 *    주체(sweeper)도 워크플로라 같이 멈춘다. 러너는 `vars.FACTORY_RUNNER`가 정한다 — 워크플로는
 *    `${{ vars.FACTORY_RUNNER || 'ubuntu-latest' }}`이므로 **변수가 없으면 호스팅**이다.
 * 2. `plan.free-private` — Free 플랜의 private 저장소에는 브랜치 보호·환경 시크릿·환경 리뷰어가 없다. 두 배우
 *    모드가 조용히 훅 하나로 강등된다(doctor는 지금까지 브랜치 보호만 WARN했다).
 *
 * 입력을 하나라도 못 읽으면 그 판정은 **WARN "unverified"** 다 — PASS가 아니다(모르는 것을 초록으로 그리면
 * 그 검사를 부를 이유가 사라진다; `merge-authority.js`의 UNVERIFIED와 같은 규율). 이 모듈은 `gh`만 받고
 * 다른 doctor 모듈을 import하지 않는다 — `.factory/lib/**`만으로 돌 수 있게.
 */
const c = (id, level, detail = "") => ({ id, level, detail });

export const HOSTED_MINUTES_ID = "actions.hosted-minutes-metered";
export const FREE_PRIVATE_ID = "plan.free-private";
export const RUNNER_VARIABLE = "FACTORY_RUNNER";
/** 워크플로의 `runs-on` 기본값(`vars.FACTORY_RUNNER || 'ubuntu-latest'`). */
export const DEFAULT_HOSTED_LABEL = "ubuntu-latest";

const HOSTED_TEXT = "private repo on GitHub-hosted runners — the included minutes run out and every stage, the sweeper and integrity stop together; set FACTORY_RUNNER to a self-hosted label or make the repo public";
const FREE_TEXT = "branch protection, environment secrets and environment reviewers are unavailable — the two-actor mode degrades to the hook; FACTORY_MERGE_TOKEN cannot live in the factory-merge environment";

/**
 * GitHub 호스팅 러너의 표준 라벨(`ubuntu-latest`·`ubuntu-24.04`·`windows-2022`·`macos-14`…). 그 밖의 라벨은
 * self-hosted로 본다 — 커스텀 라벨을 단 larger hosted runner는 여기서 구별되지 않는다(plan open risk).
 */
export function isHostedRunnerLabel(label) {
  return /^(ubuntu|windows|macos)-[\w.-]+$/i.test(String(label ?? "").trim());
}

const unverified = (id, why) => c(id, "WARN", `unverified — ${why}`);
const errText = (e) => String(e?.message || e || "unknown error").split("\n")[0].slice(0, 200);

export async function checkPlatform({ gh, repo }) {
  if (!repo || !String(repo).includes("/")) {
    const why = "the repository could not be resolved, so its visibility is unknown";
    return [unverified(HOSTED_MINUTES_ID, why), unverified(FREE_PRIVATE_ID, why)];
  }
  const owner = String(repo).split("/")[0];

  let isPrivate = null;
  let visErr = null;
  try {
    if (typeof gh?.repoInfo !== "function") throw new Error("this gh client cannot read repository metadata");
    const info = await gh.repoInfo(repo);
    if (typeof info?.private !== "boolean") throw new Error("no `private` field in the repository metadata");
    isPrivate = info.private;
  } catch (e) {
    visErr = errText(e);
  }
  if (isPrivate === null) {
    const why = `could not read the visibility of ${repo} (${visErr})`;
    return [unverified(HOSTED_MINUTES_ID, why), unverified(FREE_PRIVATE_ID, why)];
  }
  if (!isPrivate) {
    return [
      c(HOSTED_MINUTES_ID, "PASS", `${repo} is public — GitHub-hosted minutes are not metered for public repositories`),
      c(FREE_PRIVATE_ID, "PASS", `${repo} is public — branch protection and environments are available on every plan`),
    ];
  }
  return [await hostedMinutes({ gh, repo }), await freePrivate({ gh, owner })];
}

async function hostedMinutes({ gh, repo }) {
  let v;
  try {
    if (typeof gh?.variableState !== "function") throw new Error("this gh client cannot tell an unset variable from an unreadable one");
    v = await gh.variableState(RUNNER_VARIABLE);
  } catch (e) {
    v = { state: "unreadable", detail: errText(e) };
  }
  if (v?.state === "unset") return c(HOSTED_MINUTES_ID, "WARN", `${HOSTED_TEXT} (${RUNNER_VARIABLE} is unset, so the workflows run on ${DEFAULT_HOSTED_LABEL}; ${repo})`);
  if (v?.state === "set") {
    if (isHostedRunnerLabel(v.value)) return c(HOSTED_MINUTES_ID, "WARN", `${HOSTED_TEXT} (${RUNNER_VARIABLE}=${v.value}; ${repo})`);
    return c(HOSTED_MINUTES_ID, "PASS", `${RUNNER_VARIABLE}=${v.value} — a self-hosted label, so Actions minutes are not metered`);
  }
  return unverified(HOSTED_MINUTES_ID, `${repo} is private but ${RUNNER_VARIABLE} could not be read (${v?.detail || "unknown"}), so whether the stages run on metered GitHub-hosted runners is unknown`);
}

async function freePrivate({ gh, owner }) {
  let plan = null;
  let why = "the token can read neither the owner's account (`gh api user`) nor its organization (`gh api orgs/<owner>`)";
  try {
    if (typeof gh?.ownerPlan !== "function") throw new Error("this gh client cannot read the owner's plan");
    plan = await gh.ownerPlan(owner);
  } catch (e) {
    why = errText(e);
  }
  if (!plan) return unverified(FREE_PRIVATE_ID, `the plan of ${owner} could not be read (${why}) — on the Free plan a private repo has ${FREE_TEXT.split(" — ")[0]}`);
  if (/^free$/i.test(String(plan).trim())) return c(FREE_PRIVATE_ID, "WARN", `${FREE_TEXT} (${owner} is on the ${plan} plan and this repo is private)`);
  return c(FREE_PRIVATE_ID, "PASS", `${owner} is on the ${plan} plan — branch protection and environments are available to private repos`);
}
