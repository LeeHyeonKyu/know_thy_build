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

export function makeGh({ run, repo }) {
  async function gh(args, opts = {}) {
    const r = await run("gh", args, opts);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }
  return {
    async issue(n) {
      const j = JSON.parse(await gh(["issue", "view", String(n), "-R", repo, "--json", "number,title,body,labels"]));
      return { number: j.number, title: j.title, body: j.body || "", labels: (j.labels || []).map((l) => l.name) };
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
      await gh(["issue", "edit", String(n), "-R", repo, ...labels.flatMap((l) => ["--add-label", l])]);
    },
    async removeLabel(n, label) {
      await gh(["issue", "edit", String(n), "-R", repo, "--remove-label", label]);
    },
    /** factory 상태 라벨을 정확히 하나로 맞춘다. */
    async setFactoryLabel(n, label) {
      const current = (await this.issue(n)).labels.filter((l) => STATES.has(l) && l !== label);
      const args = ["issue", "edit", String(n), "-R", repo, ...current.flatMap((l) => ["--remove-label", l]), "--add-label", label];
      await gh(args);
    },
    /**
     * tier 라벨을 정확히 하나로 맞춘다(KTB-9). `setFactoryLabel`을 쓸 수 없다 — 그건 STATES만 보고
     * tier는 상태와 직교하므로, 그 함수를 태우면 상태 라벨이 떨어져 나간다. 한 호출로 끝낸다
     * (`gh issue edit`은 remove/add를 한 번에 받는다).
     */
    async setTierLabel(n, label) {
      const stale = (await this.issue(n)).labels.filter((l) => TIER_LABELS.has(l) && l !== label);
      await gh(["issue", "edit", String(n), "-R", repo, ...stale.flatMap((l) => ["--remove-label", l]), "--add-label", label]);
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
    async searchIssues(label) {
      return JSON.parse(await gh(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--limit", "200", "--json", "number,title,updatedAt"]));
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
    async listSecrets() {
      return JSON.parse(await gh(["secret", "list", "-R", repo, "--json", "name"])).map((s) => s.name);
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
      const args = ["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), ...labels.flatMap((l) => ["--label", l]), "--json", "number,title,labels,updatedAt,closedAt"];
      const j = JSON.parse(await gh(args));
      return j.map((i) => ({ number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name), updatedAt: i.updatedAt, closedAt: i.closedAt }));
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
