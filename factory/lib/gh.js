import { STATES } from "./labels.js";

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
    async getBranchProtection(branch) {
      const r = await run("gh", ["api", `repos/${repo}/branches/${branch}/protection`]);
      return r.code === 0 ? JSON.parse(r.stdout) : null;
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
