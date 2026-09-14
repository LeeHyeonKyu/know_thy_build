#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { loadHarness } from "../lib/config.js";
import { recordRehearsal, refuseRef, rehearsalHash, rehearsalReport, renderRehearsalTable, runRehearsal } from "../lib/rehearsal.js";
import { assertNoWriteStageClean, snapshotSetupDirty } from "./run-stage.js";

/**
 * ── KTB-44 / ADR-025 — **러너 위의 리허설 한 번.** ──────────────────────────────────────────────
 * `factory-rehearse.yml`이 부르는 유일한 스크립트다. 이슈도 라벨도 `claude -p`도 없다: 스테이지가
 * 러너에서 하는 일만 그대로 한 번 하고, 그 판정을 표 하나(`$GITHUB_STEP_SUMMARY`)와 파일 하나
 * (`.factory/out/rehearsal.json`)로 남긴다. GREEN이면 "이 하네스는 러너에서 돈다"를 저장소에 적는다 —
 * 저장소 변수 `FACTORY_REHEARSED`(admin이 필요하면 `factory/rehearsal` commit status).
 */
const root = (await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim() || process.cwd();
const runId = process.env.FACTORY_RUN_ID || process.env.GITHUB_RUN_ID || "local";
const readText = (p, fallback = "") => { try { return readFileSync(join(root, p), "utf8"); } catch { return fallback; } };

const harness = loadHarness(root);
const defaultBranch = harness.project?.default_branch || "main";

/**
 * ADR-025 / 리뷰 must_fix 4 — **기본 브랜치가 아니면 아무것도 하지 않는다.** 워크플로의 `if:`가 1차
 * 방어지만 그 파일은 이 스크립트와 함께 움직이지 않는다(에이전트는 `.github/**`를 못 만지지만
 * `.factory/**`는 브랜치 push로 바꿀 수 있고, `gh workflow run --ref <branch>`는 레포 write면 부를 수
 * 있다). 그 조합에서 이 스크립트가 브랜치의 트리로 돌면 **main의 지문에 GREEN을 적을 수 있다** —
 * 게이트 명령이 한 줄도 돌지 않은 채로. 그래서 기록하는 쪽이 스스로 한 번 더 묻는다.
 */
const refName = process.env.GITHUB_REF_NAME || null;
if (refuseRef({ refName, defaultBranch })) {
  console.error(`rehearse: refusing to run on \`${refName}\` — the rehearsal is only meaningful (and only recorded) on the default branch \`${defaultBranch}\` (ADR-025). Dispatch it without --ref, or from ${defaultBranch}.`);
  process.exit(1);
}

const files = (await run("git", ["ls-files"], { cwd: root })).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
const hash = rehearsalHash({ harnessText: readText(".factory/harness.toml"), charterText: readText("docs/factory/CHARTER.md") });

// KTB-39 — 기준선은 **게이트가 돌기 전**에 찍는다. 이 시점의 diff는 전부 `[runtime].setup`이 만든
// 것이고(`.factory/actions/setup`이 이 스크립트보다 먼저 돈다), 클린 체크는 그 위에 무엇이 더
// 쓰였는가만 묻는다 — 스테이지의 판정과 정확히 같은 기준이다.
const baseline = await snapshotSetupDirty({ run, cwd: root });

/** qa 증거 디렉터리가 러너에서 **실제로** 쓰이는가(KTB-36/KTB-40의 카브아웃). 흔적은 남기지 않는다. */
async function qaProbe() {
  const dir = join(root, ".factory/out/qa");
  const probe = join(dir, `.rehearsal-${runId}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "factory rehearsal write probe\n");
    readFileSync(probe, "utf8");
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: `${e?.message || e}` };
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* best-effort */ }
  }
}

const { steps, ok: stepsOk } = await runRehearsal({
  run, cwd: root, harness, files, runId, baseline,
  readFile: (p) => readText(p),
  qaProbe,
  cleanCheck: (b) => assertNoWriteStageClean({ run, cwd: root, baseline: b }),
});

/**
 * 기록은 **스텝이 전부 GREEN일 때만** 일어나고, 그 성패는 **판정의 일부다**(리뷰 must_fix 5):
 * 보고서를 먼저 쓰고 기록을 나중에 하면, 기록이 실패한 런의 아티팩트가 `ok: true`로 남아
 * `factory rehearse`가 "the queue is open"을 찍고 0으로 끝난다 — 그러고 나면 첫 이슈가 거부된다.
 * 폴백 status는 **지문 경로마다 최신 커밋**에 붙는다(r1 must_fix 2 / r2 잔여): 러너도 읽는 쪽과 **같은**
 * 원격 조회를 쓴다 — 러너만 로컬 이력으로 고르던 시절에는 쓰는 커밋과 읽는 커밋이 같은-초 동률에서
 * 엇갈릴 수 있었고, 그러면 리허설을 몇 번 다시 돌려도 큐가 열리지 않았다.
 */
let recorded = null;
if (stepsOk) {
  try {
    const repo = process.env.FACTORY_REPO || (await resolveRepo({ run }));
    const gh = makeGh({ run, repo });
    const url = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : undefined;
    recorded = await recordRehearsal({ gh, hash, branch: defaultBranch, targetUrl: url });
  } catch (e) {
    recorded = { via: null, variable: `error: ${e?.message || e}`, status: "not attempted", sha: null };
  }
}

const report = rehearsalReport({ steps, hash, runId, recorded });
const outDir = join(root, ".factory/out");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "rehearsal.json"), JSON.stringify(report, null, 2));

const table = renderRehearsalTable(steps);
console.log(table);
const recordLine = recorded
  ? (recorded.via
    ? `recorded ${hash.slice(0, 12)} via ${recorded.via}${recorded.sha ? ` on ${recorded.sha.slice(0, 7)}` : ""}`
    : `NOT RECORDED — variable: ${recorded.variable}; status: ${recorded.status}. \`→ factory:queue\` stays refused`)
  : "not recorded (a RED rehearsal is never recorded)";
console.log(`rehearse: ${recordLine}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## factory rehearsal — ${report.ok ? "GREEN" : "RED"}\n\n${table}\n\nharness fingerprint \`${hash.slice(0, 12)}\` — ${recordLine}\n`);
  } catch (e) { console.error(`rehearse: could not write the job summary — ${e.message}`); }
}
if (recorded && !recorded.via) console.error(`rehearse: every step was GREEN but the result could not be recorded — ${recorded.variable}; ${recorded.status}`);

process.exit(report.ok ? 0 : 1);
