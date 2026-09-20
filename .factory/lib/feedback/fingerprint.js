import { createHash } from "node:crypto";

/**
 * 발견(finding)의 **지문**. 같은 원인이 여러 이슈에서 다시 나타나면 위쪽 저장소에 이슈를 새로 열지
 * 않고 기존 이슈에 증거를 덧붙이기 위한 열쇠다(spec §6, §10 Q2).
 *
 * 재료는 `tags + causal.path + normalizeReason(reason)` 셋뿐이다. 이슈 번호·sha·run id·줄 번호는
 * **원인이 아니라 그 원인이 관측된 자리**이므로 정규화에서 지운다 — 지우지 않으면 같은 결함이
 * 이슈마다 새 이슈를 열고(중복 폭발), 너무 많이 지우면 서로 다른 원인이 한 이슈로 뭉친다
 * (증거가 섞여 아무도 못 고친다). 그 경계가 이 파일의 유일한 판단이다.
 */

/**
 * 이유 문자열에서 "관측 자리"를 지운다. 순서가 중요하다 — sha를 먼저 지워야 일반 숫자 규칙이
 * sha 안의 숫자만 파먹고 알파벳 찌꺼기를 남기지 않는다.
 */
export function normalizeReason(reason) {
  return String(reason ?? "")
    .toLowerCase()
    .replace(/#\d+/g, " ")                               // 이슈/PR 번호
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")                 // sha(7자 이상 hex)
    .replace(/\brun[ _-]?(?:id)?[:= ]*\d+/g, "run id ")  // run id 34809992796
    .replace(/:\d+(?::\d+)?\b/g, "")                     // file.js:123 / file.js:123:4 줄 번호
    .replace(/\b\d+(?:\.\d+)?%?/g, " ")                  // 나머지 수치(라운드·카운트·퍼센트) — spec §10 Q2
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 구분자. 없으면 path의 꼬리와 reason의 머리가 이어져 서로 다른 두 입력이 같은 지문을 낼 수 있다.
 * 리터럴 0x00을 소스에 적지 않고 코드포인트로 만든다 — 파일에 0x00이 들어가는 순간 git이 이 모듈을
 * binary로 분류해 `git diff`가 내용을 영영 보여주지 않는다(`factory/bin/lint.js`의 `nul-byte` 규칙).
 */
const SEP = String.fromCharCode(0);

/** 안정 해시(sha256 앞 16자리). 순수 함수 — 같은 입력은 언제나 같은 지문. */
export function fingerprint({ tags = [], path = null, reason = "" } = {}) {
  return createHash("sha256")
    .update([...tags].sort().join(","))
    .update(SEP + "factory-finding" + SEP)
    .update(String(path ?? ""))
    .update(SEP)
    .update(normalizeReason(reason))
    .digest("hex")
    .slice(0, 16);
}
