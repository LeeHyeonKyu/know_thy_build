#!/usr/bin/env node
/**
 * ── 버전 범프는 러너 생성물이다 (2026-10-02, 소유자 결정 — ADR-032) ─────────────────────────────
 *
 * 1.4.36–1.4.44의 아홉 릴리스는 전부 "엔진 결함 수정 → 버전 올리는 PR → 사람 머지"였다. 사람의 판단이 든 자리는 없었고, 버전 숫자는
 * 미러 커밋(S3)과 똑같이 **소스에서 결정되는 생성물**이다. 그래서 publish 워크플로가 main에 엔진 내용이 들어올 때마다 다음 patch
 * 버전을 계산해 배포한다 — 이 스크립트가 그 두 동작이다. 사람은 minor/major를 올릴 때만 package.json을 직접 고친다.
 *
 *   node factory/cli/bump-version.js --next            # 다음 patch 버전을 stdout에 — max(npm 최신, package.json) + 0.0.1
 *   node factory/cli/bump-version.js <x.y.z>           # package.json·package-lock.json의 version을 쓰고 `.factory/install-manifest.json`을 재생성
 *
 * 왜 max인가: 범프 커밋을 main에 되밀지 못한 경우(브랜치 보호) 저장소의 package.json은 바닥(floor)으로 남고 npm만 앞서 간다 —
 * 그래도 다음 번호는 충돌하지 않아야 한다. 왜 매니페스트까지인가: `ktb_version`이 거기 들어 있고 self-mirror 테스트가 둘을 대조한다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const arg = String(process.argv[2] || "").trim();
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const die = (m) => { process.stderr.write(`bump-version: ${m}\n`); process.exit(2); };

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) die("no package.json here — run from the repository root");
const pkg = readJson(pkgPath);

const cmp = (a, b) => { const A = a.match(SEMVER).slice(1).map(Number), B = b.match(SEMVER).slice(1).map(Number); for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; };

if (arg === "--next") {
  const local = String(pkg.version || "0.0.0");
  if (!SEMVER.test(local)) die(`package.json version is not x.y.z: ${local}`);
  const npm = spawnSync("npm", ["view", pkg.name, "version"], { encoding: "utf8" });
  const remote = npm.status === 0 ? npm.stdout.trim() : "0.0.0";
  if (!SEMVER.test(remote)) die(`npm view ${pkg.name} version returned ${JSON.stringify(remote)}`);
  const base = cmp(local, remote) >= 0 ? local : remote;
  const [, x, y, z] = base.match(SEMVER);
  process.stdout.write(`${x}.${y}.${Number(z) + 1}\n`);
  process.exit(0);
}

if (!SEMVER.test(arg)) die(`usage: bump-version.js --next | <x.y.z> (got ${JSON.stringify(arg)})`);
if (cmp(arg, String(pkg.version || "0.0.0")) <= 0) die(`${arg} is not above package.json's ${pkg.version} — the bump only goes forward`);

// package.json — 키 순서·들여쓰기를 보존하려고 문자열 치환으로 쓴다(JSON 재직렬화는 diff를 더럽힌다).
const pkgText = readFileSync(pkgPath, "utf8");
const pkgNext = pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${arg}$2`);
if (pkgNext === pkgText) die("package.json has no \"version\" field to rewrite");
writeFileSync(pkgPath, pkgNext);

// package-lock.json — 루트 `version`과 `packages[""].version` 둘 다(npm이 그렇게 쓴다).
const lockPath = join(root, "package-lock.json");
if (existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = arg;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = arg;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

// 설치 매니페스트 — 미러 가족의 생성기(S3)로. 다른 가족 파일은 소스가 그대로라 바뀌지 않는다.
const mirror = join(root, "factory/lib/mirror.js");
if (existsSync(mirror)) {
  const { regenerateMirror } = await import(pathToFileURL(mirror).href);
  const r = await regenerateMirror({ root });
  if (!r.ok) die(`install manifest could not be regenerated: ${r.reason}`);
  process.stdout.write(`bump-version: ${pkg.version} → ${arg}; regenerated ${r.changed.join(", ") || "nothing"}\n`);
} else {
  process.stdout.write(`bump-version: ${pkg.version} → ${arg}\n`);
}
