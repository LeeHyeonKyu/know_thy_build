import { createHash } from "node:crypto";

/**
 * 발견(finding)의 **지문**. 같은 원인이 여러 이슈에서 다시 나타나면 위쪽 저장소에 이슈를 새로 열지
 * 않고 기존 이슈에 증거를 덧붙이기 위한 열쇠다(spec §6, §10 Q2).
 *
 * 재료는 `causal.path + normalizeReason(reason)` **둘뿐이다 — 태그는 넣지 않는다.** 태그는 그 원인을
 * *누가 고치는가*라는 메타데이터이고, 다중 태그 방아쇠는 reason 텍스트에 달려 있어 같은 원인이
 * 한 이슈에서는 `[harness]`, 다음 이슈에서는 `[harness, ktb]`로 나올 수 있다. 태그를 해시에 넣으면
 * 그 흔들림이 **하나의 원인을 두 개의 상류 이슈로 쪼갠다** — §6이 막겠다고 약속한 바로 그것이다
 * (리뷰 should_fix 2).
 *
 * 정규화가 지우는 것은 **원인이 아니라 그 원인이 관측된 자리**뿐이다: 이슈 번호, sha, run id,
 * `:줄:칸`. 그 밖의 숫자는 **남긴다** — `exit 127`과 `exit 1`, `HTTP 404`와 `HTTP 500`,
 * `node 20`과 `node 22`는 서로 다른 원인이고, 뭉쳐 놓으면 한 이슈에 섞인 증거만 남아 아무도
 * 둘 중 어느 것도 못 고친다(리뷰 should_fix 1; spec §10 Q2가 감시하라고 한 과합침).
 */

/** 이유 문자열에서 "관측 자리"를 지운다. sha를 먼저 지워야 뒤 규칙이 sha를 반쪽만 먹지 않는다. */
export function normalizeReason(reason) {
  return String(reason ?? "")
    .toLowerCase()
    .replace(/#\d+/g, " ")                               // 이슈/PR 번호
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")                 // sha(7자 이상 hex)
    .replace(/\brun[ _-]?(?:id)?[:= ]*\d+/g, "run id ")  // run id 34809992796
    .replace(/:\d+(?::\d+)?\b/g, "")                     // file.js:123 / file.js:123:4 줄 번호
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 구분자. 없으면 path의 꼬리와 reason의 머리가 이어져 서로 다른 두 입력이 같은 지문을 낼 수 있다.
 * 리터럴 0x00을 소스에 적지 않고 코드포인트로 만든다 — 파일에 0x00이 들어가는 순간 git이 이 모듈을
 * binary로 분류해 `git diff`가 내용을 영영 보여주지 않는다(`factory/bin/lint.js`의 `nul-byte` 규칙).
 */
const SEP = String.fromCharCode(0);

/**
 * 안정 해시(sha256 앞 16자리). 순수 함수 — 같은 원인은 언제나 같은 지문.
 * @param {{path?: string|null, reason?: string}} cause 태그는 받지 않는다(위 설명).
 */
export function fingerprint({ path = null, reason = "" } = {}) {
  return createHash("sha256")
    .update("factory-finding")
    .update(SEP)
    .update(String(path ?? ""))
    .update(SEP)
    .update(normalizeReason(reason))
    .digest("hex")
    .slice(0, 16);
}
