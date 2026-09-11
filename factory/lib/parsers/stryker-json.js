export function mutationScore(json) {
  let killed = 0, survived = 0, timeout = 0, noCoverage = 0;
  for (const f of Object.values(json.files || {})) for (const m of f.mutants || []) {
    if (m.status === "Killed") killed++; else if (m.status === "Survived") survived++;
    else if (m.status === "Timeout") timeout++; else if (m.status === "NoCoverage") noCoverage++;
  }
  const total = killed + survived + timeout + noCoverage;
  return { killed, timeout, survived, noCoverage, total, score: total ? Math.round(((killed + timeout) / total) * 1000) / 10 : null };
}
