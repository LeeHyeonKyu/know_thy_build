# know-thy-build

Before you write a single line of code, know what you're building and why.

**know-thy-build** is a Socratic questioning tool for [Claude Code](https://claude.ai/claude-code). Through conversation — not forms — it helps you define your project clearly: what problem you're solving, why your approach matters, what the deliverable looks like, and what principles guide the work. The result is a `PROJECT.md` that you and your AI agents can reference throughout the project's life.

## Why

We jump into code too fast. A new project starts, and within minutes we're picking frameworks, creating files, writing functions — before we've truly asked ourselves what we're building and why.

The cost of skipping this step is real. Vague goals lead to wasted effort. Undefined boundaries lead to scope creep. Unspoken assumptions lead to wrong decisions — by you or by AI agents working on your behalf.

know-thy-build exists to help you **think your project through before you build it**. It asks the questions you should be asking yourself: What problem am I really solving? Who is this for? What does success look like? What should this *not* be? The act of answering these questions — one at a time, out loud, with each answer challenged and deepened — is where project clarity comes from.

**The real value is that you now understand what you're building** — because you were asked the right questions and had to find the answers yourself.

And that clarity doesn't stay in your head. know-thy-build structures it into a `PROJECT.md` that AI agents can reference — so the understanding you gained carries over to every agent working on your project. They read the same problem definition, follow the same principles, and respect the same boundaries. Your thinking becomes their compass.

## Quick start

```bash
npx know-thy-build
```

Pick a language, and two commands are installed into your project's `.claude/commands/`:

| Command | Purpose |
|---------|---------|
| `/know-thy-build` | Define your project through guided conversation |
| `/know-thy-build-evolve` | Revisit and evolve the definition as the project grows |

Then, inside Claude Code:

```
/know-thy-build
```

## What happens

A ~10 minute conversation. No forms. No questionnaires. One question at a time, each digging a layer deeper than the last.

The conversation explores four areas — in whatever order feels natural:

- **Problem** — What triggered this? Why is it a problem? What's the root cause? Who suffers? What are they doing today, and why isn't it enough?
- **Vision** — What changes when this is solved? What's your approach? What does the user actually get? What's the core value in one word?
- **Experience & Boundaries** — How does someone use this, end to end? What's the aha moment? What is this NOT? What's the minimum for v1.0?
- **Principles** — What rules must never be broken? How autonomous should AI agents be? Where do you stand on speed vs quality?

Not every area needs equal depth. Some projects need 5 minutes on the problem and 1 on principles. Others are the opposite. The conversation follows you, not a script.

Progress is saved to `PROJECT.md` as you go. If the session breaks, `/know-thy-build` picks up where you left off.

## What you get

A `PROJECT.md` in your project root — only containing what was actually discussed:

```markdown
---
status: complete
version: 1.0.0
---

# my-project

A CLI that does X — solving Y for Z through simplicity.

## Problem
...

## Vision
| Before | After |
|--------|-------|
| Manual, error-prone | Automated, reliable |

## What We Build
| | |
|---|---|
| **Deliverable** | ... |
| **Form** | CLI (because ...) |

## User Journey
...

## Principles
### Test Before Merge (NON-NEGOTIABLE)
...

## Boundaries
**This is NOT:** ...

## Success
**MVP:** ...
**Success Signal:** ...
```

Plus a `CLAUDE.md` reference so AI agents read it before any work:

```markdown
## Project Definition
This project follows the principles defined in PROJECT.md.
AI agents MUST read PROJECT.md before starting any work.
NON-NEGOTIABLE rules in PROJECT.md cannot be overridden.
```

## Evolving

Projects change. What you thought you were building at day 1 is rarely what you're building at day 90.

```
/know-thy-build-evolve
```

This presents your current `PROJECT.md` and asks: does it still feel right?

If yes — done. A confirmed definition is a valid outcome.

If something has shifted, it walks you through:

1. **What changed** — follow the thread from what's different → what happened → why → what was the original assumption → what do you know now
2. **Principles** — did they survive contact with reality? Were they tested? Broken? Did new ones emerge?
3. **Insights** — stepping back: what did you learn from this experience?
4. **Update** — apply changes, bump the version, record everything in a changelog with reasoning

The changelog captures not just *what* changed, but *why* — so you can look back at decisions later:

```markdown
## Changelog

### v1.1.0 — 2026-03-15

**What changed:**
- Problem: was "X" → now "Y"

**Why:**
- Assumed users would Z, but they actually W

**Principles:**
- New: Always validate with real users — learned from shipping v1

**Insights:**
- We overestimated how much structure users wanted
```

## Session resilience

Conversations can break mid-session. know-thy-build tracks state in `PROJECT.md` frontmatter:

| `status` | What it means |
|-----------|---------------|
| `drafting` | Init in progress — `/know-thy-build` will resume |
| `complete` | Definition is set — `/know-thy-build-evolve` is available |
| `evolving` | Evolve in progress — `/know-thy-build-evolve` will resume |

You never lose progress. Pick up where you left off.

## What this project is

know-thy-build helps you define your project well. It uses the Socratic method — asking the right questions in the right order — to draw out what you already know but haven't articulated yet. The result is a clear, concrete project definition that both you and AI agents can follow.

It is **not** a project management framework. No PRDs, epics, stories, or sprint plans. No code scaffolding. No tech stack opinions. Just one thing: helping you think clearly about what you're building, and keeping that definition honest as the project evolves.

## Language support

```bash
npx know-thy-build              # interactive prompt
npx know-thy-build --lang ko    # Korean
npx know-thy-build --lang ja    # Japanese
npx know-thy-build --lang en    # English (default)
```

Supported shortcuts: `en`, `ko`, `ja`, `zh`, `es`, `fr`, `de`, `pt` — or pass any language name directly.

## License

MIT
