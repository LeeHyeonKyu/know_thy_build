const SHA = /^[0-9a-f]{40}$/;

function req(errors, obj, key, type, path = "") {
  const v = obj?.[key];
  const p = path ? `${path}.${key}` : key;
  if (v === undefined || v === null) { errors.push(`${p} is required`); return undefined; }
  if (type === "array" ? !Array.isArray(v) : typeof v !== type) { errors.push(`${p} must be ${type}`); return undefined; }
  return v;
}
function oneOf(errors, obj, key, values, path = "") {
  const v = req(errors, obj, key, "string", path);
  if (v !== undefined && !values.includes(v)) errors.push(`${path ? path + "." : ""}${key} must be one of ${values.join("|")}`);
  return v;
}

/** proposals·lessons·examples·perspectives 공통: 근거 run 목록은 숫자 배열이고 최소 1개(§8.4 최소 근거 창은 L1이 세지만, 스키마는 "근거가 아예 없는 후보"는 막는다). */
function evidenceRuns(errors, o, path) {
  const er = req(errors, o, "evidence_runs", "array", path) || [];
  if (er.length === 0) errors.push(`${path}.evidence_runs must have ≥1 item`);
  er.forEach((n, i) => { if (typeof n !== "number") errors.push(`${path}.evidence_runs[${i}] must be a number`); });
}

function verdictChecks(errors, v, path) {
  const kind = oneOf(errors, v, "verdict", ["approve", "reject"], path);
  oneOf(errors, v, "confidence", ["high", "medium", "low"], path);
  const mf = req(errors, v, "must_fix", "array", path) || [];
  req(errors, v, "should_fix", "array", path);
  req(errors, v, "verified", "array", path);
  mf.forEach((m, i) => { for (const k of ["id", "where", "claim", "evidence"]) req(errors, m, k, "string", `${path}.must_fix[${i}]`); });
  if (kind === "reject" && mf.length === 0) errors.push(`${path}.must_fix must have ≥1 item when verdict is reject`);
}

