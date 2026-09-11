import { matchesAny } from "./glob.js";
export async function changedFiles({ run, cwd, base, head = "HEAD", harness }) {
  const r = await run("git", ["diff", "--name-status", `${base}...${head}`], { cwd });
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  const rows = r.stdout.split("\n").filter(Boolean).map((l) => { const [status, ...rest] = l.split("\t"); return { status: status[0], file: rest[rest.length - 1] }; });
  const all = rows.map((x) => x.file), added = rows.filter((x) => x.status === "A").map((x) => x.file);
  // 지워진 파일은 "이번 변경에 존재하는 파일"이 아니다 — 돌릴 수도, 커버리지를 잴 수도 없다.
  // 이름이 바뀐 파일(R)은 새 경로로 친다(rest의 마지막 항목이 새 경로다).
  const present = rows.filter((x) => ["A", "M", "R"].includes(x.status)).map((x) => x.file);
  const tests = present.filter((f) => matchesAny(harness.test.test_glob, f));
  const sources = present.filter((f) => matchesAny(harness.test.source_glob, f));
  return { all, added, tests, sources, addedTests: added.filter((f) => tests.includes(f)) };
}
export async function changedLines({ run, cwd, base, head = "HEAD" }) {
  const r = await run("git", ["diff", "-U0", `${base}...${head}`], { cwd });
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  const m = new Map(); let file = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.startsWith("+++ b/") ? line.slice(6) : null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) { const start = Number(h[1]), count = h[2] === undefined ? 1 : Number(h[2]); if (!m.has(file)) m.set(file, new Set()); for (let i = 0; i < count; i++) m.get(file).add(start + i); }
  }
  return m;
}
