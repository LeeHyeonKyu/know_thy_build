<!-- factory-lessons:v1 role=factory-builder max=12 -->
# Lessons — factory-builder

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
- [L-2026-10-03-01] factory/lib·factory/bin에 정규식·헬퍼·경로 목록·판정 함수(마커 파서, per-sweep bpCache, '팩토리 로그인이 올린 status인가' 검사, scrub 규칙, 세션 지시 파일 glob 등)를 새로 쓰기 전에 그 규칙의 고유 문자열(마커 이름·glob·함수 이름)로 `rg`를 돌려 기존 구현이 있는지 확인한다 — 하나라도 있으면 복사하지 말고 export해 import하고(엔진 분기·env 주입 같은 기존 인자까지 그대로), 둘이 갈라져야 하면 그 이유를 같은 diff의 주석에 적는다. reviewe…
  근거: runs/149.md, runs/156.md, runs/157.md, runs/168.md, runs/178.md. 인용: 0회.
- [L-2026-10-03-02] diff가 plan `files_expected` 밖의 경로를 건드리면(테스트 헬퍼·공용 파서·스펙 문서 포함), PR 본문뿐 아니라 그 파일 안에 `Scope change (#&lt;issue&gt;): &lt;이 이슈의 어느 done_when 때문인가&gt;` 주석을 diff로 남긴다(factory/lib/retro/issue-comments.js:618의 형태) — 핸드오프 전에 `git diff --name-only &lt;base&gt;...HEAD`를 files_expected와 대조해 남는 경로마다 그 줄이 있는지 확…
  근거: runs/149.md, runs/156.md, runs/157.md, runs/170.md, runs/178.md. 인용: 0회.
- [L-2026-10-03-03] diff가 DECISIONS.md·ADR·README·코드 주석에 엔진 동작을 단언하는 문장(종료 코드, 가드가 무엇을 세는가, 실패 몇 번이면 라운드를 잃는가, 리포트가 없을 때 무엇이 되는가)을 넣거나 고치면, 그 문장 옆에 그 동작을 정확히 고정하는 테스트 id를 댈 수 있는지 확인한다 — 댈 수 없으면 테스트를 쓰거나 문장을 뺀다. 문장이 가리키는 경로(예: report가 저장소 밖일 때, transition 실패 1회일 때)를 테스트가 실제로 지나가는지까지 본다.
  근거: runs/18.md, runs/143.md, runs/157.md, runs/174.md. 인용: 0회.
- [L-2026-10-10-01] diff가 `deps`/client 인자로 주입받는 의존성(gh 어댑터, evidence 소스, dependencyClient 같은 오류 분류 래퍼)을 새로 쓰거나 읽는 소스를 바꾸면, 핸드오프 전에 production 조립 지점(`main()`, `make*Deps`)을 `rg`로 찾아 두 가지를 확인한다 — (1) 테스트가 fake에 넣는 데이터가 production이 실제로 읽는 곳과 같은 출처인가(예: rework 응답은 PR 코멘트에 올라가는데 의존성은 트래킹 이슈 코멘트만 읽는가), (2) 그 조립 줄을 지우거나 바꾸면…
  근거: runs/195.md, runs/196.md. 인용: 0회.
