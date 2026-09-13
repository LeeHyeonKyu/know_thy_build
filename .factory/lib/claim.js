export const lockRef = (issue) => `refs/heads/factory/lock-${issue}`;

/**
 * ADR-020 KTB-28 — 락 소유자 문자열(`runner=…`)이 **GitHub 워크플로 런**을 가리키면 그 런 id.
 * `gha-<run_id>`만 그렇다(`FACTORY_RUNNER_ID: gha-${{ github.run_id }}`, 워크플로 템플릿). 로컬 러너
 * (`local/<hostname>`)는 물어볼 API가 없으므로 null — 호출자는 그것을 "살아 있다"로 읽는다(fail closed).
 */
export const ghaRunIdOf = (runner) => (/^gha-(\d+)$/.exec(String(runner ?? "")) || [])[1] ?? null;

/**
 * **이 락을 쥔 워크플로 런은 아직 도는가**(ADR-020 KTB-28). 데모 #15가 이 물음이 없어서 죽었다:
 * 04:39에 타임아웃으로 사라진 review 런(정리 스텝이 생기기 전 배포본)의 `refs/heads/factory/lock-15`가
 * 고아로 남고, 그 뒤의 모든 dispatch(sweeper stalled ×4 + 수동)가 26~40초 만에 `claim()`에서 죽었다 —
 * exit 0, 기록 없음, 코멘트 없음, 잡 결론 success. 바깥에서 보면 "디스패치가 잘 됐다"였다.
 *
 * `completed: true`는 **확인된 종료**일 때만 선다. 조회가 실패했거나(자격증명·네트워크·삭제된 런),
 * 상태를 파싱하지 못했거나, 애초에 워크플로 런이 아니면(로컬 러너) 전부 "살아 있다"로 떨어진다 —
 * 틀린 회수는 같은 이슈에 두 스테이지를 동시에 넣는 일이고, 틀린 대기는 다음 sweep이 되돌릴 수 있다.
 */
export async function runnerState({ run, cwd, runner }) {
  const id = ghaRunIdOf(runner);
  if (!id) return { completed: false, status: "not-a-workflow-run" };
  let r;
  try { r = await run("gh", ["run", "view", id, "--json", "status"], { cwd }); }
  catch (e) { return { completed: false, status: `unreachable (${e?.message || e})` }; }
  if (r.code !== 0) return { completed: false, status: "unreachable" };
  let status;
  try { status = JSON.parse(r.stdout)?.status; }
  catch { return { completed: false, status: "unparseable" }; }
  return { completed: status === "completed", status: status || "unknown" };
}

/**
 * `runnerState`는 주입 가능하다(`checkRunner`) — 테스트가 가짜 런을 주고, 호출자가 조회를 한 곳으로
 * 모을 수 있다. 기본값은 같은 `run`으로 `gh run view`를 부르는 위 구현이다.
 */
export async function claim({ run, cwd, issue, stage, runnerId, now = new Date().toISOString(), checkRunner = runnerState }) {
  const g = (args) => run("git", args, { cwd });
  const treeR = await g(["hash-object", "-t", "tree", "/dev/null"]);       // empty tree
  const tree = treeR.stdout.trim();
  if (treeR.code !== 0 || !tree) return { ok: false, holder: "unknown", error: "hash-object failed: " + treeR.stderr };
  const msg = `lock issue=${issue} stage=${stage} runner=${runnerId} at=${now}`;
  const commitR = await g(["commit-tree", tree, "-m", msg]);
  const commit = commitR.stdout.trim();
  if (commitR.code !== 0 || !commit) return { ok: false, holder: "unknown", error: "commit-tree failed: " + commitR.stderr };
  const push = await g(["push", "origin", `${commit}:${lockRef(issue)}`]);
  if (push.code === 0) return { ok: true, commit };
  // someone else holds it — read who via FETCH_HEAD (avoids stale-local-ref non-fast-forward)
  const fetch = await g(["fetch", "origin", lockRef(issue)]);
  if (fetch.code !== 0) return { ok: false, holder: "unknown", runner: null, status: "unknown", stderr: push.stderr };
  const who = (await g(["log", "-1", "--format=%s", "FETCH_HEAD"])).stdout.trim();
  const holder = lockRunnerOf(who);
  const state = await checkRunner({ run, cwd, runner: holder });
  if (!state.completed) return { ok: false, holder: who || "unknown", runner: holder, status: state.status, stderr: push.stderr };
  // KTB-28 — 소유자의 런이 끝났다: 락은 잔해다. 지우고 다시 세운다. 지우기와 세우기 사이에 다른
  // 러너가 먼저 잡을 수 있으므로(그 러너는 살아 있다), 재생성이 실패하면 **우리 것이 아니다** —
  // 회수했다고 말하지 않고 평범한 거부로 돌아간다.
  const del = await g(["push", "origin", "--delete", lockRef(issue)]);
  if (del.code !== 0) return { ok: false, holder: who || "unknown", runner: holder, status: `${state.status} (reclaim delete failed)`, stderr: del.stderr };
  const again = await g(["push", "origin", `${commit}:${lockRef(issue)}`]);
  if (again.code !== 0) return { ok: false, holder: who || "unknown", runner: holder, status: `${state.status} (reclaim lost the race)`, stderr: again.stderr };
  return { ok: true, commit, reclaimed: { runner: holder, status: state.status } };
}

