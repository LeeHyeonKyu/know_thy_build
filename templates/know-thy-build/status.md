---
description: Show the factory's current status exactly as `npx know-thy-build factory status` renders it — Needs You, in-progress, queue, back pressure, recent merges, usage — then print the exact next command for every Needs-You item. Read-only: never changes anything.
allowed-tools: [Bash]
---

# Know Thy Build — Status

You are the person's dashboard. There is nothing to decide here and nothing to compute — `npx know-thy-build factory status` already read everything and rendered the one screen that matters. Your only job is to show that screen and, for anything under "Needs You", tell the person the exact command that continues from there.

## Language

**All conversation around the CLI output MUST be in: {{LANG}}**

The CLI's own output (labels, numbers, field names) is shown as-is, unmodified. Your commentary around it uses the specified language.

## Trigger

상시

## Reads

라벨·PR·heartbeat·격리·예산

## Does

`npx know-thy-build factory status`(출력 그대로) → Needs You 항목마다 해당 스킬로 바로 이동(`:unstick 118`)

## Produces

없음(읽기 전용)

## Must not

상태 변경

## 집행 규칙 (읽기 전용)

**Guard**: 무엇을 하기 전에 `.factory/bin/run-stage.js`가 있는지 먼저 본다 — 없으면 이 저장소에는 아직 factory가 없다. 그때는 "factory가 아직 없음 — `npx know-thy-build factory init`" 한 줄만 출력하고 즉시 멈춘다(아무것도 읽거나 쓰지 않는다).

이 스킬은 읽기 전용이다 — 라벨을 전이하지 않고, 이슈나 PR을 만들거나 편집하지 않으며, 어떤 파일도 쓰지 않는다. 머지는 이 스킬이 다루는 대상이 아니다 — `gh pr merge` 금지, 어떤 경우에도 호출하지 않는다. 상태 계산은 절대 다시 구현하지 않는다(P5-R3) — `npx know-thy-build factory status`가 유일한 소스이고, 이 스킬은 그 출력을 사람 대화로 옮기는 것뿐이다.

---

## How You Operate — 2단계 (실행 → Needs You 항목마다 다음 명령)

### Step 1: CLI 실행, 출력 그대로 보여주기

```bash
npx know-thy-build factory status
```

화면 구성(Needs You → 진행 중 → 큐 → 역압 → 최근 머지 → 사용량)은 CLI가 결정한다 — 이 스킬은 순서도 문구도 다시 만들지 않는다. 반환된 텍스트를 그대로 보여준다.

필요하면(예: 항목별로 다음 명령을 자동으로 붙이려고) 기계가 읽는 형태도 함께 확인한다:

```bash
npx know-thy-build factory status --json
```

```json
{
  "needsYou": [{ "kind": "needs-human", "number": 118, "title": "...", "hint": ":unstick 118" }],
  "inProgress": [...],
  "queue": [...],
  "backPressure": { "awaiting_review": 2, "max": 4, "quarantined": 1, "quarantine_max": 5 },
  "recent": [...],
  "usage": {...}
}
```

`kind`는 네 가지뿐이다 — `needs-human`, `needs-info`, `retro-proposal`, `harness`.

### Step 2: Needs You 항목마다 정확한 다음 명령 제시

`## Needs You`(또는 `--json`의 `needsYou[]`)의 항목마다 `kind`에 맞는 다음 명령을 그대로 붙여 말한다:

| kind | 다음 명령 |
|---|---|
| `needs-human` | `/know-thy-build:unstick <n>` |
| `needs-info` | `/know-thy-build:clarify <n>` |
| `retro-proposal` | `/know-thy-build:proposal <pr>` |
| `harness` | `/know-thy-build:harness <pr>` |

```
## Needs You
- [needs-human] #118 "캘린더 오프라인 캐시" — 다음: /know-thy-build:unstick 118
- [retro-proposal] #131 "gate 승격 제안" — 다음: /know-thy-build:proposal 131
```

**큐(`## 큐`)가 비어 있으면**: 이것은 "할 일이 없다"가 아니라 "**아직 착수시킨 것이 없다**"는 뜻이다 — `## 큐`가 세는 것은 `queue`/`ready`/`planned`/`approved` 상태의 이슈이고(`factory/lib/status.js`의 `QUEUE_STATES`), `backlog`에 쌓인 이슈는 여기 나타나지 않는다. 그러니 "backlog가 비었다"고 말하지 말고 이렇게 안내한다: "지금 공장이 집어 갈 이슈가 없습니다 — `/know-thy-build:next`로 backlog에서 다음 이슈를 골라 큐에 넣으세요."

**역압이 상한이면**(`backPressure.awaiting_review >= backPressure.max` 또는 `backPressure.quarantined >= backPressure.quarantine_max`): 먼저 그 사실을 말하고, 임계값 자체를 조정할지는 `/know-thy-build:proposal`로, 지금 막힌 이슈를 푸는 것은 `/know-thy-build:unstick`으로 안내한다 — 이 스킬은 상한을 넘겨서 진행시키지 않는다(Must not, 상태 변경 없음).

## Closing

- 이 스킬은 CLI가 이미 계산한 화면을 사람 대화로 옮기는 것뿐이다 — 계산은 하지 않는다(Must not).
- 매 실행마다 아무것도 바뀌지 않는다 — 라벨·이슈·PR·파일 전부 실행 전과 같다.
- 다음에 다시 상태를 보고 싶으면 `/know-thy-build:status`를 다시 실행한다.
