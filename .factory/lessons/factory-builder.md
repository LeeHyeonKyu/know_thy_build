<!-- factory-lessons:v1 role=factory-builder max=12 -->
# Lessons — factory-builder

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
- [L-2026-10-01-01] diff가 README·`docs/factory/DECISIONS.md` 같은 산문에 엔진 동작을 단언하는 문장(종료 코드, 출력 형식, 가드가 무엇을 세고 무엇을 건너뛰는지)을 넣거나 고쳤다면, 핸드오프 전에 문장마다 그 동작을 구현한 함수를 열어 단언이 코드와 맞는지 확인하고(가능하면 그 명령을 직접 돌려 종료 코드를 본다), 같은 절에서 반대말을 하는 이웃 문장을 grep으로 찾는다. 맞지 않는 문장은 고치거나 지운다. 근거: #18에서는 README의 새 문장이 `finish --issue 42`가 exit 0이라고 썼지만…
  근거: runs/18.md, runs/143.md. 인용: 0회.
