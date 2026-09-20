---
name: Factory improvement (KTB 자신에 대한 개선)
about: 팩토리가 제 증거로 올리는 것과 같은 모양으로, 사람이 손으로 KTB 개선을 적는다
title: "factory-improvement: <원인 파일> — <무엇이 잘못됐나>"
labels: ["factory-improvement", "backlog"]
---

<!-- factory-improvement fp=manual-<짧은-슬러그> tags=ktb from=owner/repo#0 -->

<!--
  ↑ 첫 줄은 지우지 말 것. 기계가 읽는 유일한 줄이다.
    fp    = 같은 원인을 한 이슈로 모으는 dedupe 키. 손으로 열 때는 `manual-<짧은-슬러그>`로 적는다
            (팩토리가 연 이슈는 여기에 해시가 들어 있다 — 같은 해시면 새 이슈 대신 아래 Evidence에 덧붙는다).
    tags  = harness / ktb / product / ambiguous 중 하나 이상, 쉼표로. **원인 파일의 owner**가 정한다:
            사용 저장소가 소유한 파일(harness.toml, CHARTER.md, scripts/*)이면 `harness`,
            KTB가 배포한 파일(.factory/**, .claude/agents/*.md, 템플릿, 스킬)이면 `ktb`.
            KTB의 기본값·안내가 하네스 실수를 못 막은 경우는 둘 다 적는다(`ktb,harness`).
            원인 파일을 못 고르겠으면 `ambiguous`로 적고 후보를 아래에 둘 다 쓴다 — 지우지 말 것.
    from  = 이 소견이 나온 저장소와 이슈(`owner/repo#N`). 손으로 여는 것이면 그 관측을 한 곳.
  이 이슈는 `backlog`으로 착지한다. 팩토리가 자기 자신에 대해 무엇을 먼저 고칠지는 사람이 고른다.
-->

## 무엇이 일어났나

<!-- 한 문단. "무엇을 기대했고 대신 무엇이 일어났나" — 판정이 아니라 관측을 쓴다. -->

- **원인 파일:** `<path>:<line>` (owner: `factory` | `user`)
- **스테이지/라운드:** `<triage|plan|implement|review|merge>` / round `<n>`
- **재현 명령:** `<한 줄로 다시 재현되는 명령>`
- **테스트:** `<있으면 실패한 테스트 이름>`
- **KTB 버전:** `<1.x.y>`
- **분류(tags):** `<ktb | harness | ktb,harness | ambiguous>`
- **최초 출처:** `<owner/repo#N>`

## Evidence

<!--
  항목 하나가 "한 번의 목격"이다. 같은 원인을 다시 보면 새 이슈를 열지 말고 여기에 한 줄 더한다
  (팩토리도 그렇게 한다 — `appendEvidence`). 머리 줄 형식은 아래 그대로 둔다.
-->

- **owner/repo#N** — `<stage>` / round `<n>` · `<path>:<line>`
  <관측 한 줄>
  ```
  <로그·게이트 출력 스니펫 (40줄 이내)>
  ```

## 어떤 고침을 상상하고 있나 (선택)

<!-- 제안은 선택이다. 증거 없는 제안보다 제안 없는 증거가 낫다. -->
