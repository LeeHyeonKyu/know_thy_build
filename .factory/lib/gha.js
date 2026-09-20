import { appendFileSync } from "node:fs";

/**
 * ── 러너의 두 출력 채널 — **잡이 조용히 초록으로 도는 것을 막는 자리** ────────────────────────
 *
 * GitHub Actions에서 사람이 실제로 보는 것은 둘뿐이다: 잡 옆의 **빨간 주석**(`::error::`)과 실행
 * 페이지의 **스텝 요약**(`$GITHUB_STEP_SUMMARY`). stdout의 한 줄은 아무도 열지 않는다 — 로그를
 * 펼쳐야 보이고, 초록 체크가 이미 "괜찮다"고 말한 뒤이기 때문이다.
 *
 * 그래서 **설정·권한 실패**(상류 토큰에 `issues:write`가 없다, 라벨이 없다, 크로스-레포 쓰기가
 * 403이다)는 반드시 이 둘로 나가야 한다. 그러지 않으면 루프는 한 줄도 나르지 못하는 채로 주마다
 * 초록 체크만 쌓고, 그 침묵은 "고장이 없다"와 글자 하나 다르지 않다.
 *
 * `health.js`가 이 두 함수를 인라인으로 갖고 있었고 `retro.js`의 크로스-레포 팔은 **아무것도 갖고
 * 있지 않았다**(리뷰 should_fix 2: 상류 gh 에러가 `error` 액션 한 줄 + `console.log` 하나로 끝나
 * 잡은 exit 0, 주석도 요약도 없었다 — `FACTORY_BOT_TOKEN`에 upstream `issues:write`가 없으면 모든
 * `[ktb]` 발견이 영원히 조용히 죽는다). 한 벌만 두면 다음 호출자도 같은 계약을 진다.
 *
 * 러너 **밖**(노트북, 테스트)에서는 둘 다 조용한 no-op이다 — 환경 변수가 없으면 쓸 자리가 없다.
 * 어느 쪽도 던지지 않는다: 보고 채널의 실패가 그것이 보고하려던 작업을 죽이면 안 된다.
 */

/** 잡 요약에 마크다운을 덧붙인다. `$GITHUB_STEP_SUMMARY`가 없으면 아무것도 하지 않는다. */
export function stepSummary(text, { env = process.env, append = appendFileSync, log = console.error, what = "factory" } = {}) {
  const p = env?.GITHUB_STEP_SUMMARY;
  if (!p) return false;
  try { append(p, text); return true; }
  catch (e) { log(`${what}: could not write the job summary — ${e?.message || e}`); return false; }
}

/**
 * `::error title=<title>::<reason>` 한 줄. 워크플로 명령은 **한 줄**이어야 하므로 개행을 접는다 —
 * 접지 않으면 둘째 줄부터는 평범한 로그가 되어 주석에 실리지 않는다(= 사람이 원인의 뒷부분을 잃는다).
 */
export function errorAnnotation(title, reason, { out = console.log } = {}) {
  const line = `::error title=${String(title)}::${String(reason).replace(/\r?\n/g, " ")}`;
  out(line);
  return line;
}

/**
 * 실패 하나를 **두 채널 모두로** 내보낸다 — 주석 한 줄 + 요약의 불릿 한 줄. `keep-going` 잡(회고처럼
 * fail-safe가 계약인 잡)도 이것만 부르면 exit 코드를 바꾸지 않은 채 소리를 낼 수 있다.
 */
export function announceFailure({ title, reasons = [], heading = null, env = process.env, out = console.log, append = appendFileSync, log = console.error }) {
  const list = (Array.isArray(reasons) ? reasons : [reasons]).map((r) => String(r ?? "").trim()).filter(Boolean);
  if (!list.length) return 0;
  for (const r of list) errorAnnotation(title, r, { out });
  stepSummary(`## ${heading || title}\n\n${list.map((r) => `- **failed:** ${r}`).join("\n")}\n`, { env, append, log, what: title });
  return list.length;
}
