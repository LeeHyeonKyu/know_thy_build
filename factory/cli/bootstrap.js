import { run } from "../lib/exec.js";
import { makeGh } from "../lib/gh.js";
import { loadHarness } from "../lib/config.js";
import { bootstrapPlan, applyBootstrap } from "../lib/bootstrap.js";

/**
 * `factory bootstrap` — 라벨·branch protection·FACTORY_TOKEN_ISSUED_AT을 저장소에 맞춘다(repo admin 권한 필요).
 * --dry-run은 ops를 출력만 하고 gh를 전혀 부르지 않는다(mutating은 물론 조회용 listLabels/getVariable/listSecrets은 여전히 호출 —
 * 계획을 세우려면 existing 상태가 필요하다).
 * --token-issued-at YYYY-MM-DD는 변수가 이미 있어도 그 값으로 강제 갱신한다(사람이 토큰을 재발급했을 때 쓰는 탈출구).
 */
export async function bootstrapCommand({ root, argv = [], io, gh, today }) {
  const dryRun = argv.includes("--dry-run");
  const tokenIdx = argv.indexOf("--token-issued-at");
  const forcedTokenDate = tokenIdx !== -1 ? argv[tokenIdx + 1] : null;
  const day = today || new Date().toISOString().slice(0, 10);

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
  const existing = { labels, variables: { FACTORY_TOKEN_ISSUED_AT: variableValue }, secrets };

  let ops = bootstrapPlan({ harness, today: day, existing });

  if (forcedTokenDate) {
    ops = ops.filter((op) => !(op.kind === "variable" && op.name === "FACTORY_TOKEN_ISSUED_AT") && !(op.kind === "note" && /FACTORY_TOKEN_ISSUED_AT/.test(op.message)));
    ops.push({ kind: "variable", name: "FACTORY_TOKEN_ISSUED_AT", value: forcedTokenDate });
  }

  if (dryRun) {
    io.out(JSON.stringify(ops, null, 2));
    return 0;
  }

  const { applied, notes } = await applyBootstrap({ gh: ghClient, ops, log: (msg) => io.out(msg) });
  io.out(`bootstrap: applied ${applied.length} ops`);
  for (const n of notes) io.out(`note: ${n}`);
  return 0;
}