const SCHEMAS = {
  "triage.v1"(o, e) {
    req(e, o, "issue", "number");
    const d = oneOf(e, o, "disposition", ["ready", "needs-info", "wont-do"]);
    if (d === "ready" || !["needs-info", "wont-do"].includes(d)) oneOf(e, o, "tier", ["docs", "standard", "load-bearing"]);
    if (d === "needs-info") req(e, o, "questions", "array");
    /*
     * 감사 M1 — `impact_paths`는 **선택** 필드다: triage가 예상하는 변경 경로. 스크립트가 CHARTER의
     * NEVER_AUTOMATE 글롭을 다시 대는 재료이고(`verify-stage.js` neverAutomateHits), 없으면 그
     * 재확인이 도는 대상이 없을 뿐 handoff가 무효는 아니다(옛 handoff와의 호환).
     */
    if (o?.impact_paths !== undefined && o.impact_paths !== null) {
      const ps = req(e, o, "impact_paths", "array") || [];
      ps.forEach((p, i) => { if (typeof p !== "string") e.push(`impact_paths[${i}] must be a string`); });
    }
  },
  "plan.v1"(o, e) {
    req(e, o, "issue", "number");
    oneOf(e, o, "tier", ["docs", "standard", "load-bearing"]);
    const roles = req(e, o, "roles", "array"); if (roles && roles.length < 2) e.push("roles must have ≥2 entries");
    req(e, o, "rounds", "number");
    const dw = req(e, o, "done_when", "array") || [];
    if (dw.length === 0) e.push("done_when must have ≥1 item");
    /*
     * `covers`는 **선택** 필드다(감사 Task 9): 이 done_when이 어느 dissent를 막는가(dissent id 배열).
     * 있어야 한다고 요구하는 것은 스키마가 아니라 verify-stage의 plan 검증기다 — 요구는 "dissent가
     * 있을 때"만 성립하고, 스키마는 dissent를 세지 않는다. 여기서는 모양만 본다.
     */
    dw.forEach((d, i) => {
      for (const k of ["id", "text", "verify"]) req(e, d, k, "string", `done_when[${i}]`);
      oneOf(e, d, "level", ["unit", "integration", "e2e"], `done_when[${i}]`);
      if (d?.covers !== undefined && d.covers !== null) {
        const c = req(e, d, "covers", "array", `done_when[${i}]`) || [];
        c.forEach((x, j) => { if (typeof x !== "string") e.push(`done_when[${i}].covers[${j}] must be a string`); });
      }
    });
    req(e, o, "files_expected", "array");
    const dl = req(e, o, "dissent_log", "array") || [];
    // `id`·`severity`도 선택이다 — 없는 항목은 검증기가 위치(d1, d2 …)와 "심각도 미상"으로 읽는다.
    dl.forEach((d, i) => {
      if (d?.id !== undefined && d.id !== null) req(e, d, "id", "string", `dissent_log[${i}]`);
      if (d?.severity !== undefined && d.severity !== null) oneOf(e, d, "severity", ["low", "medium", "high", "critical"], `dissent_log[${i}]`);
    });
    req(e, o, "non_goals", "array");
    req(e, o, "open_risks", "array");
  },
  "implement.v1"(o, e) {
    req(e, o, "issue", "number");
    const sha = req(e, o, "head_sha", "string"); if (sha && !SHA.test(sha)) e.push("head_sha must be a 40-hex sha");
    req(e, o, "pr", "number");
    const g = req(e, o, "gates", "object"); if (g) oneOf(e, g, "status", ["GREEN", "RED", "MISCONFIGURED"], "gates");
    const v = req(e, o, "verifier", "object"); if (v) oneOf(e, v, "verdict", ["accepted", "accepted-with-reservations", "rejected"], "verifier");
    oneOf(e, o, "orchestration", ["workflow", "agent"]);
    oneOf(e, o, "guarantee", ["structural", "verified"]);
    // ADR-020 KTB-23 — **선택** 필드. 있으면 배열이어야 하고 각 항목은 {file, change, why} 문자열
    // 셋을 다 갖춰야 한다. builder가 보호 경로 변경 없이는 done_when을 끝낼 수 없을 때 여기에
    // 적는다("Harness change needed"라는 산문 대신) — L1이 이것을 읽어 `factory:harness` 이슈를
    // 열고 이 이슈를 주차한다. 없는 것이 정상이므로 `req`가 아니다.
    if (o.harness_needed !== undefined && o.harness_needed !== null) {
      const hn = req(e, o, "harness_needed", "array");
      (hn || []).forEach((h, i) => { for (const k of ["file", "change", "why"]) req(e, h, k, "string", `harness_needed[${i}]`); });
    }
  },
  "review.v1"(o, e) {
    req(e, o, "issue", "number"); req(e, o, "pr", "number");
    const sha = req(e, o, "head_sha", "string"); if (sha && !SHA.test(sha)) e.push("head_sha must be a 40-hex sha");
    req(e, o, "round", "number");
    const vs = req(e, o, "verdicts", "array") || [];
    if (vs.length === 0) e.push("verdicts must have ≥1 item");
    vs.forEach((v, i) => { req(e, v, "role", "string", `verdicts[${i}]`); verdictChecks(e, v, `verdicts[${i}]`); });
    oneOf(e, o, "orchestration", ["workflow", "agent"]);
    oneOf(e, o, "guarantee", ["structural", "verified"]);
  },
  "verdict.v1"(o, e) { verdictChecks(e, o, "verdict"); },
  /**
   * retro 에이전트의 출력(§8.1/§8.3/§8.4) — 후보 + 근거 run 목록만. 채택 여부·N 조정·이슈/PR
   * 생성은 전부 L1(P4-R4)이라 이 스키마는 형식만 검사한다. 배열은 비어도 된다(내놓을 게 없으면 없는 게
   * 맞다) — `harness`만 evidence_runs가 없다(성숙도 격차는 근거 run이 아니라 매니페스트/파일 존재로 판정한다).
   */
  "retro.v1"(o, e) {
    const period = req(e, o, "period", "object");
    if (period) { req(e, period, "from", "string", "period"); req(e, period, "to", "string", "period"); }
    const lessons = req(e, o, "lessons", "array") || [];
    lessons.forEach((l, i) => {
      const p = `lessons[${i}]`;
      req(e, l, "role", "string", p); req(e, l, "text", "string", p); evidenceRuns(e, l, p);
    });
    const examples = req(e, o, "examples", "array") || [];
    examples.forEach((x, i) => {
      const p = `examples[${i}]`;
      req(e, x, "role", "string", p); oneOf(e, x, "kind", ["good", "bad"], p); req(e, x, "text", "string", p); evidenceRuns(e, x, p);
    });
    const perspectives = req(e, o, "perspectives", "array") || [];
    perspectives.forEach((p, i) => {
      const path = `perspectives[${i}]`;
      req(e, p, "role", "string", path); req(e, p, "text", "string", path); evidenceRuns(e, p, path);
    });
    const harness = req(e, o, "harness", "array") || [];
    harness.forEach((h, i) => { const p = `harness[${i}]`; req(e, h, "target", "string", p); req(e, h, "reason", "string", p); });
    const proposals = req(e, o, "proposals", "array") || [];
    proposals.forEach((p, i) => {
      const path = `proposals[${i}]`;
      oneOf(e, p, "kind", ["gate", "threshold", "role-change", "role-new", "test-delete"], path);
      req(e, p, "title", "string", path); req(e, p, "body", "string", path); evidenceRuns(e, p, path);
    });
    req(e, o, "summary", "string");
  },
  "rework-response.v1"(o, e) {
    req(e, o, "issue", "number");
    const rs = req(e, o, "responses", "array") || [];
    rs.forEach((r, i) => {
      req(e, r, "id", "string", `responses[${i}]`);
      const s = oneOf(e, r, "status", ["fixed", "disputed"], `responses[${i}]`);
      if (s === "fixed") req(e, r, "commit", "string", `responses[${i}]`);
      if (s === "disputed") req(e, r, "reason", "string", `responses[${i}]`);
    });
  },
};

export function validate(name, obj) {
  const fn = SCHEMAS[name];
  if (!fn) throw new Error(`unknown schema: ${name}`);
  const errors = [];
  if (typeof obj !== "object" || obj === null) errors.push("value must be an object");
  else fn(obj, errors);
  return { ok: errors.length === 0, errors };
}
