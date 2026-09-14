#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { makeGh, resolveRepo } from "../lib/gh.js";
import { loadHarness } from "../lib/config.js";
import { recordRehearsal, rehearsalHash, rehearsalReport, renderRehearsalTable, runRehearsal } from "../lib/rehearsal.js";
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

const { steps, ok } = await runRehearsal({
  run, cwd: root, harness, files, runId, baseline,
  readFile: (p) => readText(p),
  qaProbe,
  cleanCheck: (b) => assertNoWriteStageClean({ run, cwd: root, baseline: b }),
});

const report = rehearsalReport({ steps, hash, runId });
const outDir = join(root, ".factory/out");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "rehearsal.json"), JSON.stringify(report, null, 2));

const table = renderRehearsalTable(steps);
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## factory rehearsal — ${ok ? "GREEN" : "RED"}\n\n${table}\n\nharness fingerprint \`${hash.slice(0, 12)}\`\n`);
  } catch (e) { console.error(`rehearse: could not write the job summary — ${e.message}`); }
}

// 기록은 **GREEN일 때만** 일어난다 — 이 변수 하나가 `→ factory:queue`를 여는 열쇠다(transition.js).
if (ok) {
  try {
    const repo = process.env.FACTORY_REPO || (await resolveRepo({ run }));
    const gh = makeGh({ run, repo });
    const branch = harness.project?.default_branch || "main";
    const url = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : undefined;
    const r = await recordRehearsal({ gh, hash, branch, targetUrl: url });
    if (r.via) console.log(`rehearse: recorded ${hash.slice(0, 12)} via ${r.via}${r.error ? ` (repo variable refused: ${r.error})` : ""}`);
    else console.error(`rehearse: GREEN but the result could not be recorded — ${r.error}. \`→ factory:queue\` stays refused until it is`);
    if (!r.via) process.exit(1);
  } catch (e) {
    console.error(`rehearse: GREEN but the result could not be recorded — ${e.message}`);
    process.exit(1);
  }
}

process.exit(ok ? 0 : 1);
