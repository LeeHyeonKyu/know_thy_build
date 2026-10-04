<!-- factory-lessons:v1 role=factory-builder max=12 -->
# Lessons — factory-builder

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
- [L-2026-10-04-01] 새 정규식·파서·캐시 헬퍼·경로 목록·gh 어댑터 메서드를 추가하기 전에, 같은 형식이나 규칙을 이미 쓰거나 읽는 곳을 `rg`로 찾는다(마커라면 그 마커를 만드는 함수, 기록 경로라면 run-record.js의 `recordPath`, 글롭 목록이라면 기존 목록 상수). 있으면 그것을 export해서 import한다. 핸드오프 전에 그 형식의 핵심 토큰을 `rg`로 세어 보고, 이번 diff가 두 번째나 세 번째 리터럴을 만들었으면 지금 하나로 합친다. 근거: reviewer-architecture는 세 번째 복사본을 자동으로 …
  근거: runs/149.md, runs/156.md, runs/157.md, runs/168.md, runs/178.md, runs/195.md. 인용: 0회.
- [L-2026-10-04-02] 이번 diff가 새 판정(merge 허용, 예산 제외, 브레이커 open/closed, veto 창)의 입력으로 어떤 바이트를 읽게 되면, 그 출처마다 누가 쓸 수 있는지를 한 줄씩 적는다. 대상은 /tmp 아래 파일, 러너가 syncRecords로 그대로 미는 docs/factory/runs/** 섹션 줄, 에이전트 토큰으로 올릴 수 있는 commit status, 에이전트 텍스트가 그대로 실리는 run record 줄이다. 에이전트 세션이 쓸 수 있는 출처라면 review-quorum.js:29-37처럼 run_id·runne…
  근거: runs/149.md, runs/170.md, runs/189.md, runs/196.md. 인용: 0회.
- [L-2026-10-04-03] DECISIONS·ADR·README·코드 주석에 엔진 동작을 단언하는 문장(예: '이 경로는 inconclusive다', '한 창에 둘 이상이면 라운드를 잃는다', '유일한 브레이크다', 'exit 0이다')을 쓰거나 고칠 때는, 그 문장이 말하는 분기를 지키는 테스트 id를 문장 옆에 적는다. 적을 id가 없으면 그 분기(설정 값, 실패 1회, 파일 부재, 저장소 밖 경로, triage 스테이지)를 먼저 테스트로 고정하거나 그 문장을 지운다. 근거: 5개 이슈에서 새로 넣은 산문이 출하된 코드와 반대여서 reject됐다. #1…
  근거: runs/18.md, runs/143.md, runs/157.md, runs/174.md, runs/196.md. 인용: 0회.
