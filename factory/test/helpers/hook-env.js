/**
 * ── KTB-40 — 훅을 실행하는 테스트는 **세션의 env를 물려받으면 안 된다** ────────────────────────
 *
 * 저장소의 훅들은 몇 개의 환경 변수로 판정과 출력 위치를 바꾼다:
 *  - `FACTORY_STAGE`         — 스테이지 세션이면 브랜치 이동을 전면 금지한다(ADR-023 Task 8b).
 *  - `FACTORY_HARNESS_ISSUE` — 승격 이슈에서 테스트 인프라 파일을 연다(KTB-20/23).
 *  - `CLAUDE_PROJECT_DIR`    — 절대 경로 qa 카브아웃의 뿌리이고, `record-agents.sh`가 `agents.jsonl`을
 *                              쓰는 디렉터리의 뿌리다(= 설정돼 있으면 tmp cwd가 아니라 **진짜 저장소**에 쓴다).
 *
 * 그런데 `lib/exec.js`의 `run()`은 기본으로 `process.env` 위에 `opts.env`를 얹는다. 즉 이 테스트들을
 * **팩토리 스테이지 안에서** 돌리면(`run-stage.js`가 `claude -p`의 env에 `FACTORY_STAGE`를 심고, 그
 * 세션이 `npm test`를 부른다) 세 변수가 그대로 흘러들어 "세션 밖에서는 브랜치 이동이 사람의 평범한
 * 동작이다" 같은 테스트가 **환경 때문에** 빨개진다. 판정이 테스트의 진술이 아니라 실행 위치에 달리면
 * 그 테스트는 더 이상 아무것도 고정하지 않는다.
 *
 * `baseEnv()`는 그 세 변수를 지운 `process.env` 사본이다. 호출자가 준 값만 그 위에 얹고, 훅 spawn은
 * `replaceEnv: true`로 넘긴다 — 그러지 않으면 `run()`이 `process.env`를 다시 얹어 지운 키가 돌아온다.
 */
export const HOOK_SESSION_ENV = Object.freeze(["FACTORY_STAGE", "FACTORY_HARNESS_ISSUE", "CLAUDE_PROJECT_DIR"]);

export function baseEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!HOOK_SESSION_ENV.includes(k) && v !== undefined) out[k] = v;
  }
  return { ...out, ...extra };
}

/** `run()`에 그대로 펼쳐 넣을 수 있는 opts 조각. `extra`만 명시적으로 얹힌다. */
export const isolatedEnvOpts = (extra = {}) => ({ env: baseEnv(extra), replaceEnv: true });

/** 주입받은 실행기를 감싸 자식 env에서 세션 변수를 뺀다 — `checkHooks({ run })` 같은 호출자용. */
export const isolatedRunner = (runner) => (cmd, args = [], opts = {}) =>
  runner(cmd, args, { ...opts, ...isolatedEnvOpts(opts.env || {}) });
