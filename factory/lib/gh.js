import { STATES } from "./labels.js";

/**
 * 머지는 되돌릴 수 없다 — 체크가 하나도 없으면 "전부 통과"가 아니라 "확인 못 함"으로 본다(fail closed).
 * bucket(pass|fail|pending|skipping|cancel)은 최신 gh만 준다. 없으면 state로 떨어진다.
 */
export const allChecksGreen = (checks) => checks.length > 0 && checks.every((c) => (c.bucket ? c.bucket === "pass" : c.state === "SUCCESS"));

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
  };
}
