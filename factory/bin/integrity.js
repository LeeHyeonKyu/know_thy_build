#!/usr/bin/env node
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "../lib/exec.js";
import { loadHarness } from "../lib/config.js";
import { integrityCheck, TESTS_MODIFIED_POLICY_RULE } from "../lib/integrity.js";
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
  // additive-only도 마찬가지다(KTB-6): "역할 프롬프트를 누가 고쳐도 되는가"는 정책이지 이 커밋에
  // 대한 사실이 아니다. 여기서 RED로 만들면 `:role` PR도, 에이전트 파일을 건드리는 패키지
  // 업그레이드도 사람이 머지할 수 없다 — 집행은 L1이 자동 머지를 거부하는 것으로 한다.
  // H5도 같은 자리다: 기존 테스트의 수정·삭제는 "이 커밋에 대한 사실"이 아니라 "누가 머지해도
  // 되는가"의 정책이다 — 여기서 RED로 만들면 스펙이 바뀐 정상적인 PR을 사람도 머지할 수 없다.
  // (허용 표식은 이슈 본문에 있고, 이 잡은 이슈를 모른다 — 판정은 이슈를 아는 L1이 다시 한다.)
  const tests = (r.policy || []).filter((v) => TESTS_MODIFIED_POLICY_RULE.test(v.rule));
  if (tests.length) console.log(`integrity: existing tests modified or deleted (human merge required unless the issue lists them under tests_changed_allowed:): ${[...new Set(tests.map((v) => v.file))].join(", ")}`);
  const sections = (r.policy || []).filter((v) => !TESTS_MODIFIED_POLICY_RULE.test(v.rule));
  if (sections.length) console.log(`integrity: agent role sections edited outside the allowed sections (human merge required): ${[...new Set(sections.map((v) => v.file))].join(", ")}`);
  process.exit(r.ok ? 0 : 1);
}
