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
    const found = JSON.parse(gh(["pr", "list", "-R", repo, "--head", `claude/fq-${issue}`, "--state", "merged", "--limit", "5", "--json", "number,files"]));
    if (found.length) pr = { number: found[0].number, files: found[0].files.map((f) => f.path) };
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

const root = process.argv[2];
grab({ repo: "LeeHyeonKyu/know_thy_build", issue: 18, recordRef: "factory/records", out: `${root}/factory/test/fixtures/ktb-18.json` });
grab({ repo: "LeeHyeonKyu/own-calendar", issue: 3, recordRef: "factory/records", out: `${root}/factory/test/fixtures/own-calendar-3.json` });
