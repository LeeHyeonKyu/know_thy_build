// regen-mirror-at.mjs <root> — 운영 세션의 미러 복구 도구(2026-10-12 #199: 러너의 미러 push가 GitHub 장애로 거부돼
// 브랜치의 설치본이 소스보다 낡았고, 이후 모든 스테이지가 "installed engine is not what its sources generate"로 blocked됐다).
// 주어진 체크아웃 — 보통 `git worktree add <scratch> origin/claude/fq-<n>` 뒤 그 안에서 `npm ci` — 의 factory/lib/mirror.js,
// 곧 **그 브랜치의 엔진**으로 설치본을 재생성하고 바뀐 경로를 찍는다(러너의 mirrorStep과 같은 함수).
// 그 뒤: `git -c user.name=factory-runner -c user.email=factory-runner@users.noreply.github.com commit -m "mirror: regenerate …"`
// → `git push origin HEAD:claude/fq-<n>` → `node .factory/bin/transition.js <n> factory:queue --reason …`.
// 운영 세션 훅은 보호 경로로의 ln/cp/sed를 막으므로 node_modules는 심링크가 아니라 `npm ci`로 둔다.
import { pathToFileURL } from "node:url";
const root = process.argv[2];
if (!root) { console.error("usage: regen-mirror-at.mjs <root>"); process.exit(2); }
const { regenerateMirror } = await import(pathToFileURL(`${root}/factory/lib/mirror.js`).href);
const r = await regenerateMirror({ root });
console.log(JSON.stringify({ ok: r.ok, applicable: r.applicable, changed: r.changed, reason: r.reason ?? null }, null, 0));
if (!r.ok) process.exit(1);
