#!/usr/bin/env node
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { integrityCheck } from "../lib/integrity.js";
const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2); const bi = args.indexOf("--base");
  const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
  const harness = loadHarness(root);
  const branch = harness.project?.default_branch ?? "main";
  let base = bi >= 0 ? args[bi + 1] : null;
  if (base == null) {
    // merge-base를 못 구하면 검사 자체가 성립하지 않는다 — 빈 base로 "위반 없음"을 만들지 않는다(shallow clone 등).
    const mb = await run("git", ["merge-base", `origin/${branch}`, "HEAD"], { cwd: root });
    base = mb.stdout.trim();
    if (mb.code !== 0 || !base) { console.error(`integrity: cannot compute merge-base against origin/${branch} (shallow clone?) — exit ${mb.code} ${mb.stderr.trim()}`); process.exit(2); }
  }
  const r = await integrityCheck({ run, cwd: root, base, harness, readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) });
  console.log(JSON.stringify(r, null, 2));
  // 보호 경로 변경은 **알림**이지 실패가 아니다(KTB-5) — 이 체크는 branch protection의 유일한
  // required context라, 여기서 exit 1을 하면 사람조차 그 PR을 머지할 수 없다. "사람이 머지해야
  // 한다"는 집행은 L1(merge 스테이지)이 자동 머지를 거부하는 것으로 한다. 여기서는 잡 로그에만
  // 남긴다 — 상태를 고쳐 쓰지도, PR에 코멘트를 달지도 않는다(권한을 늘리지 않는다).
  if (r.protected?.length) console.log(`integrity: protected paths changed (human merge required): ${r.protected.join(", ")}`);
  process.exit(r.ok ? 0 : 1);
}
