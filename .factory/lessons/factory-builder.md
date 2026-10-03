<!-- factory-lessons:v1 role=factory-builder max=12 -->
# Lessons — factory-builder

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
- [L-2026-10-03-01] factory/lib·factory/bin에 정규식(마커 파서)·판정 함수("factory 로그인이 올린 status인가")·per-sweep 캐시 헬퍼(`bpCache ??= backPressure()`)·경로 목록(non-judge glob)·스크럽 규칙을 새로 쓰기 전에, 그 규칙의 고유 토큰(마커 이름, `bpCache`, 목록 상수명, `scrubOne`)으로 `rg`를 돌린다 — 이미 구현이 있으면 export해서 호출하고, 그래도 사본을 만들어야 하면 그 이유를 diff 안에 한 줄 남긴다. 확인: 핸드오프 전에 새로…
  근거: runs/149.md, runs/156.md, runs/157.md, runs/168.md. 인용: 0회.
- [L-2026-10-03-02] diff가 DECISIONS.md·ADR·README에 엔진 동작을 단언하는 문장("~하지 않는다", "exit 0", "한 번 실패로는 라운드를 잃지 않는다", "재실행이 리포트를 안 쓰면 inconclusive")을 넣거나 고치면, 그 문장마다 그것을 구현하는 함수:줄과 그것을 핀하는 테스트 id를 찾아 문장과 코드를 나란히 읽는다 — 함수가 반대로 동작하거나 지원되는 설정(예: 저장소 밖 리포트 경로) 하나에서라도 거짓이면 문장을 고친다. 확인: 새/수정된 단언 문장 수 = 대조한 함수:줄 수.
  근거: runs/143.md, runs/157.md, runs/174.md. 인용: 0회.
- [L-2026-10-03-03] 핸드오프 전에 plan handoff의 `non_goals[]` 문장을 하나씩 읽고, 각 문장이 이름 붙인 파일·스키마·메커니즘(예: "gates.js는 주석만", "factory.gates.v1 스키마 변경 금지", "파일 시각 신선도 검사")을 `git diff origin/&lt;default&gt;...HEAD`에서 grep한다 — 걸리면 그 변경을 되돌리거나 멈추고 사유를 남긴다. 확인: non_goals 문장마다 diff grep 결과 0건.
  근거: runs/157.md, runs/170.md. 인용: 0회.
- [L-2026-10-03-04] 새 코드가 머지·판정·리뷰 결과를 어떤 입력(파일 경로, commit status, 이슈 코멘트·마커, 알림 본문)으로 결정하면, 그 입력을 누가 쓸 수 있는지 적는다 — 에이전트 actor·리뷰어 서브에이전트가 쓸 수 있는 곳(/tmp, 에이전트 토큰으로 올릴 수 있는 status, 모델이 출력한 텍스트 안의 블록)이면 그것은 앵커가 될 수 없다(CLAUDE.md SDD 규칙 5). 확인: 판정 입력마다 '쓰기 가능한 주체' 한 줄이 PR 본문 또는 코드 주석에 있다.
  근거: runs/149.md, runs/170.md. 인용: 0회.
