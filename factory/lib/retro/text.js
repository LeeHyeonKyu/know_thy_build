// 에이전트가 준 한 줄짜리 텍스트(lesson 체크 문장·역할 예시·관점)의 정규화. 순수 함수.
//
// 왜 필요한가: `retro.v1`의 `text`는 스키마상 그냥 문자열이라 에이전트가 여러 줄을 담을 수 있고,
// 그 텍스트는 **마크다운 파일의 한 항목**으로 들어간다. 줄바꿈이 섞이면 두 곳이 동시에 깨진다:
//   - lessons: `- [L-…] <문장>` 다음 줄이 `  근거: …`여야 한다(§7.4). 문장에 개행이 있으면 integrity의
//     `lessonsFormat`이 그 항목을 형식 위반으로 읽고 PR이 RED가 된다 — 자체 머지가 영원히 실패한다.
//   - 역할 파일: `- <문장>`의 중간에 `## Lens` 같은 줄이 들어오면 **새 섹션 헤더가 생긴다**. integrity의
//     `additive_only`는 허용 목록 밖 섹션의 변경을 정책 위반으로 보고하고, 그러면 `publish.js`의 로컬
//     선검사가 그 PR을 아예 열지 않는다(ADR-020 KTB-6 — 정책 위반은 체크를 RED로 만들지 않지만 다크
//     머지 자격은 잃는다). 에이전트가 헤더를 지어내 역할 파일을 다시 쓰는 경로를 원천 차단한다.
// 그래서 모든 공백류(개행·탭·연속 공백)를 단일 공백으로 접고, 양끝을 다듬고, 길이를 자른다.
// 자르기는 결정적이다 — 같은 입력은 항상 같은 항목이 되어 중복 판정(`duplicate`)이 흔들리지 않는다.

export const TEXT_MAX = 300;

/**
 * `normalizeItemText(raw, max = 300) → string` — 공백류를 단일 공백으로, trim, `max`자로 자르고
 * 잘렸다는 사실을 `…` 한 글자로 남긴다(결과 길이는 언제나 `max` 이하다). 빈 문자열은 그대로 ""로
 * 돌려준다 — "비었다"는 판정과 그에 대한 거부는 호출자(lessons.js / role-additions.js)의 몫이다.
 */
export function normalizeItemText(raw, max = TEXT_MAX) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
