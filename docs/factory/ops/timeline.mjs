// usage: node timeline.mjs <owner/repo> <issue> <sinceISO>
// 이슈의 스테이지 잡마다 생성·시작·종료 시각을 Actions API에서 읽어 큐 대기와 실행 시간을 낸다.
import { execFileSync } from "node:child_process";
const [repo, issue, since] = process.argv.slice(2);
const gh = (...a) => JSON.parse(execFileSync("gh", ["api", "--paginate", ...a], { encoding: "utf8", maxBuffer: 1e9 }));
const runs = gh(`repos/${repo}/actions/runs?created=>=${since}&per_page=100`, "--jq", ".workflow_runs").flat();
const rows = []; const tally = {};
for (const r of runs) {
  tally[r.name] ??= {}; tally[r.name][r.conclusion ?? r.status] = (tally[r.name][r.conclusion ?? r.status] || 0) + 1;
  if (r.conclusion === "skipped" || !/^factory-(triage|plan|implement|review|merge|integrity|retro)$/.test(r.name)) continue;
  const stage = /^factory-(triage|plan|implement|review|merge)$/.test(r.name);
  if (stage && !new RegExp(`(^|\\D)${issue}(\\D|$)`).test(`${r.display_title} ${r.name}`) && r.event !== "workflow_dispatch") { /* 라벨 이벤트 런은 제목이 이슈 제목이다 */ }
  const jobs = gh(`repos/${repo}/actions/runs/${r.id}/jobs`, "--jq", ".jobs").flat();
  for (const j of jobs) {
    if (!j.started_at || j.conclusion === "skipped") continue;
    const failed = (j.steps || []).filter((s) => s.conclusion === "failure").map((s) => s.name);
    rows.push({ wf: r.name.replace("factory-", ""), created: r.created_at, started: j.started_at, done: j.completed_at, concl: j.conclusion, failed, title: r.display_title.slice(0, 40), id: r.id });
  }
}
rows.sort((a, b) => a.created.localeCompare(b.created));
const min = (a, b) => ((Date.parse(b) - Date.parse(a)) / 6e4);
let q = 0, x = 0;
console.log("workflow   created   queue(m) run(m)  conclusion  failed-steps  title");
for (const r of rows) { const qq = min(r.created, r.started), xx = r.done ? min(r.started, r.done) : NaN; q += qq; x += xx || 0;
  console.log(`${r.wf.padEnd(10)} ${r.created.slice(11, 19)}  ${qq.toFixed(1).padStart(7)} ${xx.toFixed(1).padStart(6)}  ${String(r.concl).padEnd(10)}  ${r.failed.join(",") || "-"}  ${r.title}`); }
if (rows.length) console.log(`\nfirst created ${rows[0].created} · last done ${rows.at(-1).done} · wall ${min(rows[0].created, rows.at(-1).done).toFixed(1)}m · queue ${q.toFixed(1)}m · run ${x.toFixed(1)}m`);
console.log("\nall runs since start (workflow: conclusion=count)"); for (const [k, v] of Object.entries(tally)) console.log(" ", k, JSON.stringify(v));
