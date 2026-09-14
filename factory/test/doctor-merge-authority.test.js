import { test, expect } from "vitest";
import { checkMergeAuthority, isCiWithToken, downgradeUnknownMode } from "../lib/doctor/merge-authority.js";
import { codeownersContent } from "../lib/bootstrap.js";

/**
 * ADR-021 fix round r1 — `protection.codeowners`(MF-1)와 `tokens.agent-workflow-scope`(MF-2 a),
 * 그리고 "CI 밖의 skip은 PASS가 아니라 WARN"(finding 2).
 *
 * 이 판정들이 `doctor/factory.js`가 아니라 `doctor/merge-authority.js`에 사는 이유가 이 파일에도 있다:
 * `factory init`이 설치하는 트리에는 `cli/`가 없어 `doctor/factory.js`는 로드조차 되지 않는다 —
 * CI(`.factory/bin/doctor-ci.js`)가 부를 수 있으려면 `lib/**`만으로 닫혀 있어야 한다.
 */

const by = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const CI = { CI: "true", FACTORY_BOT_TOKEN: "x" };
const TWO = ["FACTORY_BOT_TOKEN", "FACTORY_MERGE_TOKEN"];
const SINGLE = ["FACTORY_BOT_TOKEN"];
const PROTECTED = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: true } };
const OWNERS = "* @owner-human\n";

const gh = ({ login = "factory-bot", permission = "write", scopes = ["repo", "read:org"] } = {}) => ({
  viewerLogin: async () => login,
  collaboratorPermission: async () => permission,
  viewerScopes: async () => scopes,
});

const run = (opts = {}) =>
  checkMergeAuthority({
    gh: gh(opts.gh),
    secrets: opts.secrets ?? TWO,
    branch: "main",
    protection: "protection" in opts ? opts.protection : PROTECTED,
    protectionUnavailable: false,
    env: opts.env ?? CI,
    codeowners: "codeowners" in opts ? opts.codeowners : OWNERS,
  }).then(by);

// ── protection.codeowners (MF-1) ────────────────────────────────────────────

test("protection.codeowners: two-actor mode with no CODEOWNERS is a FAIL — the code-owner requirement has no owner to require", async () => {
  const c = await run({ codeowners: null });
  expect(c["protection.codeowners"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("missing") });
  expect(c["protection.codeowners"].detail).toMatch(/base branch/);   // 파일은 base 브랜치에 있어야 효력이 있다
});

test("protection.codeowners: a CODEOWNERS with no owner for `*` is a FAIL — a path with no owner needs no code-owner approval", async () => {
  const c = await run({ codeowners: "# nobody owns anything\ndocs/ @someone\n" });
  expect(c["protection.codeowners"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("no owner for") });
});

test("protection.codeowners: in CI, the AGENT actor appearing as a code owner is a FAIL — it could then approve its way to a merge again", async () => {
  const c = await run({ codeowners: "* @owner-human @factory-bot\n" });
  expect(c["protection.codeowners"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("@factory-bot") });
  expect(c["protection.codeowners"].detail).toMatch(/AGENT actor/);

  // 대소문자는 가리지 않는다 — GitHub 로그인이 그렇다.
  const mixed = await run({ codeowners: "* @Factory-Bot\n" });
  expect(mixed["protection.codeowners"].level).toBe("FAIL");
});

test("protection.codeowners: in CI, an owner list without the agent actor is a PASS naming both sides", async () => {
  const c = await run();
  expect(c["protection.codeowners"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("@owner-human") });
  expect(c["protection.codeowners"].detail).toContain("@factory-bot");
});

test("protection.codeowners: the bootstrap-written file passes its own check — the template names only the merge actor", async () => {
  const c = await run({ codeowners: codeownersContent("owner-human") });
  expect(c["protection.codeowners"].level).toBe("PASS");
});

test("protection.codeowners: locally (no CI token) the file is seen but the agent-login check is WARN 'unverified until CI', and gh is never asked", async () => {
  let asked = false;
  const client = gh();
  client.viewerLogin = async () => { asked = true; return "someone"; };
  const c = by(await checkMergeAuthority({ gh: client, secrets: TWO, branch: "main", protection: PROTECTED, env: {}, codeowners: OWNERS }));
  expect(c["protection.codeowners"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("unverified until CI") });
  expect(asked).toBe(false);

  // 파일 자체가 없다는 사실은 로컬에서도 확인할 수 있다 — 그것은 그대로 FAIL이다.
  const missing = by(await checkMergeAuthority({ gh: client, secrets: TWO, branch: "main", protection: PROTECTED, env: {}, codeowners: null }));
  expect(missing["protection.codeowners"].level).toBe("FAIL");
});

test("protection.codeowners: single-actor mode does not require a code owner — there is no second account to be one", async () => {
  const c = await run({ secrets: SINGLE, protection: { required_pull_request_reviews: null }, codeowners: null });
  expect(c["protection.codeowners"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("single-actor") });
});

