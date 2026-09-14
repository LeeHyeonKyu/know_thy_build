import { STATES, TIER_LABELS } from "./labels.js";

/**
 * 머지는 되돌릴 수 없다 — 체크가 하나도 없으면 "전부 통과"가 아니라 "확인 못 함"으로 본다(fail closed).
 * bucket(pass|fail|pending|skipping|cancel)은 최신 gh만 준다. 없으면 state로 떨어진다.
 * required가 있으면 그 이름들만 본다 — 이름마다 모든 동명 체크(commit status + check-run 중복 등)가 다 존재하고
 * 다 pass여야 true(하나라도 없거나 하나라도 안 green이면 false). required=[]는 "설정 안 됨"이지 "무조건 통과"가 아니다 — fail closed로 false.
 * required=null이면 기존 동작(전체 체크가 대상).
 */
const isGreen = (c) => (c.bucket ? c.bucket === "pass" : c.state === "SUCCESS");
export const allChecksGreen = (checks, required = null) => {
  if (required !== null) {
    if (required.length === 0) return false;
    return required.every((name) => {
      const matches = checks.filter((x) => x.name === name);
      return matches.length > 0 && matches.every(isGreen);
    });
  }
  return checks.length > 0 && checks.every(isGreen);
};

/**
 * `gh pr checks`가 **체크가 하나도 없는 PR**에 대해 내는 실패(`no checks reported on the '<branch>'
 * branch`, gh `checks.go`의 `populateStatusChecks`). exit code가 0이 아니라 이 어댑터의 래퍼는
 * 그것을 throw로 올린다 — 그런데 그것은 조회 실패(transport)가 아니라 **판정**이다: 체크가 없다는
 * 사실 자체가 `allChecksGreen([])`이 이미 내리는 그 판정(fail closed)이다.
 *
 * merge 스테이지는 이 구분이 필요 없다(`mergeGates`의 catch가 `checksGreen`을 세우지 않고 떠나면
 * `requirements.js`가 "required checks not verified GREEN"으로 접는다 — 어느 쪽이든 거부다). sweeper의
 * 사람-머지 반영 팔은 transport와 판정을 갈라 다르게 다루므로(전자는 재시도, 후자는 마커) 그 경계를
 * 알아야 한다. 문구를 손으로 베끼지 않도록 여기 한 곳에 둔다(KTB-46 r5).
 */
export const GH_NO_CHECKS_RE = /no (?:required )?checks reported/i;

const STATUS_STATES = new Set(["success", "failure", "pending", "error"]);

// GitHub Free 플랜의 private repo는 branch protection API 자체를 막는다 — gh CLI가 그 사실을 이 문구로
// 알린다(HTTP 403). bootstrap(putBranchProtection 실패 처리)과 doctor(getBranchProtection) 둘 다 이 문구로
// "권한 문제"가 아니라 "이 플랜에서 못 함"을 구분해야 하므로 정규식을 한 곳에서 공유한다.
export const GH_FREE_PLAN_PROTECTION_RE = /Upgrade to GitHub Pro|make this repository public/i;

/**
 * repo 문자열을 결정한다 — `FACTORY_REPO`가 있으면 그걸 쓰고, 없으면 `gh repo view`로 cwd 저장소를 묻는다
 * (status.js가 원래 하던 방식과 동일; KTB-4). doctor.js는 예전에 `process.env.FACTORY_REPO || ""`로
 * 떨어뜨렸는데, 사람이 `factory doctor`를 그냥 저장소 안에서 돌리는 게 정상 케이스라 `FACTORY_REPO`는
 * 보통 비어 있다 — `repo=""`가 되면 `gh api repos//branches/main/protection` 같은 깨진 경로로 호출이
 * 나가고, 404가 아니라서 `null`로 조용히 떨어져 "보호가 없다"는 오보를 낸다. 여기서 실패(로그인 안 됨·
 * git repo 아님)는 삼키지 않고 throw한다 — 호출자가 "확인 못 함"(offline-tolerant WARN)으로 다루게 한다.
 */
