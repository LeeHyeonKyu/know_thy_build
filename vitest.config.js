/**
 * ADR-020 KTB-35 ① — `silent: true`: **테스트가 부른 `console.*`를 워커가 파이프에 쓰지 않는다.**
 * 포크된 워커가 이미 닫힌 stdout/stderr에 쓰면 `Error: write EPIPE`로 죽고, 그 죽음은 vitest를
 * exit 1로 만들면서도 JSON 리포트에는 실패 테스트를 하나도 남기지 않는다(1715/1715 통과인데 code 1 —
 * KTB #3 implement R2, run 34809992796). 리포터 출력과 `--outputFile` JSON 리포트는 그대로다:
 * 막는 것은 **테스트 본문의 콘솔 출력**뿐이고, 게이트의 판정 재료는 리포트 파일이다.
 */
export default { test: { include: ["factory/test/**/*.test.js"], environment: "node", silent: true } };
