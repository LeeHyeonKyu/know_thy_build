# know-thy-build

Before you write a single line of code, know what you're building, why, and how.

**know-thy-build** is a Socratic questioning tool for [Claude Code](https://claude.ai/claude-code). Through conversation — not forms — it helps you define your project across three layers: what problem you're solving (Project), how you'll build it technically (Technical), and what each feature looks like (Feature). The result is a set of living documents that you and your AI agents reference throughout the project's life.

## Why

We jump into code too fast. A new project starts, and within minutes we're picking frameworks, creating files, writing functions — before we've truly asked ourselves what we're building and why.

The cost of skipping this step is real. Vague goals lead to wasted effort. Undefined boundaries lead to scope creep. Unspoken assumptions lead to wrong decisions — by you or by AI agents working on your behalf.

know-thy-build exists to help you **think your project through before you build it**. It asks the questions you should be asking yourself — one at a time, each answer challenged and deepened — until you have genuine clarity.

That clarity doesn't stay in your head. It becomes structured documents that AI agents reference — so every agent working on your project reads the same definition, follows the same principles, and builds on the same technical foundation.

## Quick start

```bash
npx know-thy-build
```

Pick a language, and three commands are installed into your `.claude/commands/`:

| Command | Purpose | Output |
|---------|---------|--------|
| `/know-thy-build:project` | Define what you're building and why | `PROJECT.md` |
| `/know-thy-build:technical` | Define how you'll build it | `TECHNICAL.md` |
| `/know-thy-build:feature` | Design a specific feature | `features/NNN.md` |

## The flow

```
:project (What & Why) → :technical (How) → :feature (specific work)
```

Each layer builds on the previous. Technical decisions reference the project definition. Feature specs reference both.

### 1. Project — What & Why

```
/know-thy-build:project
```

A conversation that explores:

- **Problem** — What triggered this? Root cause? Who suffers? Current alternatives?
- **Vision** — What changes when solved? Your approach? Core value?
- **Output** — What does the user concretely receive? Files, commands, formats?
- **Experience & Boundaries** — User journey? Aha moment? What is this NOT?
- **Success** — Measurable metrics? Leading indicators? MVP criteria?
- **Open Questions** — Risks? Unvalidated assumptions? Technical unknowns?
- **Principles** — Non-negotiable rules? AI agent autonomy? Speed vs quality?

Not every area needs equal depth. The conversation follows you, not a script.

Result: `PROJECT.md` — the project's identity and compass.

### 2. Technical — How

```
/know-thy-build:technical
```

Requires `PROJECT.md`. Scans your codebase for existing technical context (package.json, Dockerfile, etc.) and doesn't re-ask what's already visible.

Explores:

- **Tech Stack** — Language, framework, key dependencies — and why each choice
- **Architecture** — Components, interactions, structural pattern
- **Data** — Storage, key entities, formats
- **Interfaces** — CLI commands, API endpoints, input/output contracts
- **Constraints** — Performance, security, deployment, platforms

Depth matches project scale. A CLI tool might only need Stack + Interfaces.

Result: `TECHNICAL.md` — the technical foundation.

### 3. Feature — Specific work

```
/know-thy-build:feature
```

References both `PROJECT.md` and `TECHNICAL.md`. Features are numbered sequentially.

Each feature spec covers:
- **What** — concrete description
- **Why** — motivation, link to project vision
- **Scope** — includes / excludes
- **Done When** — acceptance criteria checklist
- **Approach** — technical notes (optional)

Features are quick — 3-8 exchanges. Create new ones or edit existing ones by number.

Result: `features/001.md`, `features/002.md`, ...

## Evolution

All documents support evolution. Run the same command again on a completed document:

- `/know-thy-build:project` on a complete `PROJECT.md` → evolve mode
- `/know-thy-build:technical` on a complete `TECHNICAL.md` → evolve mode
- `/know-thy-build:feature` → edit existing features by number

Changes are tracked with reasoning in a changelog — not just *what* changed, but *why*.

## Session resilience

All conversations track state in document frontmatter. If a session breaks, run the same command again — it picks up where you left off.

| `status` | What it means |
|-----------|---------------|
| `drafting` | In progress — will resume |
| `complete` | Done — running again enters evolve mode |
| `evolving` | Evolve in progress — will resume |

## Global install

```bash
npx know-thy-build --global    # install to ~/.claude/commands/
```

Commands become available in all projects.

## Language support

```bash
npx know-thy-build              # interactive prompt
npx know-thy-build --lang ko    # Korean
npx know-thy-build --lang ja    # Japanese
npx know-thy-build --lang en    # English (default)
```

Supported shortcuts: `en`, `ko`, `ja`, `zh`, `es`, `fr`, `de`, `pt` — or pass any language name directly.

All conversation and generated documents use the chosen language. Technical terms stay in English.

## License

MIT
