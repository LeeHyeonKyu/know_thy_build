# 운영 스크립트 (operator tools)

공장을 **지켜보는** 도구들이다 — 공장이 쓰는 것이 아니라 운영하는 사람(또는 운영 세션)이 쓴다. 어느 것도 이슈·PR·라벨을 쓰지 않는다.

| 스크립트 | 무엇을 | 사용 |
|---|---|---|
| `watch-issue.sh <repo> <issue>` | 이슈 하나의 상태 라벨·최신 전이·하트비트를 폴링해 바뀔 때마다 한 줄 | `docs/factory/ops/watch-issue.sh LeeHyeonKyu/own-calendar 111` |
| `timeline.mjs <repo> <issue>` | 전이·핸드오프 코멘트를 시간순 표로 — 각 스테이지가 얼마나 걸렸고 비용이 얼마였는지 | `node docs/factory/ops/timeline.mjs LeeHyeonKyu/know_thy_build 149` |
| `person-steps.sh` | 지금 사람이 해야 하는 일(머지 대기 PR, `needs-human` 이슈)을 한 목록으로 | `docs/factory/ops/person-steps.sh` |
| `board-proxy.mjs <tailscale-ip> [port]` | `factory board`(루프백 전용)를 tailnet에서 보기 위한 평문 HTTP 프록시 | `node docs/factory/ops/board-proxy.mjs "$(tailscale ip -4)" 4173` |

보드 자체는 `npx know-thy-build factory board --repo owner/name --port 4173`로 띄운다(`docs/factory/board/`). 보드가 읽는 신호는 공장이 이미
남기는 것뿐이다 — 라벨, 전이 코멘트, 하트비트의 진행 마커(ADR-022).

## 사람 몫을 줄이는 쪽으로 (ADR-032)
2026-10-02부터 운영 세션은 비판정 경로(문서·리서치·운영 스크립트·보드)만 바뀐 PR을 직접 머지하고, 버전 번호는 publish 워크플로가 러너 생성물로
낸다. 아직 사람에게 남는 것: 판정 경로(엔진·훅·워크플로·CHARTER) PR의 머지와, 사람의 판단이 필요한 `needs-human`의 재시도. 엔진 결함으로 멈춘
이슈의 자동 재시도(#156)와 PR 밖 flaky 테스트의 merge 게이트 재실행(#157)이 들어오면 재시도 요청도 대부분 사라진다.