export async function resolveRepo({ run }) {
  if (process.env.FACTORY_REPO) return process.env.FACTORY_REPO;
  const r = await run("gh", ["repo", "view", "--json", "nameWithOwner"]);
  if (r.code !== 0) throw new Error(`gh repo view failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`gh repo view returned unparsable JSON: ${e.message}`);
  }
  if (!parsed?.nameWithOwner) throw new Error("gh repo view returned no nameWithOwner");
  return parsed.nameWithOwner;
}

/**
 * ADR-020 KTB-30 — **라벨 변경만은 재시도한다.** 데모에서 두 번(2026-09-13 08:52Z #2, 08:55Z #15)
 * 같은 방식으로 죽었다: `gh issue edit --remove-label … --add-label …` 한 번이 GitHub의 일시 장애로
 * (`GraphQL: Something went wrong while executing your query`, `EOF`) 중간에 실패해 **옛 라벨은
 * 지워지고 새 라벨은 안 붙었다**. 상태 라벨이 0개인 이슈는 `labeled` 이벤트도 못 만들고, 모든
 * sweeper 팔이 상태 라벨로 검색하므로 아무도 다시 보지 않는다 — sweeper를 통째로 빠져나가는
 * 유일한 실패였다. 간격은 1s·3s·9s: GitHub의 이런 장애는 초 단위로 풀리거나 몇 분을 간다(그때는
 * REST 폴백이 답이다 — 실제로 `gh issue edit`이 계속 실패하는 동안 `gh api`는 동작했다).
 */
export const LABEL_RETRY_DELAYS_MS = [1000, 3000, 9000];
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 팩토리 자신의 계정 **이름**(값이 아니다) — commit status의 게시자를 대조할 기준(외부 감사 H1b).
 *
 * 두 배우 모드에서 이 잡의 `GH_TOKEN`은 머지 배우이지만 `factory/review` 상태를 올린 것은 **에이전트
 * 배우**다 — 그래서 둘 다 받는다. 봇 로그인은 워크플로가 `FACTORY_BOT_LOGIN`으로 넘긴다(이름은
 * 비밀이 아니라 env로 옮겨도 사본이 늘지 않는다). 잡 토큰의 로그인조차 해석되지 않으면 `ok:false` —
 * 호출자는 fail closed 한다(누가 올렸는지 모르는 상태는 통과가 아니다).
 *
 * KTB-46에 `bin/sweep.js`가 두 번째 호출자로 붙으면서 `bin/run-stage.js`의 클로저에서 여기로 옮겼다 —
 * `gh api user` 해석이 두 벌이 되면 그 둘이 갈라지는 날 한쪽만 위조 상태를 통과시킨다.
 */
export async function resolveFactoryLogins({ gh, env = process.env }) {
  const logins = [];
  const bot = (env.FACTORY_BOT_LOGIN || "").trim();
  if (bot) logins.push(bot);
  try { logins.push(await gh.viewerLogin()); }
  catch (e) { return { ok: false, reason: `gh api user failed — ${e?.message || e}` }; }
  return { ok: true, logins: [...new Set(logins.filter(Boolean))] };
}

export function makeGh({ run, repo, sleep = realSleep }) {
  async function gh(args, opts = {}) {
    const r = await run("gh", args, opts);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }
  /**
   * 라벨 변경 하나를 끝까지 밀어붙인다: `gh issue edit`을 1s·3s·9s 간격으로 네 번(첫 시도 + 재시도 3회)
   * 시도하고, 그래도 안 되면 **REST 엔드포인트**로 같은 변경을 한 번 더 시도한다. 둘 다 실패하면
   * 처음 에러를 그대로 던진다(사람이 보는 것은 원인이지 폴백의 증상이 아니다 — REST 쪽 메시지는
   * 뒤에 덧붙이고 `restError`로도 단다). 조용한 성공 처리는 하지 않는다: 삼킨 실패가 곧 라벨 0개다.
   */
  async function labelMutation({ what, cli, rest }) {
    let first = null;
    for (let attempt = 0; attempt <= LABEL_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(LABEL_RETRY_DELAYS_MS[attempt - 1]);
      try { return await cli(); }
      catch (e) { first ??= e; }
    }
    try { return await rest(); }
    catch (restErr) {
      first.restError = restErr;
      first.message = `${first.message} — REST fallback (${what}) also failed: ${restErr.message}`;
      throw first;
    }
  }
  return {
    async issue(n) {
      const j = JSON.parse(await gh(["issue", "view", String(n), "-R", repo, "--json", "number,title,body,labels"]));
      return { number: j.number, title: j.title, body: j.body || "", labels: (j.labels || []).map((l) => l.name) };
    },
    /**
     * 이슈가 아직 열려 있는가(ADR-020 KTB-23 fix). `issue()`는 state를 싣지 않는다 — 그 함수는
     * 라벨·본문을 읽는 자리라 필드를 늘리면 모든 호출자가 더 큰 응답을 받는다. sweeper의 하네스
     * 주차 해제 팔만 이 사실을 필요로 하므로 조회를 따로 둔다.
     */
    async issueState(n) {
      const j = JSON.parse(await gh(["issue", "view", String(n), "-R", repo, "--json", "number,state,closedAt"]));
      return { number: j.number, state: j.state, closedAt: j.closedAt ?? null };
    },
    /**
     * 이 브랜치에서 **머지된** PR 번호(없으면 null). 하네스 이슈가 `Closes #<n>` 없이 사람 손에
     * 머지됐을 때 "하네스가 들어왔다"를 말해 주는 유일한 신호다 — builder는 언제나
     * `claude/fq-<issue>`에서 작업하므로(implement 규칙 1) 브랜치 이름이 곧 이슈 번호다.
     */
    async mergedPrForBranch(branch) {
      const j = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", branch, "--state", "merged", "--limit", "5", "--json", "number,mergedAt"]));
      return j.length ? j[0].number : null;
    },
    /**
     * KTB-46 — **머지된 PR의 머지 사실 그 자체.** `mergedPrForBranch`는 번호만 준다("머지된 PR이
     * 있다"). 이슈를 `factory:merged`로 이으려면 그보다 두 가지가 더 필요하다:
     *   - `headSha`: 그 전이의 증거 검사(`requirements.js`의 `factory:merged`)가 review handoff의
     *     `head_sha`를 묶을 대상. 이것이 없으면 "어느 커밋에 대한 승인인가"를 말할 수 없다.
     *   - `mergedBy`: 전이 사유에 실릴 **누가 머지했는가**. 이 경로의 존재 이유가 "사람이 머지했다"
     *     이므로, 그 사람의 이름이 이슈 이력에 남아야 나중에 왜 자동 머지가 아니었는지 읽힌다.
     * `mergeSha`·`mergedAt`은 같은 조회로 공짜라 함께 싣는다(run 기록·retro가 쓸 수 있다).
     * 없는 필드는 지어내지 않고 null이다 — 머지되지 않은 PR에 부르면 전부 null로 답한다.
     */
    async prMergeInfo(pr) {
      const j = JSON.parse(await gh(["pr", "view", String(pr), "-R", repo, "--json", "number,headRefOid,mergeCommit,mergedAt,mergedBy"]));
      return { headSha: j.headRefOid ?? null, mergeSha: j.mergeCommit?.oid ?? null, mergedAt: j.mergedAt ?? null, mergedBy: j.mergedBy?.login ?? null };
    },
    async comments(n) {
      // --paginate 단독은 페이지 배열을 이어붙여 깨진 JSON을 만든다. --slurp이 [[page],[page]]로 감싸주므로 flat()으로 편다.
      const j = JSON.parse(await gh(["api", `repos/${repo}/issues/${n}/comments?per_page=100`, "--paginate", "--slurp"])).flat();
      return j.map((c) => ({ id: c.id, body: c.body || "", createdAt: c.created_at }));
    },
    async comment(n, body) {
      return (await gh(["issue", "comment", String(n), "-R", repo, "--body-file", "-"], { input: body })).trim();
    },
    async addLabels(n, labels) {
      if (!labels.length) return;
      await labelMutation({
        what: `add ${labels.join(", ")} on #${n}`,
        cli: () => gh(["issue", "edit", String(n), "-R", repo, ...labels.flatMap((l) => ["--add-label", l])]),
        rest: () => gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/labels`, ...labels.flatMap((l) => ["-f", `labels[]=${l}`])]),
      });
    },
    async removeLabel(n, label) {
      await labelMutation({
        what: `remove ${label} from #${n}`,
        cli: () => gh(["issue", "edit", String(n), "-R", repo, "--remove-label", label]),
        // 라벨 이름은 `factory:planned`처럼 콜론을 품는다 — 경로 세그먼트이므로 인코딩해서 보낸다.
        rest: () => gh(["api", "-X", "DELETE", `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`]),
      });
    },
    /**
     * factory 상태 라벨을 정확히 하나로 맞춘다 — **먼저 붙이고 나중에 뗀다**(ADR-020 KTB-30).
     *
     * 예전에는 remove+add를 한 번의 `gh issue edit`으로 보냈다. 그 호출이 중간에 실패하면 남는 것은
     * **상태 라벨이 0개인 이슈**이고, 그건 이 공장에서 유일하게 **아무도 보지 못하는** 상태다
     * (`labeled` 이벤트 없음 · 모든 sweeper 팔이 상태 라벨로 검색 · `factory status`에도 안 뜬다).
     * 순서를 뒤집으면 같은 사고의 최악이 "상태 라벨 2개"가 된다 — 그건 sweeper의 라벨-셋 복구 팔이
     * 이미 보고 있고(KTB-18), 이제 최신 전이의 `to`를 남기는 쪽으로 고친다.
     *
     * 쓴 뒤에 **한 번 읽어 확인한다**: 두 호출이 다 exit 0이어도 GitHub이 조용히 흘린 적이 있다.
     * 없으면 한 번 더 붙이고 `verify: "repaired"`로 알린다(전이 코멘트에 한 줄로 남는다).
     * 읽기 자체가 실패하면 스왑을 되돌리지 않는다 — 확인 못 한 것이지 실패한 것이 아니다(`unverified`).
     */
    async setFactoryLabel(n, label) {
      const before = (await this.issue(n)).labels;
      const stale = before.filter((l) => STATES.has(l) && l !== label);
      if (!before.includes(label)) await this.addLabels(n, [label]);
      for (const l of stale) await this.removeLabel(n, l);
      let after;
      try { after = (await this.issue(n)).labels; }
      catch { return { label, removed: stale, verify: "unverified" }; }
      if (after.includes(label)) return { label, removed: stale, verify: "ok" };
      await this.addLabels(n, [label]);
      return { label, removed: stale, verify: "repaired" };
    },
    /**
     * tier 라벨을 정확히 하나로 맞춘다(KTB-9). `setFactoryLabel`을 쓸 수 없다 — 그건 STATES만 보고
     * tier는 상태와 직교하므로, 그 함수를 태우면 상태 라벨이 떨어져 나간다. 상태 라벨과 같은 이유로
     * add-first다(KTB-30): 부분 실패가 "tier 0개"가 아니라 "tier 2개"로 남아야 복구할 수 있다.
     */
    async setTierLabel(n, label) {
      const before = (await this.issue(n)).labels;
      const stale = before.filter((l) => TIER_LABELS.has(l) && l !== label);
      if (!before.includes(label)) await this.addLabels(n, [label]);
      for (const l of stale) await this.removeLabel(n, l);
    },
    async prChecks(pr) {
      return JSON.parse(await gh(["pr", "checks", String(pr), "-R", repo, "--json", "name,state,bucket"]));
    },
    async prHeadSha(pr) {
      return JSON.parse(await gh(["pr", "view", String(pr), "-R", repo, "--json", "headRefOid"])).headRefOid;
    },
    async branchHeadSha(branch) {
      return JSON.parse(await gh(["api", `repos/${repo}/git/ref/heads/${branch}`])).object.sha;
    },
    async createDraftPr({ head, base, title, body }) {
      const out = await gh(["pr", "create", "-R", repo, "--draft", "--head", head, "--base", base, "--title", title, "--body-file", "-"], { input: body });
      const m = /\/pull\/(\d+)/.exec(out); return m ? Number(m[1]) : null;
    },
    /** 사람이 보는(또는 스스로 머지하는) PR — draft가 아니다. 라벨은 생성 시점에 붙인다. */
    async createPr({ head, base, title, body, labels = [] }) {
      const args = ["pr", "create", "-R", repo, "--head", head, "--base", base, "--title", title, "--body-file", "-", ...labels.flatMap((l) => ["--label", l])];
      const out = await gh(args, { input: body });
      const m = /\/pull\/(\d+)/.exec(out); return m ? Number(m[1]) : null;
    },
    async patchComment(commentId, body) {
      // --input stdin JSON avoids -f treating a leading "@" in body as a file reference
      await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "--input", "-"], { input: JSON.stringify({ body }) });
    },
    /**
     * 이 라벨이 붙은 이슈들. 기본은 **열린 것만** — sweeper의 모든 팔과 back-pressure가 묻는 것은
     * "지금 파이프라인 위에 있는 이슈"이기 때문이다.
     *
     * KTB-46: `state: "all"`이 하나 필요해졌다. 사람이 보호 경로 PR을 머지할 때 그 PR 본문의
     * `Closes #<n>`이 실제로 걸리면 이슈는 **`factory:needs-human` 라벨을 그대로 단 채 닫힌다** —
     * 라벨은 상태를 말하는데 그 상태를 아무도 다시 보지 않는 자리다. 그 이슈를 `factory:merged`로
     * 잇는 팔(`sweepHumanMerged`)은 닫힌 것도 봐야 한다. 기본값은 건드리지 않으므로 기존 호출자의
     * 인자 한 글자도 바뀌지 않는다.
     *
     * r3 should_fix 2 — 그런데 `--state all`은 **후보 풀에 바닥이 없다**: 열린 needs-human은 몇 개뿐이지만
     * 닫힌 것은 저장소의 수명 내내 쌓인다. `gh issue list`는 생성 역순으로 답하므로, 그 라벨을 한 번이라도
     * 달았던 이슈가 200개를 넘는 순간 **번호가 낮은 이슈는 페이지에서 떨어진다** — 방금 needs-human이
     * 됐고 방금 사람이 머지한 그 이슈가, 아무 소리 없이. `sort: "updated-desc"`는 정렬을 API 쪽으로
     * 옮겨 그 200개가 "가장 최근에 움직인 200개"가 되게 한다. 정렬 수식어는 `--search`로만 갈 수 있어
     * 그때는 `--label`도 검색 문법(`label:"…"`)으로 옮긴다.
     */
    async searchIssues(label, { state = "open", sort = null } = {}) {
      // 정렬을 쓰는 쪽(사람-머지 반영 팔)만 `state`도 받는다 — 그 팔은 닫힌 이슈까지 보므로 "열려
      // 있는가"가 후보를 자르는 기준의 절반이다(r5 should_fix 2). 기본 호출은 바이트 그대로다.
      const args = sort
        ? ["issue", "list", "-R", repo, "--search", `label:"${label}" sort:${sort}`, "--state", state, "--limit", "200", "--json", "number,title,updatedAt,state"]
        : ["issue", "list", "-R", repo, "--label", label, "--state", state, "--limit", "200", "--json", "number,title,updatedAt"];
      return JSON.parse(await gh(args));
    },
    /**
     * 워크플로를 손으로 띄운다(KTB-8). 라벨은 이미 목적 상태에 있어 `labeled` 이벤트를 다시 만들 수
     * 없으므로, 멈춘 스테이지를 되살리는 경로는 이것뿐이다 — sweeper의 세 번째 팔과
     * `factory run <stage> <issue> --remote`가 같은 호출을 쓴다.
     */
    async dispatchWorkflow(workflow, inputs = {}) {
      await gh(["workflow", "run", workflow, "-R", repo, ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    },
    async createIssue({ title, body, labels = [] }) {
      const out = await gh(["issue", "create", "-R", repo, "--title", title, "--body-file", "-", ...labels.flatMap((l) => ["--label", l])], { input: body });
      const m = /\/issues\/(\d+)/.exec(out); return m ? Number(m[1]) : null;
    },
    // gh variable get exits non-zero for a missing variable — go through run() directly, not the gh() helper that throws on non-zero.
    async getVariable(name) { const r = await run("gh", ["variable", "get", name, "-R", repo]); return r.code === 0 ? r.stdout.trim() : null; },

    /** targetUrl은 옵션 필드 그대로 target_url로 나간다. description은 GitHub API 제한(140자)으로 자른다. */
    async setStatus({ sha, context, state, description, targetUrl }) {
      if (!STATUS_STATES.has(state)) throw new Error(`setStatus: invalid state "${state}" (expected one of ${[...STATUS_STATES].join(", ")})`);
      const body = { state, context, description: (description || "").slice(0, 140), target_url: targetUrl };
      await gh(["api", "-X", "POST", `repos/${repo}/statuses/${sha}`, "--input", "-"], { input: JSON.stringify(body) });
    },
    /**
     * 외부 감사 2026-09-14 H1b — **누가 이 상태를 올렸는가.** `gh pr checks`도 combined status API도
     * 게시자를 싣지 않는다(`allChecksGreen`이 게시자를 검증하지 못한 이유가 그것이다). 목록 API
     * `GET /repos/{repo}/commits/{sha}/statuses`만이 항목마다 `creator`를 준다 — 그리고 **최신순**으로
     * 답하므로, 같은 context가 여러 번 게시됐으면 첫 항목이 지금 유효한 상태다.
     *
     * 조회 대상 sha가 곧 "이 상태가 붙은 커밋"이다 — 호출자가 PR head로 물으면 target sha 검사는
     * 구조적으로 참이 된다(따로 비교할 필드가 없다). 실패는 삼키지 않는다: 머지 스테이지가
     * "확인 못 함"으로 받아 fail closed 한다.
     */
    async commitStatuses(sha) {
      const j = JSON.parse(await gh(["api", `repos/${repo}/commits/${sha}/statuses?per_page=100`, "--paginate", "--slurp"])).flat();
      return j.map((s) => ({ context: s.context, state: s.state, creatorLogin: s.creator?.login ?? null, createdAt: s.created_at }));
    },
    async listSecrets() {
      return JSON.parse(await gh(["secret", "list", "-R", repo, "--json", "name"])).map((s) => s.name);
    },
    /**
     * ADR-021 r2 (KTB-33 finding MF-A) — **환경 시크릿은 저장소 시크릿과 다른 목록이다.**
     * `listSecrets()`는 `gh secret list -R`(저장소 시크릿)만 보는데, 소유자 체크리스트는 정확히
     * `FACTORY_MERGE_TOKEN`을 `factory-merge` **환경** 시크릿으로 옮기고 저장소 사본을 지우라고
     * 시킨다(ADR-021 r1의 위험 문구가 이유였다) — 그 권고를 따른 저장소는 `listSecrets()`만 보는
     * 판정에서 영원히 단일 배우 모드로 보이고, 재부트스트랩은 코드 오너 요건이 빠진 보호 규칙을
     * 덮어쓴다.
     *
     * `getBranchProtection`·`getVariable`과 같은 패턴이다: gh가 0이 아닌 종료 코드로 답하면(환경이
     * 아직 없거나 이 플랜이 환경을 지원하지 않는 경우) "확인 못 함"이 아니라 "시크릿이 없다"이므로
     * throw하지 않고 빈 배열로 떨어뜨린다. stdout이 JSON으로 파싱되지 않아도(빈 문자열 등) 마찬가지다.
     */
    async listEnvSecrets(envName) {
      const r = await run("gh", ["secret", "list", "--env", envName, "-R", repo, "--json", "name"]);
      if (r.code !== 0) return [];
      try { return JSON.parse(r.stdout).map((s) => s.name); }
      catch { return []; }
    },
    async listLabels() {
      return JSON.parse(await gh(["label", "list", "-R", repo, "--json", "name", "--limit", "200"])).map((l) => l.name);
    },
    async createLabel({ name, color, description }) {
      await gh(["label", "create", name, "-R", repo, "--color", color, "--description", description, "--force"]);
    },
    // gh api exits non-zero for an unprotected branch (404) — go through run() directly, like getVariable.
    // Exception: a GitHub Free private-repo 403 is not "unprotected", it's "this plan can't have protection" —
    // callers (doctor) need to tell the two apart, so that one case throws instead of resolving to null.
    async getBranchProtection(branch) {
      const r = await run("gh", ["api", `repos/${repo}/branches/${branch}/protection`]);
      if (r.code === 0) return JSON.parse(r.stdout);
      if (GH_FREE_PLAN_PROTECTION_RE.test(r.stderr)) throw new Error(r.stderr.trim() || r.stdout.trim());
      return null;
    },
    async putBranchProtection(branch, body) {
      await gh(["api", "-X", "PUT", `repos/${repo}/branches/${branch}/protection`, "--input", "-"], { input: JSON.stringify(body) });
    },
    async setVariable(name, value) {
      await gh(["variable", "set", name, "-R", repo, "--body", value]);
    },
    async prView(pr) {
      const j = JSON.parse(await gh(["pr", "view", String(pr), "-R", repo, "--json", "number,state,mergeable,headRefName,headRefOid,baseRefName,labels"]));
      return { number: j.number, state: j.state, mergeable: j.mergeable, headRefName: j.headRefName, headRefOid: j.headRefOid, baseRefName: j.baseRefName, labels: (j.labels || []).map((l) => l.name) };
    },
    /**
     * draft PR을 ready-for-review로 뒤집는다(KTB-15). implement는 **일부러** `--draft`로 PR을 연다 —
     * 리뷰가 끝나기 전에 사람이 머지 버튼을 누르는 것을 막는 신호다. 그 대가로 머지 직전에 이걸
     * 한 번 불러야 한다: draft인 채로 `gh pr merge`를 부르면 GitHub이 GraphQL 단에서
     * `Pull Request is still a draft`로 거부한다(데모 #8이 여기서 죽었다).
     * 이미 ready인 PR에 불러도 gh는 exit 0이다 — 멱등이라 재시도 경로에서 따로 상태를 묻지 않는다.
     */
    async prReady(pr) {
      await gh(["pr", "ready", String(pr), "-R", repo]);
    },
    /**
     * ADR-021 — 두 배우 모드의 승인 한 번. **머지 배우의 토큰으로만** 의미가 있다: PR을 연 계정
     * (에이전트 배우)이 이걸 부르면 GitHub이 422(`Can not approve your own pull request`)로 거부하고,
     * 그 거부가 곧 이 설계가 증명하려는 사실이다 — 에이전트가 쥔 토큰으로는 승인도, 따라서 머지도
     * 할 수 없다. 실패는 삼키지 않는다(호출자가 `needs-human`으로 올린다).
     */
    async approvePr(pr, body = "factory: approved by the merge actor (two-actor mode, ADR-021)") {
      await gh(["pr", "review", String(pr), "-R", repo, "--approve", "--body-file", "-"], { input: body });
    },
    /**
     * ADR-021 doctor — **지금 이 토큰이 누구인가**. 값은 절대 찍지 않고 로그인 이름만 돌려준다.
     * `gh api user`는 PAT이 붙은 계정을 그대로 말한다(GitHub App 설치 토큰이면 `<app>[bot]`).
     */
    async viewerLogin() {
      return JSON.parse(await gh(["api", "user"])).login;
    },
    /**
     * ADR-021 r1 MF-2 a — **지금 이 토큰이 어떤 스코프를 쥐고 있는가.** classic PAT은 응답 헤더
     * `X-OAuth-Scopes`로 자기 스코프를 말한다(`gh api -i`가 헤더를 함께 찍는다). 값 자체는 절대
     * 읽지 않는다 — 묻는 것은 "이 토큰에 `workflow`가 붙어 있는가" 하나다.
     *
     * `null`은 "모른다"가 아니라 **"classic PAT이 아니다"**의 신호다(fine-grained PAT·GitHub App
     * 설치 토큰·GITHUB_TOKEN에는 이 헤더가 없다). 그 토큰들에는 classic `workflow` 스코프라는
     * 개념 자체가 없으므로 doctor는 그 경우를 통과로 읽는다 — 없는 위험을 경보로 만들지 않는다.
     */
    async viewerScopes() {
      const r = await run("gh", ["api", "-i", "user"]);
      if (r.code !== 0) throw new Error(`gh api -i user failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
      // `\s`는 `\r`·`\n`도 먹는다 — 헤더가 비어 있으면(`x-oauth-scopes: `) 그 다음 빈 줄을 건너뛰고
      // **본문의 첫 줄**을 스코프로 읽는다(= `{}`가 스코프가 된다). 줄 안에서만 본다.
      const m = /^x-oauth-scopes:[^\S\r\n]*([^\r\n]*)$/im.exec(r.stdout);
      if (!m) return null;
      return m[1].split(",").map((s) => s.trim()).filter(Boolean);
    },
    /**
     * ADR-021 r1 MF-2 b — `factory-merge` 환경을 만든다(멱등: 같은 body의 PUT을 반복해도 같은 결과).
     * `deployment_branch_policy.protected_branches: true`가 이 환경의 시크릿을 **보호된 브랜치에서
     * 시작한 잡에만** 준다 — 에이전트의 `claude/fq-*` 브랜치에서 도는 워크플로는 빈 문자열을 본다.
     */
    async putEnvironment(name, body) {
      await gh(["api", "-X", "PUT", `repos/${repo}/environments/${name}`, "--input", "-"], { input: JSON.stringify(body) });
    },
    /**
     * ADR-021 doctor — 그 계정이 이 저장소에 대해 가진 권한(`admin`|`maintain`|`write`|`triage`|`read`).
     * 두 배우 모드에서 에이전트 배우가 `admin`이면 branch protection의 승인 요건을 **스스로 바꿀 수**
     * 있으므로 두 배우 모드는 이름만 남는다 — doctor가 FAIL로 세운다.
     */
    async collaboratorPermission(login) {
      return JSON.parse(await gh(["api", `repos/${repo}/collaborators/${login}/permission`])).permission;
    },
    async mergePr(pr, { method = "squash", deleteBranch = true } = {}) {
      const args = ["pr", "merge", String(pr), "-R", repo, `--${method}`];
      if (deleteBranch) args.push("--delete-branch");
      await gh(args);
    },
    async closeIssue(n, comment) {
      const args = ["issue", "close", String(n), "-R", repo];
      if (comment) args.push("--comment", comment);
      await gh(args);
    },
    async issueList({ labels = [], state = "open", limit = 200 } = {}) {
      // body까지 받는다(ADR-020 KTB-23 fix) — `factory:harness` 이슈의 dedupe 키는 제목이 아니라
      // 본문의 `<!-- factory-harness-request for=<n> -->` 마커다(제목은 사람이 고쳐도 되는 줄이다).
      const args = ["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), ...labels.flatMap((l) => ["--label", l]), "--json", "number,title,body,labels,updatedAt,closedAt"];
      const j = JSON.parse(await gh(args));
      return j.map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", labels: (i.labels || []).map((l) => l.name), updatedAt: i.updatedAt, closedAt: i.closedAt }));
    },
    async prList({ label, state = "open" } = {}) {
      const args = ["pr", "list", "-R", repo, "--state", state];
      if (label) args.push("--label", label);
      // body까지 받는다 — retro의 제안 PR dedup은 본문 첫 줄의 기계 마커(`factory-retro:v1 period=…`)로
      // 같은 창을 알아본다(제목만으로는 기간 표기가 바뀌는 순간 중복을 놓친다).
      args.push("--json", "number,title,body,headRefName,updatedAt");
      const j = JSON.parse(await gh(args));
      return j.map((p) => ({ number: p.number, title: p.title, body: p.body ?? "", headRefName: p.headRefName, updatedAt: p.updatedAt }));
    },
  };
}