// ── tokens.agent-workflow-scope (MF-2 a) ────────────────────────────────────

test("tokens.agent-workflow-scope: the classic `workflow` scope on the agent PAT is a FAIL in two-actor mode — it is secret exfiltration, not a merge", async () => {
  const c = await run({ gh: { scopes: ["repo", "workflow"] } });
  expect(c["tokens.agent-workflow-scope"]).toMatchObject({ level: "FAIL", detail: expect.stringContaining("workflow") });
  expect(c["tokens.agent-workflow-scope"].detail).toMatch(/same-repo branch is handed the repository secrets/);
  // 고침은 "PAT을 repo만으로 다시 발급하라"이고, sweeper의 dispatch는 그것으로 충분하다는 사실을 함께 말한다.
  expect(c["tokens.agent-workflow-scope"].detail).toMatch(/needs `repo`, not `workflow`/);

  const single = await run({ secrets: SINGLE, gh: { scopes: ["repo", "workflow"] }, protection: { required_pull_request_reviews: null }, codeowners: null });
  expect(single["tokens.agent-workflow-scope"].level).toBe("WARN");
});

test("tokens.agent-workflow-scope: `repo` without `workflow` is a PASS that says what GitHub then refuses", async () => {
  const c = await run();
  expect(c["tokens.agent-workflow-scope"]).toMatchObject({ level: "PASS", detail: expect.stringContaining(".github/workflows") });
});

test("tokens.agent-workflow-scope: a token with no X-OAuth-Scopes header is not a classic PAT — PASS, because the scope does not exist there", async () => {
  const c = await run({ gh: { scopes: null } });
  expect(c["tokens.agent-workflow-scope"]).toMatchObject({ level: "PASS", detail: expect.stringContaining("not a classic PAT") });
});

test("tokens.agent-workflow-scope: an unreadable scope list is WARN, never a silent PASS", async () => {
  const client = gh();
  client.viewerScopes = async () => { throw new Error("gh api -i user failed (1): Bad credentials"); };
  const c = by(await checkMergeAuthority({ gh: client, secrets: TWO, branch: "main", protection: PROTECTED, env: CI, codeowners: OWNERS }));
  expect(c["tokens.agent-workflow-scope"]).toMatchObject({ level: "WARN", detail: expect.stringContaining("Bad credentials") });
});

// ── finding 2: the local skip is WARN, and the token value is never printed ──

test("the three CI-only checks are WARN 'unverified until CI' locally — a never-evaluated invariant must not read green", async () => {
  const c = by(await checkMergeAuthority({ gh: gh(), secrets: TWO, branch: "main", protection: PROTECTED, env: {}, codeowners: OWNERS }));
  for (const id of ["protection.codeowners", "tokens.agent-is-admin", "tokens.agent-workflow-scope"]) {
    expect(c[id].level, id).toBe("WARN");
    expect(c[id].detail, id).toContain("unverified until CI");
  }
});

test("no check ever prints a token value — only logins, permission grades and scope names", async () => {
  const c = await run({ env: { CI: "true", GH_TOKEN: "ghp_supersecretvalue" }, gh: { permission: "admin", scopes: ["repo", "workflow"] } });
  const all = Object.values(c).map((x) => `${x.id} ${x.detail}`).join("\n");
  expect(all).not.toContain("ghp_supersecretvalue");
  expect(c["tokens.agent-is-admin"].level).toBe("FAIL");
});

test("isCiWithToken: both CI and a token are required — neither alone", () => {
  expect(isCiWithToken({ CI: "true", GH_TOKEN: "x" })).toBe(true);
  expect(isCiWithToken({ CI: "true", FACTORY_BOT_TOKEN: "x" })).toBe(true);
  expect(isCiWithToken({ CI: "true" })).toBe(false);
  expect(isCiWithToken({ GH_TOKEN: "x" })).toBe(false);
  expect(isCiWithToken(undefined)).toBe(false);
});

// ── finding 2: the CI entry point's "mode unknown" downgrade ────────────────

test("downgradeUnknownMode: FAIL becomes WARN and says why — a repo that never ran bootstrap must not sit permanently red", () => {
  const before = [
    { id: "protection.codeowners", level: "FAIL", detail: "missing" },
    { id: "tokens.agent-is-admin", level: "PASS", detail: "factory-bot: write" },
    { id: "tokens.agent-workflow-scope", level: "WARN", detail: "could not read" },
  ];
  const after = downgradeUnknownMode(before, "FACTORY_TWO_ACTOR");
  expect(after.map((c) => c.level)).toEqual(["WARN", "PASS", "WARN"]);
  expect(after[0].detail).toContain("missing");                       // 원래 사유는 남는다
  expect(after[0].detail).toMatch(/downgraded: FACTORY_TWO_ACTOR is not set/);
  expect(after[0].detail).toMatch(/factory bootstrap/);
  expect(after[1]).toEqual(before[1]);                                // FAIL이 아닌 줄은 손대지 않는다
});
