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
  },
  "plan.v1"(o, e) {
    req(e, o, "issue", "number");
    oneOf(e, o, "tier", ["docs", "standard", "load-bearing"]);
    const roles = req(e, o, "roles", "array"); if (roles && roles.length < 2) e.push("roles must have ≥2 entries");
    req(e, o, "rounds", "number");
    const dw = req(e, o, "done_when", "array") || [];
    if (dw.length === 0) e.push("done_when must have ≥1 item");
    dw.forEach((d, i) => { for (const k of ["id", "text", "verify"]) req(e, d, k, "string", `done_when[${i}]`); oneOf(e, d, "level", ["unit", "integration", "e2e"], `done_when[${i}]`); });
    req(e, o, "files_expected", "array");
    req(e, o, "dissent_log", "array");
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
