# know-thy-build

Before you write a single line of code, know what you're building, why, and how.

**know-thy-build** is a multi-agent project definition and quality assurance framework for [Claude Code](https://claude.ai/claude-code). Through Socratic dialogue — not forms — it helps you define your project, design features, establish a QA framework, and orchestrate implementation with built-in design and architecture review.

The result is a set of living documents and an automated workflow where every implementation is reviewed by designer, architect, and QA agents before it ships.

## Why

We jump into code too fast. A new project starts, and within minutes we're picking frameworks, creating files, writing functions — before we've truly asked ourselves what we're building and why.

The cost of skipping this step is real:
- Vague goals → wasted effort
- Undefined boundaries → scope creep
- Unspoken assumptions → wrong decisions — by you or by AI agents
- No QA framework → "done" is an opinion, not a fact
- No design intent → developers guess what to build

know-thy-build exists to **define the project, design the experience, establish what "done" means, and enforce quality through multi-agent review** — all before you write a line of code.

## Quick start

```bash
npx know-thy-build
```

Pick a language, and 13 commands are installed into your `.claude/commands/` — one per human decision point (§13): Define (5) and Operate (8, meaningful once `factory init` has run).

**Define**

| Command | Role | Output |
|---------|------|--------|
| `/know-thy-build:project` | Define what it is, why it exists, and what it must become | `docs/PROJECT.md` |
| `/know-thy-build:technical` | Define how your project will be built | `docs/TECHNICAL.md` + `docs/factory/CHARTER.md` (draft) |
| `/know-thy-build:qa` | QA the product — test framework with behavioral axes, then run and verify with evidence | `docs/QA.md` |
| `/know-thy-build:feature` | Design a feature before building it | `docs/features/NNN.md` + `backlog` issue |
| `/know-thy-build:issue` | Log a bug, chore, or small change — no spec doc | `backlog` issue only |

**Operate**

| Command | Role | Output |
|---------|------|--------|
| `/know-thy-build:harness` | Fix a failing doctor / adopt a brownfield repo | `harness.toml`, doctor PASS |
| `/know-thy-build:next` | Pick the next issue to queue | Label transition, `human-decision` |
| `/know-thy-build:clarify` | Answer `needs-info` questions on a spec | Updated spec/issue, label transition |
| `/know-thy-build:unstick` | Resolve a stuck issue (`needs-human`) | `human-decision`, derived issues, label transition |
| `/know-thy-build:proposal` | Review a retro/harness proposal PR | PR comment (dry-run), `human-decision` |
| `/know-thy-build:role` | Create or edit a reviewer/plan role | `.claude/agents/reviewer-<short>.md` (or `plan-<short>.md`), `roles.toml` diff, PR |
| `/know-thy-build:digest` | Weekly summary of what shipped | `docs/factory/digests/YYYY-Wnn.md` |
| `/know-thy-build:status` | Read-only dashboard (Needs You / in progress / queue) | none (read-only) |

`designer` and `architect` remain installed as optional Phase 1 helpers (invoked from `:feature` for complex UI or structural work) — 15 files installed in total.

## The pipeline

```
Define:     :project → :technical → :qa setup
Per feature: :feature → [:designer] → [:architect] → :issue/:next → factory → ship
```

`[ ]` = optional, invoked when needed.

### Phase 1: Project Definition (once)

```
/know-thy-build:project      What are we building and why?
/know-thy-build:technical    How do we build it? (stack, architecture, testing strategy)
/know-thy-build:qa           Set up the QA framework (environment, behavioral axes, test profiles)
```

These three commands run once at project start. They produce the foundation documents that every subsequent command reads.

### Phase 2: Feature Development (per feature, repeating)

```
/know-thy-build:feature      Define the feature (problem, value, stories, AC, design intent)
/know-thy-build:designer     [optional] Deep UX analysis (heuristics, prototyping, accessibility)
/know-thy-build:architect    [optional] Code design for complex features (stubs, tests, agents)
factory (labelled issue → triage → plan → implement → review → merge)
```

Verification is the factory's job, not a manual step: its review roster (including the `qa` reviewer) and the deterministic gates decide whether a PR is mergeable. `/know-thy-build:qa` sets up the framework and the per-feature test cases those roles judge against.

### Phase 2 — factory (dark build loop)

Once Phase 1 is done, `npx know-thy-build factory` runs the labelled-issue pipeline in CI (triage → plan → implement → review → merge):

**Status**: 1.0.0-alpha — dogfooded on the demo repo (first dark completion 2026-09-12: issue #8 → PR #10); numbers in ADR-020.

- `factory init` — install `.factory/`, `.claude/`, `.github/workflows/`, `docs/factory/` into the repo root (never overwrites; `--diff`/`--upgrade` to refresh package-owned files). On the Claude side that's 4 workflow scripts (`.claude/workflows/factory-{triage,plan,implement,review}.js`), 14 role agents (`.claude/agents/*.md`), and 4 dispatcher commands (`.claude/commands/factory-*.md`)
- `factory doctor` — verify the harness contract (commands, gates, hooks, workflows, GitHub setup); exit 1 on any FAIL
- `factory bootstrap` — labels, branch protection, required checks, `FACTORY_TOKEN_ISSUED_AT` (run it **after** the first `git push`). It also picks the **merge-authority mode** from the secrets it finds — see below

**Secrets — two actors, two tokens (ADR-021).** The factory wants merge power to be unreachable from any stage an agent runs in, by permission rather than by blocking command patterns:

- `FACTORY_BOT_TOKEN` — the **agent actor**. A PAT belonging to a *non-admin* account (a machine user invited as a plain **write** collaborator). **Scope `repo` only — never `workflow`**: the `workflow` scope would let the agent push `.github/workflows/<anything>.yml` onto its own branch, and a workflow on a same-repo branch is handed the repository secrets, so the merge actor's admin PAT would leave the repo without anything being merged (ADR-021 r1 MF-2). Dropping it costs nothing: workflow changes go through a human-merged `factory:harness` PR, and the sweeper's `gh workflow run` (Actions dispatch) needs `repo`, not `workflow`. Every agent stage uses this token: checkout, comments, labels, lock branches, PR creation, pushing `claude/*` and `factory/*` branches.
- `FACTORY_MERGE_TOKEN` — the **merge actor**. An admin/owner PAT (scope `repo`) belonging to a *different* account. Store it as an **environment** secret, not a repository secret: `gh secret set FACTORY_MERGE_TOKEN --env factory-merge` (`factory bootstrap` creates the `factory-merge` environment, whose deployment branch policy is the default branch only, and the merge job declares `environment: factory-merge`). A repository secret is readable by a workflow running on ANY same-repo branch — that is the hole the environment closes. It appears only in script-only jobs (the merge stage, which never starts `claude`, and that job's credential-scrub step) — never in a checkout token or an agent step. A lint rule (`merge-token-scope`) enforces that across every file in `.github/workflows/`.
- `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) — the model credential.

With both actor tokens set, `factory bootstrap` requires **1 approving review from a code owner** on the base branch (`require_code_owner_reviews`) and writes `.github/CODEOWNERS` naming the merge actor — commit and push it, GitHub reads CODEOWNERS from the base branch. Counting approvals alone was not enough: a write collaborator can approve any PR it did not author, so the identity of the approver has to be part of the rule (ADR-021 r1 MF-1). With it, no PR is mergeable with the agent's token — the one it authored because GitHub refuses self-approval, any other because the approval must come from the merge actor. The merge stage approves as the merge actor and then merges. The sweeper runs `factory doctor`'s merge-authority checks under the bot token every 30 minutes, so `tokens.agent-is-admin`, `tokens.agent-workflow-scope` and `protection.codeowners` get real grades (they read WARN "unverified until CI" locally). With only `FACTORY_BOT_TOKEN` (single-actor mode — e.g. a private repo on GitHub Free, where branch protection is unavailable at all), everything still works but merge power stays reachable from agent stages and hooks are the only layer: `factory doctor` says so with a `tokens.single-actor` WARN on every run.
- `factory run <stage> <issue>` — run a stage locally with the exact scripts CI uses
- `factory run <stage> <issue> --remote` — dispatch the same stage as a GitHub Actions workflow run instead of running it locally (also restarts a stalled/blocked stage; `merge` accepted)
- `factory run retro [--force]` — run the merge-triggered retro job (light deterministic harvest every merge; full analysis + dark lessons/examples PR, human-approved proposal PR, or `--force` to skip the merge-count threshold)
- `factory status` — Needs You / queue / in progress / recent merges / usage (read-only)
- **Live progress in the heartbeat comment (ADR-022)** — a running stage edits one issue comment every 2 minutes with the current step, every agent's status and last tool, and tokens/cost so far, plus a machine-readable `<!-- factory-progress:v1 {…} -->` marker that also lands in `docs/factory/runs/<n>.md` when the run ends. It is read off the session transcripts the agents already write, never from tool *results* — so no file content or secret can ride out on a public comment.
- `factory board` — the viewer for all of that, across repositories. See below.

### factory board

```bash
npx know-thy-build factory board                                   # the current repo, http://127.0.0.1:4173
npx know-thy-build factory board --repo owner/a --repo owner/b     # several repos in one board
npx know-thy-build factory board --port 8080 --interval 30         # bind elsewhere / poll faster
npx know-thy-build factory board --once --json | jq .issues        # one snapshot for a script
```

A local, read-only viewer of every issue the factory is carrying (ADR-022 Task B). Three views:

- **레인 보드 (lanes)** — a column per state in graph order (queue · ready · planned · in-progress · awaiting-review · approved · merged) with side lanes for needs-human / blocked / needs-info. Each card carries the stage, the elapsed time in that state, a freshness dot (heartbeat fresh < 5 min · stale < 30 · dead — the same 30 minutes the sweeper calls stale), the **current step**, a mini agent table (`label · status · last tool · in/out tokens`), cost so far, a link to the Actions run, and the last handoff one-liner. Several issues running at once are several cards; several repos put a repo chip on each card and a repo filter in the header.
- **타임라인 (timeline)** — one row per issue, x axis 6h / 24h / 7d, one bar per stage coloured by state. Retries show as a second bar in the same state with the blocked gap between them; hover gives the exact durations.
- **상세 패널 (detail)** — click a card for the full transition list with per-state durations, every agent with tokens and cost, the files touched, and the links.

**Where the data comes from.** Nothing new is written: state is the label, "since when" is the transition comment, "is it alive" is the heartbeat's first line, "what is it doing" is that comment's `factory-progress:v1` marker, "how much" is the `usage:` lines on the `factory/records` branch, and "which job" is `gh run list`. **Every GitHub call goes through your own `gh` CLI** — the board never reads, stores or prints a token, which is why private repos just work.

**Two ways to open the page.** `docs/factory/board/index.html` is installed by `factory init` and is the very file the CLI serves — no build step, no CDN, no external request at all.

| | CLI mode (`factory board`) | Static mode (file / GitHub Pages) |
|---|---|---|
| data | `/api/board` + SSE push on change | `api.github.com` direct, `?repo=owner/name` |
| auth | your local `gh` (private repos work) | unauthenticated (60 req/h, remaining quota shown) or a personal token kept in `localStorage` only |
| cost | finished runs (records branch) + live run | live run only — the chip says `live` |

The reduced static model is deliberate: implementing the same cost sum twice is how "live $0.41 / final $0.38" happens (ADR-022 decision 5). The page's header help says all of this in the UI.

Design and rationale: [`docs/superpowers/specs/2026-09-10-factory-design.md`](docs/superpowers/specs/2026-09-10-factory-design.md) · decisions: [`docs/factory/DECISIONS.md`](docs/factory/DECISIONS.md)

---

## Roles

### Project — What & Why

```
/know-thy-build:project
```

Socratic conversation that explores: Problem, Persona, Competitive Landscape, Vision, Output, User Journey, Boundaries, Success, Risks, Principles.

Also generates a **Development Workflow** in `CLAUDE.md` — the orchestrator model that enforces multi-agent review for all implementation.

Result: `docs/PROJECT.md`

### Technical — How

```
/know-thy-build:technical
```

Requires `docs/PROJECT.md`. Explores: Tech Stack (with structured comparison research), Architecture (with Component Responsibility Map), Data, Interfaces, Testing Strategy, Error & Resilience, Constraints.

Every significant decision is recorded as a **Technical Decision Record (TDR)** — context, options, decision, rationale, consequences, validation method. Includes a **Technical Adversarial Review** (Minimalist, Operator, Future Developer) and **Risk-First Validation**.

Result: `docs/TECHNICAL.md`

### Feature — Specific Work

```
/know-thy-build:feature
```

References both `docs/PROJECT.md` and `docs/TECHNICAL.md`. 3-pass exploration:

- **Pass 1**: Problem → Value → User Stories → Solution → Scope
- **Pass 2**: Acceptance Criteria (Given-When-Then → AC → edge cases → verification)
- **Pass 3** (UI features): Design Intent Map (action → outcome → decision → QA verification)

Result: `docs/features/NNN.md`

### QA — Test the Product

```
/know-thy-build:qa
```

Produces and maintains `docs/QA.md` — the single source of truth for all testing.

**Three modes:**

| Mode | When | What |
|------|------|------|
| **SETUP** | After `:technical` | Build QA framework: environment, tools, behavioral axes, test profiles, failure injection methods |
| **REVIEW** | After each `:feature` | Define executable test cases per feature — this IS the definition of "done" |
| **TEST** | After implementation | Actually run the product, execute test cases, capture evidence |

**Research-grounded approach** (PersonaTester FSE 2026, τ-bench CMU 2026, VISTA 2026):

- **Behavioral Testing Axes** instead of character personas — orthogonal axes (Mindset × Strategy × Habit × Cooperation) combined into test profiles
- **Turn-level behavior instructions** instead of narrative descriptions — "3초 안에 반응 없으면 새로고침하라" not "act like an impatient user"
- **Failure State Injection** — network failure, resource deletion, session expiry, concurrent mutation (+42% unique failures vs UI-only, VISTA 2026)
- **QA Self-Check** — metrics to prevent "easy mode" (scenario diversity, unique failures, cooperation drift)
- **Insight Synthesis** — patterns, failure taxonomy, actionable recommendations (not just pass/fail)

Result: `docs/QA.md`

### Designer — User Experience (Deep Dive)

```
/know-thy-build:designer
```

Optional. For features with complex UI that need deeper analysis than the feature's Pass 3 Design Intent.

Produces a **Design Intent Map** — every user action traced to the design decision that enables it. Includes flow decomposition, state catalog, visual direction, prototyping, Nielsen heuristic evaluation, accessibility audit, cognitive walkthrough.

**Anti-Slop Protocol** — explicit list of AI-generated design clichés to avoid.

Result: `## Design` section in the feature spec + prototype artifact(s)

### Architect — Implementation Design

```
/know-thy-build:architect
```

Optional. For Architectural features (new subsystem, multi-component, structural change). Uses **Program Sketching** — creates code scaffolds with Design by Contract comments (PRE/POST/WHY/EXAMPLE) and signature tests, then orchestrates agents.

Includes CRC Cards, Adversarial Review (Minimalist/Implementer/Skeptic), Over-Specification Prevention, Hardest-First Vertical Slice.

Result: Code stubs + test suites + `## Architecture Notes` in feature spec

---

## Multi-Agent Development Workflow

When you run `/know-thy-build:project`, it generates a **Development Workflow** in your `CLAUDE.md`. This workflow enforces:

```
User Session (Orchestrator only — never implements directly)
│
├── Dispatches Implementation Agent
│   ├── Pre-work: reads PROJECT.md, TECHNICAL.md, feature spec, QA.md
│   ├── Implements within defined scope
│   │
│   └── Post-implementation Review Loop
│       ├── Designer Review Agent (Design Intent verification)
│       ├── Architect Review Agent (code quality, patterns, structure)
│       │   └── Both must pass before QA begins
│       └── QA Review Agent (runs the product, executes test cases)
│           └── All test cases must be ✅ with evidence
│
└── Loop until all reviewers pass → Feature complete
```

## Documents Produced

| Document | Created by | Purpose |
|----------|-----------|---------|
| `docs/PROJECT.md` | `:project` | Project identity, persona, vision, principles |
| `docs/TECHNICAL.md` | `:technical` | Tech stack, architecture, TDRs, testing strategy |
| `docs/QA.md` | `:qa` | Test environment, behavioral axes, test cases, results |
| `docs/features/NNN.md` | `:feature` + `:designer` + `:architect` | Feature spec, design intent, architecture notes |
| `CLAUDE.md` | `:project` | Project compass + development workflow |
| Code stubs + tests | `:architect` | Implementation scaffolds |

## Evolution

All documents support evolution. Run the same command again on a completed document:

| Command | On complete document | Effect |
|---------|---------------------|--------|
| `:project` | `docs/PROJECT.md` | Evolve mode — what changed and why |
| `:technical` | `docs/TECHNICAL.md` | Evolve mode — update TDRs, re-run adversarial review |
| `:feature` | `docs/features/NNN.md` | Edit by number |
| `:qa` | `docs/QA.md` | Re-test after changes, regression check |
| `:designer` | `## Design` section | Update design, re-verify |

Changes are tracked with reasoning in a changelog — not just *what* changed, but *why*.

### Migration from v0.3.x

If you have existing `PROJECT.md`, `TECHNICAL.md`, or `features/` at your project root, they will be automatically moved to `docs/` the next time you run any `/know-thy-build:*` command. References in `CLAUDE.md` are updated automatically.

## Session resilience

All conversations track state in document frontmatter. If a session breaks, run the same command again — it picks up where you left off.

| `status` | What it means |
|-----------|---------------|
| `drafting` | In progress — will resume |
| `complete` | Done — running again enters evolve mode |
| `evolving` | Evolve in progress — will resume |

## Install options

```bash
npx know-thy-build              # Install in current project
npx know-thy-build --global     # Install to ~/.claude/commands/ (all projects)
npx know-thy-build --lang ko    # Skip language prompt (Korean)
```

Supported shortcuts: `en`, `ko`, `ja`, `zh`, `es`, `fr`, `de`, `pt` — or pass any language name directly.

All conversation and generated documents use the chosen language. Technical terms stay in English.

## Foundations

know-thy-build draws on established techniques from philosophy, software engineering, and AI research.

### Socratic Prompting

The tool applies the [Socratic method](https://en.wikipedia.org/wiki/Socratic_method) — questioning to surface latent knowledge. In Plato's *Meno*, Socrates demonstrates that learning is **recollection**: the right questions draw out what the learner already knows. know-thy-build operates on the same premise — you already know what you want to build, you just haven't articulated it yet.

- Chang, ["Prompting Large Language Models With the Socratic Method"](https://arxiv.org/abs/2303.08769) (2023)
- Princeton NLP, ["The Socratic Method for Self-Discovery in Large Language Models"](https://princeton-nlp.github.io/SocraticAI/)
- [SocraticLM](https://proceedings.neurips.cc/paper_files/paper/2024/hash/9bae399d1f34b8650351c1bd3692aeae-Abstract-Conference.html) (NeurIPS 2024 Spotlight)

### Dialectical Reasoning

Each exchange follows a thesis-antithesis-synthesis cycle. This is [Hegelian dialectic](https://en.wikipedia.org/wiki/Dialectic#Hegelian_dialectic) applied to project definition.

- ["Self-reflecting LLMs: A Hegelian Dialectical Approach"](https://arxiv.org/abs/2501.14917) (2025)

### Requirements Elicitation

[Requirements elicitation](https://en.wikipedia.org/wiki/Requirements_elicitation) is the process of discovering what stakeholders actually need — requirements are *discovered*, not merely captured.

- Zave & Jackson, "Four Dark Corners of Requirements Engineering" (1997, ACM TOSEM)
- ["AI-based Multiagent Approach for Requirements Elicitation and Analysis"](https://arxiv.org/abs/2409.00038) (2024)

### Behavioral Testing Research

The QA framework is grounded in 2026 research on AI agent-based testing:

- [PersonaTester](https://arxiv.org/abs/2603.24160) (FSE 2026) — orthogonal behavioral axes for test persona definition
- [Mind the Sim2Real Gap](https://arxiv.org/abs/2603.11245) (CMU 2026) — LLM simulators inflate success rates vs human baselines
- [VISTA](https://arxiv.org/abs/2606.11079) (2026) — QA quality self-measurement, failure state injection (+42%)
- [NCUser](https://arxiv.org/abs/2509.23124) (ICLR 2026) — non-cooperative user axes
- [Persona Policies](https://arxiv.org/abs/2605.12894) (UW 2026) — turn-level behavior instructions outperform character descriptions
- [CANDOR](https://arxiv.org/abs/2506.02943) (TOSEM 2026) — role separation: oracle accuracy requires requirement understanding

### Multi-Agent Debate

know-thy-build adopts multiple perspectives through specialized roles (project, technical, feature, designer, QA, architect) — each with its own adversarial review protocol.

- Liang et al., ["Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate"](https://arxiv.org/abs/2305.19118) (EMNLP 2024)

### Design Thinking

The output maps to the **Define** phase of [Design Thinking](https://web.stanford.edu/~mshanks/MichaelShanks/files/509554.pdf) (Stanford d.school).

## License

MIT
