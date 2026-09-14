import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { run as realRun } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadHarness } from "../lib/config.js";
import { bootstrapPlan, applyBootstrap, formatBootstrapFailure, isTwoActor, CODEOWNERS_PATH, MERGE_TOKEN_SECRET } from "../lib/bootstrap.js";

const TOKEN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** strict YYYY-MM-DD: regex-shaped AND a real calendar date (rejects e.g. 2026-02-30). */
function isValidYMD(s) {
  const m = typeof s === "string" ? TOKEN_DATE_RE.exec(s) : null;
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d);
}

/**
 * `factory bootstrap` — 라벨·branch protection·FACTORY_TOKEN_ISSUED_AT을 저장소에 맞춘다(repo admin 권한 필요).
 * --dry-run은 ops를 출력만 하고 mutating gh 메서드를 전혀 부르지 않는다(조회용 listLabels/getVariable/listSecrets은
 * 여전히 호출 — 계획을 세우려면 existing 상태가 필요하다).
 * --token-issued-at YYYY-MM-DD는 변수가 이미 있어도 그 값으로 강제 갱신한다(사람이 토큰을 재발급했을 때 쓰는 탈출구).
 * `run`은 주입 가능 — `gh`가 없을 때 repo 자동탐지(`gh repo view`)와 makeGh 내부 실행에 쓴다(테스트가 실 프로세스를
 * 띄우지 않도록).
 */
/**
 * ADR-021 r1 MF-1 — **머지 배우의 로그인은 누구의 것인가.** CODEOWNERS에 적을 이름은 하나뿐이고,
 * 그 이름이 틀리면(예: 에이전트 봇 계정) 이 ADR 전체가 무효가 되거나(에이전트가 스스로 승인한다)
 * 저장소가 잠긴다(존재하지 않는 소유자). 그래서 **어디에서 얻었는지를 반드시 함께 돌려준다**.
 *
 * 1순위는 로컬 env의 `FACTORY_MERGE_TOKEN`이다 — 그 토큰으로 `gh api user`를 부르면 답은 정의상
 * 머지 배우다. 없으면 지금 로그인한 gh 세션의 계정을 쓴다: 부트스트랩은 repo admin이 필요하므로
 * **사람이 자기 손으로** 돌리고, 그 사람이 머지 배우인 것이 보통이다 — 하지만 그것은 가정이지
 * 관측이 아니라서, note가 "current gh session"이라고 소리 내어 말한다.
 * 둘 다 실패하면 `null`을 돌려준다 — 계획 단계가 자리표시자를 쓰는 대신 아무 것도 쓰지 않는다.
 */
async function resolveMergeActor({ run, env }) {
  const attempts = env?.[MERGE_TOKEN_SECRET]
    ? [{ source: `gh api user under ${MERGE_TOKEN_SECRET}`, opts: { env: { GH_TOKEN: env[MERGE_TOKEN_SECRET], GITHUB_TOKEN: env[MERGE_TOKEN_SECRET] } } }]
    : [];
  attempts.push({ source: "gh api user (current gh session — VERIFY this is the merge actor, not you-as-admin-only)", opts: {} });
  for (const a of attempts) {
    const r = await run("gh", ["api", "user"], a.opts);
    if (r.code !== 0) continue;
    try {
      const login = JSON.parse(r.stdout).login;
      if (login) return { mergeActorLogin: login, loginSource: a.source };
    } catch {}
  }
  return { mergeActorLogin: null, loginSource: null };
}

export async function bootstrapCommand({ root, argv = [], io, gh, run = realRun, today, env = process.env }) {
  const dryRun = argv.includes("--dry-run");
  const tokenIdx = argv.indexOf("--token-issued-at");
  const tokenGiven = tokenIdx !== -1;
  const forcedTokenDate = tokenGiven ? argv[tokenIdx + 1] : null;
  const day = today || new Date().toISOString().slice(0, 10);

  if (tokenGiven && !isValidYMD(forcedTokenDate)) {
    io.err("--token-issued-at expects YYYY-MM-DD");
    return 1;
  }

  let harness;
  try {
    harness = loadHarness(root);
  } catch (e) {
    io.err(`bootstrap: harness.toml unreadable: ${e.message}`);
    return 1;
  }

  const ghClient = gh || makeGh({ run, repo: process.env.FACTORY_REPO || JSON.parse((await run("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout).nameWithOwner });

  const [labels, variableValue, secrets] = await Promise.all([
    ghClient.listLabels(),
    ghClient.getVariable("FACTORY_TOKEN_ISSUED_AT"),
    ghClient.listSecrets(),
  ]);
  const codeownersAbs = join(root, CODEOWNERS_PATH);
  const existing = {
    labels,
    variables: { FACTORY_TOKEN_ISSUED_AT: variableValue },
    secrets,
    codeowners: existsSync(codeownersAbs) ? readFileSync(codeownersAbs, "utf8") : null,
    ...(isTwoActor(secrets) ? await resolveMergeActor({ run, env }) : {}),
  };

  let ops = bootstrapPlan({ harness, today: day, existing });

  if (forcedTokenDate) {
    ops = ops.filter((op) => !(op.kind === "variable" && op.name === "FACTORY_TOKEN_ISSUED_AT") && !(op.kind === "note" && /FACTORY_TOKEN_ISSUED_AT/.test(op.message)));
    ops.push({ kind: "variable", name: "FACTORY_TOKEN_ISSUED_AT", value: forcedTokenDate });
  }

  if (dryRun) {
    io.out(JSON.stringify(ops, null, 2));
    // existing.labels는 계획엔 쓰이지 않는(항상 전량 재적용) 보고용 정보다 — dry-run에서라도 사람이 보게 노출한다.
    const alreadyPresent = ops.filter((op) => op.kind === "label" && existing.labels.includes(op.name)).length;
    io.out(`labels already present: ${alreadyPresent}`);
    return 0;
  }

  // codeowners op만 디스크에 쓴다 — 경로는 op이 들고 있는 저장소 상대 경로다(root 기준으로 편다).
  const writeFile = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const { applied, failed, notes } = await applyBootstrap({ gh: ghClient, ops, log: (msg) => io.out(msg), writeFile });
  io.out(`bootstrap: applied ${applied.length} ops`);
  for (const n of notes) io.out(`note: ${n}`);
  // 실패마다 딱 한 줄만 찍는다(applyBootstrap의 log()는 실패 시 아무것도 찍지 않는다 — dedupe 지점은 여기 하나뿐).
  for (const f of failed) io.err(formatBootstrapFailure(f));
  return failed.length > 0 ? 1 : 0;
}
