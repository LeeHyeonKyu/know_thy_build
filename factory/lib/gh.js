import { STATES } from "./labels.js";

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
      // --paginate concatenates page arrays into invalid JSON; >100 comments/issue is out of 1.0 scope.
      const j = JSON.parse(await gh(["api", `repos/${repo}/issues/${n}/comments?per_page=100`]));
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
      await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`]);
    },
  };
}