export async function release({ run, cwd, issue }) {
  const r = await run("git", ["push", "origin", "--delete", lockRef(issue)], { cwd });
  return r.code === 0;
}

/** 락 커밋 제목(`lock issue=… stage=… runner=… at=…`)에서 소유자 러너 id. */
export const lockRunnerOf = (subject) => (/(?:^|\s)runner=(\S+)/.exec(String(subject ?? "")) || [])[1] ?? null;

/**
 * **지금 이 락을 누가 쥐고 있는가**(ADR-020 KTB-24 fix). `release()`는 소유자를 묻지 않고 지운다 —
 * 그것으로 충분한 자리(`runStage`의 finally: 이 프로세스가 방금 claim에 성공했으므로 락은 정의상
 * 우리 것이다)가 있고, 충분하지 않은 자리가 있다: `abortStage`는 **claim에 실패해 물러난 런에서도**
 * 돈다(취소·실패는 claim 이전에도 온다). 그 경로에서 `release()`를 부르면 지금 정상적으로 돌고 있는
 * 다른 러너의 락을 지워 같은 이슈에 두 스테이지가 동시에 들어갈 수 있다.
 *
 * 돌려주는 값:
 *   - `{present: false}` — 락 브랜치가 없다(이미 풀렸다). 지울 것도, 사람에게 시킬 것도 없다.
 *   - `{present: true, runner, subject}` — 있다. `runner`가 null이면 제목을 파싱하지 못한 것이다.
 *   - `{present: null, reason}` — 조회 자체가 실패했다(네트워크·자격증명). "없다"와 구별해야 한다.
 * 원격 ref가 없을 때 git은 exit≠0 + "couldn't find remote ref"를 낸다 — 그 문구가 유일한 구분점이다.
 *
 * r1 재리뷰 M4: 예전에는 맨 끝에 `|not found`가 붙어 있었다. 그 조각은 **레포 자체를 못 찾은 실패**
 * ("remote: Repository not found." — 토큰 만료·권한 박탈)까지 "락이 없다"로 읽는다. 그러면 `abortStage`가
 * 지금 정상적으로 돌고 있는 남의 락을 지우러 간다 — 이 함수가 막으려던 바로 그 사고다. 지웠다.
 */
export async function lockHolder({ run, cwd, issue }) {
  const fetch = await run("git", ["fetch", "origin", lockRef(issue)], { cwd });
  if (fetch.code !== 0) {
    const err = `${fetch.stderr || ""}${fetch.stdout || ""}`;
    if (/couldn't find remote ref|couldn't find remote branch/i.test(err)) return { present: false };
    return { present: null, reason: err.trim() || `git fetch exit ${fetch.code}` };
  }
  const log = await run("git", ["log", "-1", "--format=%s", "FETCH_HEAD"], { cwd });
  if (log.code !== 0) return { present: null, reason: log.stderr.trim() || `git log exit ${log.code}` };
  const subject = log.stdout.trim();
  return { present: true, runner: lockRunnerOf(subject), subject };
}
