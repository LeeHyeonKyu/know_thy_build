// 회귀 픽스처를 **실제 저장소에서** 받아 적는다(리뷰 should_fix 8). 손으로 빚은 모양은 라우팅이
// 뒤집혀 있어도 초록으로 남는다 — 이 스크립트가 만든 파일만 테스트가 읽는다.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const api = (p, extra = []) => JSON.parse(gh(["api", p, ...extra]));

function grab({ repo, issue, recordRef, out }) {
  const meta = api(`repos/${repo}/issues/${issue}`);
  const recordB64 = api(`repos/${repo}/contents/docs/factory/runs/${issue}.md?ref=${recordRef}`).content;
  const record = Buffer.from(recordB64, "base64").toString("utf8");
  const all = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--slurp"])).flat();
  /**
   * **하트비트만** 싣는다 — 원문 그대로, 자르지 않는다.
   *
   * 건강 잡의 판정 재료는 둘뿐이다: run 기록의 `review-evidence:` 줄(위 `record`, 전문)과, 그 줄을
   * 이 이슈의 런에 묶어 주는 하트비트(`knownRunsFor`). review 핸드오프는 방아쇠가 아닌 must_fix
   * 참고 열에만 쓰이는데 본문이 이슈당 ~350KB라, 실으면 `factory/`를 통째로 복사하는 다른 테스트
   * (qa-evidence의 공백 경로 테스트)가 5초 예산을 넘긴다. 자르는 대신 **빼는** 이유는 같은 규율이다:
   * 손으로 줄인 본문은 더 이상 실제 생산자가 낸 모양이 아니다.
   */
  const comments = all
    .filter((c) => /factory-heartbeat/.test(c.body || ""))
    .map((c) => ({ id: c.id, createdAt: c.created_at, author: c.user?.login ?? null, body: c.body }));
  /**
   * 머지된 PR과 **그 PR이 건드린 경로들**(r2 항목 1). 경로는 GitHub이 diff에서 계산한 사실이고,
   * builder는 언제나 `claude/fq-<issue>`에서 작업하므로 브랜치 이름이 곧 이슈 번호다 — 그래서 이
   * 조회에는 에이전트가 적은 값이 한 글자도 끼지 않는다.
   */
  let pr = null;
  try {
    // **머지된 PR 전부**를 머지 시각 내림차순으로. 재작업이 같은 브랜치에 두 번 머지할 수 있고,
    // 그때 diff의 모양은 둘을 합친 것이다(`gh pr list`는 *생성* 순이라 정렬을 우리가 한다).
    const found = JSON.parse(gh(["pr", "list", "-R", repo, "--head", `claude/fq-${issue}`, "--state", "merged", "--limit", "20", "--json", "number,mergedAt,files"]))
      .sort((a, b) => (Date.parse(b.mergedAt) || 0) - (Date.parse(a.mergedAt) || 0));
    if (found.length) {
      const union = [...new Set(found.flatMap((p) => p.files.map((f) => f.path)))];
      pr = { number: found[0].number, numbers: found.map((p) => p.number), files: union };
    }
  } catch { pr = null; }

  const doc = {
    _source: `${repo}#${issue} — issue metadata + docs/factory/runs/${issue}.md on branch ${recordRef} + heartbeat comments + the merged PR's file list`,
    _fetched: new Date().toISOString().slice(0, 10),
    _note: "REAL text, fetched with `gh api`, verbatim and untruncated. Do not hand-edit — regenerate with the script named in _source_script. Review HANDOFF comments are deliberately excluded (see the comment in that script): they are ~350KB/issue and feed only a non-triggering reference column.",
    _source_script: "factory/test/fixtures/refresh.mjs",
    issue: {
      number: meta.number, title: meta.title,
      state: meta.state, closedAt: meta.closed_at, updatedAt: meta.updated_at,
      labels: meta.labels.map((l) => ({ name: l.name })),
    },
    record,
    comments,
    pr,
  };
  mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  const ev = (record.match(/^review-evidence:/gm) || []).length;
  console.log(`${out}: ${record.length}B record, ${comments.length} comments, ${ev} review-evidence line(s), labels ${doc.issue.labels.map((l) => l.name).join("+")}, PR ${pr ? `#${pr.number} [${pr.files.join(", ")}]` : "none"}`);
}

/**
 * T7 — 공유 신원(shared factory/owner identity)의 회귀 표본. 여기서 필요한 것은 run 기록이 아니라
 * **작성자 사실**이다: 누가 썼는가(`user.login`), 그 계정이 어떤 종류인가(`user.type`), GitHub App을
 * 통해 왔는가(`performed_via_github_app`). 셋 다 GitHub이 계정과 요청에 붙이는 값이라 코멘트를 적는
 * 쪽이 고를 수 없다 — 귀속 판정이 앵커할 수 있는 유일한 종류의 사실이다(플랜 Global Constraints).
 *
 * 본문은 **전부 싣는다**(자르지 않는다): `human-decision:v1` 마커도 하트비트의 바이트 0 규칙도
 * 본문 위에서 판정되므로, 줄이는 순간 그 판정을 더는 실물로 확인할 수 없다.
 */
function grabComments({ repo, issue, out }) {
  const all = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--slurp"])).flat();
  const comments = all.map((c) => ({
    id: c.id,
    createdAt: c.created_at,
    author: c.user?.login ?? null,
    authorType: c.user?.type ?? null,
    viaApp: c.performed_via_github_app ? (c.performed_via_github_app.slug ?? c.performed_via_github_app.name ?? true) : null,
    body: c.body || "",
  }));
  const doc = {
    _source: `${repo}#${issue} — every issue comment, verbatim, with the author facts GitHub attaches (user.login, user.type, performed_via_github_app)`,
    _fetched: new Date().toISOString().slice(0, 10),
    _note: "REAL text, fetched with `gh api … /comments --paginate --slurp`, verbatim and untruncated. Do not hand-edit — regenerate with the script named in _source_script. This is the shared-identity regression sample: FACTORY_BOT_TOKEN on this repo is the owner's PAT, so every comment — the factory's and the owner's alike — carries author LeeHyeonKyu (type User) and no GitHub App.",
    _source_script: "factory/test/fixtures/refresh.mjs",
    comments,
  };
  mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  const authors = [...new Set(comments.map((c) => `${c.author}:${c.authorType}`))];
  console.log(`${out}: ${comments.length} comments, authors ${authors.join(", ")}, viaApp ${[...new Set(comments.map((c) => String(c.viaApp)))].join(", ")}`);
}

/**
 * #36 — **사람이 머지한 이슈의 전체 타임라인**. 위의 `grab`은 하트비트만 싣고(건강 잡의 재료가
 * 그것뿐이라서), `grabComments`는 run 기록을 싣지 않는다. KTB #36 item 1이 고치는 결함은 그 둘
 * **사이**에 산다: 사람이 PR을 머지한 뒤 sweeper가 `factory:needs-human → factory:merged` 전이를
 * 쓰기까지의 순서를 봐야 하고(전이 코멘트), 그 순간 라우팅이 읽을 증거는 run 기록에 있다.
 * 그래서 이슈 메타 + run 기록 + **코멘트 전부**를 원문 그대로 싣는다 — 어느 것도 자르지 않는다.
 */
function grabTimeline({ repo, issue, recordRef, out }) {
  const meta = api(`repos/${repo}/issues/${issue}`);
  let record = "";
  try {
    record = Buffer.from(api(`repos/${repo}/contents/docs/factory/runs/${issue}.md?ref=${recordRef}`).content, "base64").toString("utf8");
  } catch { record = ""; }
  const all = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--slurp"])).flat();
  const comments = all.map((c) => ({
    id: c.id,
    createdAt: c.created_at,
    author: c.user?.login ?? null,
    authorType: c.user?.type ?? null,
    // r1 리뷰 nit 5 — `gh.comments`가 돌려주는 필드를 **하나도 빼지 않는다**(`grabComments`와 같은 모양).
    // `viaApp`이 빠지면 이 픽스처 위의 신원 판정은 실제 저장소가 주는 것보다 **모르는 상태**에서
    // 돌게 되고, 그 차이가 초록인 채로 남는다(공유 신원 경보가 바로 이 필드로 갈린다).
    viaApp: c.performed_via_github_app ? (c.performed_via_github_app.slug ?? c.performed_via_github_app.name ?? true) : null,
    body: c.body || "",
  }));
  const doc = {
    _source: `${repo}#${issue} — issue metadata + docs/factory/runs/${issue}.md on branch ${recordRef} + EVERY issue comment`,
    _fetched: new Date().toISOString().slice(0, 10),
    _note: "REAL text, fetched with `gh api`, verbatim and untruncated. Do not hand-edit — regenerate with the script named in _source_script.",
    _source_script: "factory/test/fixtures/refresh.mjs",
    issue: {
      number: meta.number, title: meta.title,
      state: meta.state, closedAt: meta.closed_at, updatedAt: meta.updated_at,
      labels: meta.labels.map((l) => ({ name: l.name })),
    },
    record,
    comments,
  };
  mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${out}: ${record.length}B record, ${comments.length} comments, labels ${doc.issue.labels.map((l) => l.name).join("+")}`);
}

const root = process.argv[2];
/**
 * `node refresh.mjs <root> [fixture-file-name …]` — 이름을 주면 그 픽스처만 다시 받는다.
 * 하나를 더할 때 **나머지 픽스처를 통째로 다시 쓰지 않기 위한** 필터다: 다른 저장소의 타임라인이
 * 그 사이에 움직였으면 무관한 diff가 같은 커밋에 섞이고, 그 diff는 아무도 읽지 않는다.
 */
const only = process.argv.slice(3);
const want = (name) => !only.length || only.includes(name);
const at = (name) => `${root}/factory/test/fixtures/${name}`;
if (want("ktb-18.json")) grab({ repo: "LeeHyeonKyu/know_thy_build", issue: 18, recordRef: "factory/records", out: at("ktb-18.json") });
if (want("own-calendar-3.json")) grab({ repo: "LeeHyeonKyu/own-calendar", issue: 3, recordRef: "factory/records", out: at("own-calendar-3.json") });
if (want("demo-39-comments.json")) grabComments({ repo: "LeeHyeonKyu/know-thy-build-demo", issue: 39, out: at("demo-39-comments.json") });
if (want("demo-45-comments.json")) grabTimeline({ repo: "LeeHyeonKyu/know-thy-build-demo", issue: 45, recordRef: "factory/records", out: at("demo-45-comments.json") });
