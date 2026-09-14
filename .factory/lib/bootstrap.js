import { LABELS } from "./label-catalog.js";
import { GH_FREE_PLAN_PROTECTION_RE } from "./gh.js";

/**
 * L0(branch protection)가 요구하는 체크는 `factory/integrity` 하나다(ADR-015 보강).
 * `factory/gates`·`factory/review`는 **이슈 파이프라인을 탄 PR에만** 게시자가 있다(run-stage가
 * PR head sha에 commit status로 올린다) — 사람이 직접 여는 retro-proposal·harness PR이나
 * 부트스트랩 직후의 첫 push에는 그 상태를 만들 주체가 아예 없어서, L0에 넣는 순간 그 PR들은
 * 영영 머지 불가가 된다(교착). 두 체크는 L1이 계속 강제한다 — merge 스테이지의
 * `allChecksGreen(prChecks, harness.factory.required_checks)`가 세 개 전부를 요구한다.
 * strict:false — 게이트 판정은 이미 sha에 묶여 있고(requirements.js gatesGate), strict(=up-to-date)는
 * 머지 직전 base 리베이스를 요구하는데 팩토리는 리베이스를 하지 않는다(하면 게이트가 검증한 sha가 바뀐다).
 */
export const L0_CONTEXTS = ["factory/integrity"];

/**
 * ADR-021 — **두 배우 모드의 표식은 `FACTORY_MERGE_TOKEN` 시크릿 하나다.** 이 시크릿이 있으면
 * 저장소는 "에이전트 배우(`FACTORY_BOT_TOKEN`, 비-admin write)"와 "머지 배우(admin PAT)"를
 * 나눠 쓰고 있다는 뜻이고, 그때만 base 브랜치에 **리뷰 승인 1건**을 요구할 수 있다. 단일 배우
 * 모드에서 같은 규칙을 걸면 다크 머지가 구조적으로 불가능해진다 — PR 작성자(에이전트 배우)는
 * 자기 PR을 승인할 수 없고, 승인해 줄 다른 계정이 없다.
 */
export const MERGE_TOKEN_SECRET = "FACTORY_MERGE_TOKEN";
export const isTwoActor = (secrets = []) => secrets.includes(MERGE_TOKEN_SECRET);

/**
 * ADR-021 — 두 배우 모드에서만 `required_pull_request_reviews`가 붙는다.
 *
 * 이것이 이 설계의 **유일하게 되돌릴 수 없는 문**이다: 승인 1건이 필수가 되는 순간, PR을 연
 * 계정(에이전트 배우)은 GitHub 규칙상 **자기 PR을 승인할 수 없으므로** 그 계정이 쥔 토큰으로는
 * `gh pr merge`가 어떤 모양으로 불려도 통과하지 못한다 — 명령 패턴을 열거해 막는 것이 아니라
 * **권한으로** 막는다(훅은 그 위의 defense in depth로 남는다). `dismiss_stale_reviews: true`인
 * 이유: 승인 뒤에 새 커밋이 밀려 들어오면 그 승인은 다른 diff에 대한 것이다.
 *
 * `enforce_admins: true`는 두 모드 모두 유지한다 — 머지 배우도 required check를 우회하지 못한다
 * (승인 요건만 충족하면 머지할 수 있고, 그것이 두 배우 모드가 여는 유일한 문이다).
 * `restrictions`는 두 모드 모두 null이다: push 제한은 GitHub Free의 개인 저장소에서 지원되지 않고
 * (조직 전용), 그것 없이도 위의 승인 요건이 같은 결과를 낸다.
 */
const PROTECTION_BODY = (contexts, { twoActor = false } = {}) => ({
  required_status_checks: { strict: false, contexts },
  enforce_admins: true,
  required_pull_request_reviews: twoActor ? { required_approving_review_count: 1, dismiss_stale_reviews: true } : null,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
});

const secretNote = (label) => `gh secret set ${label} — bootstrap never writes secret values`;

/**
 * 부트스트랩 계획을 순수 함수로 만든다 — gh 호출은 전혀 하지 않는다.
 * 라벨: 카탈로그 전부를 항상 op으로 낸다(--force가 있어도 갱신 대상이라 existing.labels는 보고용일 뿐, 필터링에 쓰지 않는다).
 * protection: harness의 default_branch + 고정된 L0 contexts(`factory/integrity` 하나)로 body를 만든다.
 *   `harness.factory.required_checks`는 여기서 쓰지 않는다 — 그건 L1(머지 스테이지) 몫이다(ADR-015 보강).
 * variable: FACTORY_TOKEN_ISSUED_AT이 없을 때만 오늘 날짜로 세팅 — 있으면 값을 덮어쓰지 않고 note만 남긴다.
 * secrets: bootstrap은 값을 쓸 수 없으므로(비밀이라) 부재를 note로만 알린다.
 */
