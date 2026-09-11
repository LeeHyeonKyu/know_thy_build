import vm from "node:vm";
import { readFileSync } from "node:fs";

/**
 * `.claude/workflows/factory-*.js` 스크립트를 node:vm으로 실제 실행한다.
 * 스크립트는 자급자족이다(import/fs/네트워크/Date.now()/Math.random() 없음, ADR-006) —
 * 이 하네스는 그 제약을 강제하기 위해 sandbox에 Date·require·process·setTimeout을 주지 않는다
 * (Date는 V8이 모든 컨텍스트에 기본으로 붙이므로 컨텍스트 생성 후 명시적으로 지운다).
 *
 * @param {string} file 워크플로 스크립트 경로
 * @param {{agent?: Function, args?: object, log?: Function}} opts
 * @returns {Promise<{result: any, calls: Array<{prompt: string, opts: object}>, phases: string[]}>}
 */
export async function runWorkflow(file, { agent, args = {}, log = () => {} } = {}) {
  const src = readFileSync(file, "utf8");
  const body = src.replace(/^export const meta\b/m, "const meta");

  const calls = [];
  const phases = [];

  const stubAgent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return agent(prompt, opts);
  };

  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

  const pipeline = async (items, ...stages) => {
    const out = [];
    for (const item of items) {
      let cur = item;
      for (const stage of stages) {
        try {
          cur = await stage(cur);
        } catch {
          cur = null;
          break;
        }
      }
      out.push(cur);
    }
    return out;
  };

  const phase = (title) => { phases.push(title); };

  // 스크립트는 결정적이어야 한다(ADR 계열 P3-R6/Global Constraint) — `Math.random()`은 금지.
  // Math의 나머지(max/min/floor/PI/...)는 그대로 두되 `random`만 빠진 사본을 만든다
  // (Object.assign은 Math의 own 프로퍼티가 non-enumerable이라 아무것도 복사하지 못하므로
  // getOwnPropertyNames + defineProperty로 명시적으로 복제한다).
  const sandboxMath = Object.create(null);
  for (const k of Object.getOwnPropertyNames(Math)) {
    if (k === "random") continue;
    Object.defineProperty(sandboxMath, k, Object.getOwnPropertyDescriptor(Math, k));
  }
  Object.freeze(sandboxMath);

  const sandbox = {
    agent: stubAgent,
    parallel,
    pipeline,
    phase,
    log,
    args,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    JSON, Math: sandboxMath, Array, Object, String, Number, Promise, Set, Map,
  };

  const context = vm.createContext(sandbox);
  // V8은 새 컨텍스트에도 표준 내장 전역(Date 포함)을 자동으로 붙인다 — 명시적으로 지워
  // "Date 없음"을 실제로 강제한다(참조하면 ReferenceError).
  new vm.Script("delete this.Date;").runInContext(context);

  const wrapped = `(async () => {\n${body}\n})()`;
  const script = new vm.Script(wrapped, { filename: file });
  const result = await script.runInContext(context);

  return { result, calls, phases };
}
