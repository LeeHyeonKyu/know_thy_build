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

Pick a language, and six commands are installed into your `.claude/commands/`:

| Command | Role | Output |
|---------|------|--------|
| `/know-thy-build:project` | Define what and why | `docs/PROJECT.md` |
| `/know-thy-build:technical` | Define how to build | `docs/TECHNICAL.md` |
| `/know-thy-build:feature` | Design a specific feature | `docs/features/NNN.md` |
| `/know-thy-build:qa` | Build QA framework + test | `docs/QA.md` |
| `/know-thy-build:designer` | UX deep dive | `## Design` in feature spec |
| `/know-thy-build:architect` | Implementation design | Code stubs + tests |

## The pipeline

```
Define:     :project → :technical → :qa setup
Per feature: :feature → :qa review → [:designer] → implement → [:architect] → QA test → ship
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
/know-thy-build:qa           Define test cases for this feature (what "done" means)
/know-thy-build:designer     [optional] Deep UX analysis (heuristics, prototyping, accessibility)
implement                    Build the feature
/know-thy-build:architect    [optional] Code design for complex features (stubs, tests, sub-agents)
/know-thy-build:qa           Test the running product against QA.md test cases
```

A feature is complete ONLY when all its test cases in `docs/QA.md` pass with evidence.

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

Optional. For Architectural features (new subsystem, multi-component, structural change). Uses **Program Sketching** — creates code scaffolds with Design by Contract comments (PRE/POST/WHY/EXAMPLE) and signature tests, then orchestrates sub-agents.

Includes CRC Cards, Adversarial Review (Minimalist/Implementer/Skeptic), Over-Specification Prevention, Hardest-First Vertical Slice.

Result: Code stubs + test suites + `## Architecture Notes` in feature spec

---

## Multi-Agent Development Workflow

When you run `/know-thy-build:project`, it generates a **Development Workflow** in your `CLAUDE.md`. This workflow enforces:

```
User Session (Orchestrator only — never implements directly)
│
├── Dispatches Implementation Sub-Agent
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
