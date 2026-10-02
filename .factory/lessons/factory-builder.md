<!-- factory-lessons:v1 role=factory-builder max=12 -->
# Lessons — factory-builder

Read this file as a checklist before you start. Entries are appended by the retro job only
(`- [L-YYYY-MM-DD-NN] <check sentence> — 근거: <run links>`); integrity rejects other edits.
- [L-2026-10-02-01] README.md나 docs/factory/DECISIONS.md 같은 산문에 엔진 동작을 단언하는 문장(종료 코드, 가드가 무엇을 세고 무엇을 건너뛰는지)을 넣거나 고칠 때는, 그 동작을 구현하는 함수를 열어 file:line을 handoff notes에 적는다. 문장이 CLI 줄을 보여 준다면 적힌 그대로 한 번 실행해 출력과 종료 코드를 문장과 맞춰 본다. 코드와 대조하지 못한 단언은 diff에 넣지 않는다. (#18: README가 'finish --issue 42가 exit 0'이라고 썼지만 실제로는 exit 1이었다. …
  근거: runs/18.md, runs/143.md. 인용: 0회.
- [L-2026-10-02-02] done_when이나 새 DECISIONS 항목이 '절대', '항상', 상한(depth_max 등) 형태의 불변식을 말하면, 같은 코드가 다시 도는 재진입 경로를 handoff notes에 하나씩 적는다. 예를 들면 sweeper의 자동 재시도가 여는 다음 implement 라운드, 자기 생성 이슈 체인의 다음 고리다. 그리고 각 경로에서도 그 검사가 다시 평가되는지 경로마다 테스트 하나로 확인한다. 첫 통과만 막는 가드는 불변식이 아니다. (#136: harness↔flaky 고리가 반복되면 세대가 0으로 접혀 depth_max…
  근거: runs/136.md, runs/143.md. 인용: 0회.
