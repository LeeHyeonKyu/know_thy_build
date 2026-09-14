/**
 * §4.2 factory board — **정적 모드의 호출 계획**만 뽑아낸 순수 함수 (ADR-022 Task B, review 714a45d MUST-FIX 2).
 *
 * `templates/factory/docs/factory/board/index.html`이 `?repo=`로 열릴 때는 브라우저가
 * `api.github.com`을 **직접** 부른다 — 인증 없이는 시간당 60회뿐이다. 그런데 한 번의 폴은 "3 + 이슈 수"
 * 호출이라(이슈 목록·머지 목록·런 목록 + 이슈마다 코멘트 한 번), 10개 이슈짜리 저장소를 2분 주기로
 * 돌리면 8분 만에 예산이 바닥난다. `planStaticPull`은 그 예산 계산을 한곳에 모은다:
 *
 *   - **예산 소진이면 폴 자체를 건너뛴다** — `remaining <= 3`이고 아직 `reset` 전이면 `skip: true`.
 *     이슈 목록조차 다시 받지 않는다(그 한 번의 호출도 예산이다).
 *   - **코멘트는 최근 24시간 안에 갱신된 이슈만 받는다** — `collectRepo`가 라벨 없는 이슈를 찾을 때
 *     쓰는 것과 같은 창(`MISSING_STATE_SCAN_HOURS`)이다. 나머지는 라벨만으로 그린다(`stale-data`).
 *   - **폴링 주기는 토큰 유무로 갈린다** — 토큰이 없으면(시간당 60회) 10분, 있으면(시간당 5000회) 2분.
 *
 * 이 파일은 `factory init`이 설치하지 않는다 — 페이지 안의 인라인 스크립트가 **같은 텍스트**를 그대로
 * 들고 있다(외부 스크립트를 페이지가 불러올 수 없으므로: 스모크 테스트가 그 사실을 검사한다). 두 사본이
 * 갈라지지 않게 `board-page.test.js`가 이 함수의 소스 텍스트와 페이지 안의 함수 소스 텍스트를 바이트
 * 단위로 비교한다 — 그래서 이 파일을 고치면 페이지의 사본도 **글자 그대로** 같이 고쳐야 한다.
 */
export function planStaticPull(opts) {
  var rate = opts.rate, issues = opts.issues || [], now = opts.now, hasToken = opts.hasToken;
  var DAY_MS = 24 * 3600 * 1000;
  var skip = !!(rate && rate.remaining <= 3 && now < rate.reset);
  var commentIssues = [], staleIssues = [];
  if (!skip) {
    issues.forEach(function (i) {
      var t = Date.parse((i && i.updated_at) || "");
      if (isFinite(t) && now - t <= DAY_MS) commentIssues.push(i);
      else staleIssues.push(i);
    });
  }
  return {
    skip: skip,
    resetAt: skip ? rate.reset : null,
    commentIssues: commentIssues,
    staleIssues: staleIssues,
    intervalMs: hasToken ? 120000 : 600000
  };
}
