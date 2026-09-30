import { test, expect } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 1.4.35 (L44, own-calendar #105) — 갓 받은 클론에서 사람이 전이 CLI를 부르면 `.factory/`의 런타임 의존성이
 * 없다(러너에서는 setup 액션이 설치한다). 예전에는 `Cannot find package 'smol-toml'` 스택만 나왔다.
 *
 * 픽스처는 실제 `bin/`·`lib/`를 **node_modules가 없는 자리**로 복사한 것이다 — 설치된 저장소의 `.factory/`와
 * 같은 모양이고, 임시 디렉터리의 조상 어디에도 `node_modules`가 없어 해석이 실제로 실패한다.
 */
const pkg = join(import.meta.dirname, "..");

function bareInstall() {
  const dir = mkdtempSync(join(tmpdir(), "ktb-bare-"));
  mkdirSync(join(dir, ".factory"), { recursive: true });
  cpSync(join(pkg, "bin"), join(dir, ".factory/bin"), { recursive: true });
  cpSync(join(pkg, "lib"), join(dir, ".factory/lib"), { recursive: true });
  return dir;
}

test("without its runtime dependencies the transition CLI says which command installs them", () => {
  const dir = bareInstall();
  try {
    // env를 명시 주입한다: 에이전트 세션·CI 표식이 서 있으면 이 CLI는 다른 이유로 먼저 거절한다.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const r = spawnSync(process.execPath, [".factory/bin/transition.js", "105", "factory:queue"], { cwd: dir, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm install --prefix .factory");
    expect(r.stderr).toContain("smol-toml");
    expect(r.stderr).not.toMatch(/\n\s+at .*node:internal/);          // 스택이 아니라 안내다
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
