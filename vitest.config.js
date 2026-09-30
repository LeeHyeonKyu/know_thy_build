/**
 * ADR-020 KTB-35 ① — `silent: true`: **테스트가 부른 `console.*`를 워커가 파이프에 쓰지 않는다.**
 * 포크된 워커가 이미 닫힌 stdout/stderr에 쓰면 `Error: write EPIPE`로 죽고, 그 죽음은 vitest를
 * exit 1로 만들면서도 JSON 리포트에는 실패 테스트를 하나도 남기지 않는다(1715/1715 통과인데 code 1 —
 * KTB #3 implement R2, run 34809992796). 리포터 출력과 `--outputFile` JSON 리포트는 그대로다:
 * 막는 것은 **테스트 본문의 콘솔 출력**뿐이고, 게이트의 판정 재료는 리포트 파일이다.
 */
/**
 * 1.4.35 (L48) — `maxWorkers: "25%"`, `testTimeout: 20000`. 이 스위트의 무거운 테스트는 전부 **프로세스를 띄운다**
 * (훅 스크립트, CLI, git). 워커를 코어 수만큼 띄우면 그 자식 프로세스들이 코어를 다시 나눠 쓰고, 기본 5초 안에
 * 끝나던 테스트가 넘긴다: 16코어 Mac에서 같은 다섯 테스트가 세 번 연속 타임아웃으로 떨어졌고(직렬로는 전부 통과),
 * 지난 캠페인은 그 때문에 릴리스 체인을 세 번 다시 돌렸다. 판정이 기계의 부하에 달려 있으면 그것은 게이트가 아니다.
 */
export default { test: { include: ["factory/test/**/*.test.js"], environment: "node", silent: true, maxWorkers: "25%", minWorkers: 1, testTimeout: 20000 } };
