import { LABELS } from "./label-catalog.js";

const PROTECTION_BODY = (contexts) => ({
  required_status_checks: { strict: true, contexts },
  enforce_admins: true,
  required_pull_request_reviews: null,
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
 * protection: harness의 default_branch/required_checks로 정확한 body를 만든다(§요구사항, 그대로 고정).
 * variable: FACTORY_TOKEN_ISSUED_AT이 없을 때만 오늘 날짜로 세팅 — 있으면 값을 덮어쓰지 않고 note만 남긴다.
 * secrets: bootstrap은 값을 쓸 수 없으므로(비밀이라) 부재를 note로만 알린다.
 */
export function bootstrapPlan({ harness, today, existing }) {
  const ops = LABELS.map((l) => ({ kind: "label", name: l.name, color: l.color, description: l.description }));

  ops.push({ kind: "protection", branch: harness.project.default_branch, body: PROTECTION_BODY(harness.factory.required_checks) });

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

  return ops;
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
      log(`failed: ${op.kind} ${op.name || op.branch || ""} — ${e.message}`);
      failed.push({ op, error: e.message });
    }
  }
  return { applied, failed, notes };
}