export function bootstrapPlan({ harness, today, existing }) {
  const ops = LABELS.map((l) => ({ kind: "label", name: l.name, color: l.color, description: l.description }));

  // ADR-021 — 모드는 **관측된 시크릿 목록**에서 나온다(사람이 플래그로 고르지 않는다). 플래그였다면
  // "두 배우 모드라고 선언했지만 머지 토큰이 없어 머지가 영영 막힌 저장소"가 가능해진다.
  const twoActor = isTwoActor(existing?.secrets);
  ops.push({ kind: "protection", branch: harness.project.default_branch, twoActor, body: PROTECTION_BODY(L0_CONTEXTS, { twoActor }) });

  const issuedAt = existing?.variables?.FACTORY_TOKEN_ISSUED_AT;
  if (issuedAt) {
    ops.push({ kind: "note", message: `FACTORY_TOKEN_ISSUED_AT already set to ${issuedAt} — leaving it (use --token-issued-at to force)` });
  } else {
    ops.push({ kind: "variable", name: "FACTORY_TOKEN_ISSUED_AT", value: today });
  }

  const secrets = existing?.secrets || [];
  if (!secrets.includes("FACTORY_BOT_TOKEN")) ops.push({ kind: "note", message: secretNote("FACTORY_BOT_TOKEN") });
  if (!secrets.includes("CLAUDE_CODE_OAUTH_TOKEN") && !secrets.includes("ANTHROPIC_API_KEY")) {
    ops.push({ kind: "note", message: secretNote("CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)") });
  }
  // ADR-021 — 어느 모드로 부트스트랩했는지는 **출력에서 읽을 수 있어야 한다**. 두 모드의 차이는
  // protection body 한 줄뿐이라 조용히 지나가면 사람이 "머지 권한이 여전히 에이전트 손에 있다"는
  // 사실을 모른 채로 운영하게 된다(그것이 단일 배우 모드의 실질적 위험이다).
  ops.push({ kind: "note", message: twoActor
    ? `two-actor mode: ${MERGE_TOKEN_SECRET} is set — the base branch requires 1 approving review, so the agent actor (which authors the PR) cannot merge it with any command; the merge stage approves with the merge actor and then merges (ADR-021)`
    : `single-actor mode: no ${MERGE_TOKEN_SECRET} — merge power is reachable from agent stages and hooks are the only layer. Set ${MERGE_TOKEN_SECRET} (admin PAT) + a non-admin FACTORY_BOT_TOKEN and re-run bootstrap for two-actor mode (ADR-021)` });

  return ops;
}

/**
 * 실패한 op 하나를 사람이 읽을 한 줄로 만든다 — 호출자(bootstrapCommand)가 `failed[]`를 순회하며 이 함수로
 * 딱 한 번만 찍는다. protection 실패가 GitHub Free 플랜 403이면(private repo에서는 branch protection API 자체가
 * 막힌다) "권한 문제"가 아니라 "이 플랜에서 못 함"이라는 걸 명시하고, L0가 꺼져도 L1(머지 스크립트의
 * allChecksGreen)·L2(경로 deny)는 그대로 강제된다는 걸 덧붙인다 — 사람이 "그래서 지금 아무 것도 안 지켜지냐"고
 * 오해하지 않게. 그 외 실패는 지금까지의 문구를 그대로 쓴다.
 */
export function formatBootstrapFailure({ op, error }) {
  if (op.kind === "protection" && GH_FREE_PLAN_PROTECTION_RE.test(error)) {
    return `protection ${op.branch}: not available on this plan (private repo on GitHub Free) — make the repo public or upgrade; L0 required-check enforcement is off, L1 (merge script requires all checks GREEN) and L2 still apply`;
  }
  return `failed: ${op.kind} ${op.name || op.branch || ""} — ${error}`;
}

/**
 * ops를 실제로 적용한다. label/protection/variable만 gh를 부른다 — note는 보고만 하고 절대 gh를 건드리지 않는다.
 * harness는 받지 않는다 — protection op이 계획 단계에서 이미 branch/body를 다 갖춘 self-contained 객체라 필요 없다.
 * op마다 격리한다: 라벨 하나가 실패해도(권한/네트워크 등) 나머지 라벨·protection·variable은 계속 시도한다 — 부트스트랩은
 * 되돌릴 수 없는 단일 트랜잭션이 아니라 "최대한 맞춰놓기"이므로 한 실패가 전체를 막으면 안 된다. 실패는 failed[]에
 * 모아 반환하고, 종료 코드를 결정하는 건 호출자(bootstrapCommand) 몫이다.
 */
export async function applyBootstrap({ gh, ops, log = () => {} }) {
  const applied = [];
  const failed = [];
  const notes = [];
  for (const op of ops) {
    try {
      switch (op.kind) {
        case "label":
          await gh.createLabel({ name: op.name, color: op.color, description: op.description });
          log(`label: ${op.name}`);
          applied.push(op);
          break;
        case "protection":
          await gh.putBranchProtection(op.branch, op.body);
          log(`protection: ${op.branch}`);
          applied.push(op);
          break;
        case "variable":
          await gh.setVariable(op.name, op.value);
          log(`variable: ${op.name}=${op.value}`);
          applied.push(op);
          break;
        case "note":
          log(`note: ${op.message}`);
          notes.push(op.message);
          break;
        default:
          throw new Error(`applyBootstrap: unknown op kind "${op.kind}"`);
      }
    } catch (e) {
      // Do not also `log()` here — the caller (bootstrapCommand) prints each failure exactly once from the
      // returned `failed[]`, formatted per op kind (e.g. the GitHub-Free branch-protection 403 gets a dedicated
      // actionable line). Logging it here too used to double-print the same failure (once via log→io.out,
      // once via the caller's io.err loop).
      failed.push({ op, error: e.message });
    }
  }
  return { applied, failed, notes };
}
