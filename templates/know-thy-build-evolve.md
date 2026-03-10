---
description: Revisit and evolve your PROJECT.md. Use when the project's direction has shifted, assumptions proved wrong, principles need updating, or scope has changed. Run this periodically or at major turning points.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Evolve

Projects change. The question is whether your compass changes with them, or quietly becomes fiction.

This command revisits your PROJECT.md — not to check boxes, but to reflect on what you assumed, what actually happened, and what you've learned.

## Language

**All conversation and document updates MUST be in: {{LANG}}**

Technical terms (e.g. CLI, API, NON-NEGOTIABLE) stay in English. Everything else — questions, summaries, output prose — uses the specified language.

## How You Operate

- Read the existing PROJECT.md first. This is the baseline.
- One question at a time. Same Socratic discipline as init.
- Don't accept "it's fine" at face value. Probe gently.
- The user may not know what changed. Help them discover it.
- **Iterative deepening**: Each question builds on the previous answer. Follow the thread N times until you reach the root, not just once. When the user says something interesting, ask about THAT, not the next item on a list.
- The reasoning behind a change matters more than the change itself.
- **Save progress as you go.** At each checkpoint, update PROJECT.md frontmatter so the session can be resumed if interrupted.

---

## Before You Begin

Read the current state:

```bash
cat PROJECT.md 2>/dev/null
cat CLAUDE.md 2>/dev/null
```

If `PROJECT.md` doesn't exist → tell the user to run `/know-thy-build` first. Stop.

**If PROJECT.md has `status: drafting`:**
The init process was never completed. Tell the user:
> "PROJECT.md is still in draft from a previous session. Run `/know-thy-build` to finish it first."
→ Stop here.

**If PROJECT.md has `status: evolving`:**
A previous evolve session was interrupted. Read the frontmatter to find `evolveProgress` and resume:
> "We started an evolve session before. Here's where we left off: [summary of what was reviewed]. Shall we continue?"

**If PROJECT.md has `status: complete`:**
Present the current definition warmly:

> "Here's what your project was defined as:"
>
> [Present the key identity from PROJECT.md — the one-liner, problem, vision, deliverable, core principles. Keep it concise but complete enough to jog memory.]
>
> "Looking at this now — does it still feel right? Or does something feel off?"

This is deliberately soft. Let the user react naturally. Their response tells you where to go.

**If the user confirms it still feels right:**

> "Good — that's a meaningful signal too. Your compass held up."
> "If something shifts in the future, you can run `/know-thy-build-evolve` again."

→ **Stop here.** Do not push further. A confirmed compass is a valid outcome.

**If the user expresses any doubt, discomfort, or points to something specific** → proceed to STEP 1.

---

## STEP 1: What wants to change?

> **Goal**: Understand what the user feels has shifted, starting from their intuition.
> **Gate**: At least one area of change is identified with enough depth to trace its origin.

### Flow

**Start from the user's response.** Don't impose a structure yet.

**If the user points to something specific:**
Follow that thread. Ask about it, not something else.

**If the user says "mostly fine" or "I'm not sure":**
Gently surface the assumptions baked into PROJECT.md:

> "Your PROJECT.md assumed a few things:"
>
> [Extract 3-4 key assumptions from the actual PROJECT.md content, e.g.:]
> - That {{problem_root}} is the core problem
> - That {{who_suffers}} would use it as {{user_journey}}
> - That {{mvp_criteria}} would be enough for v1.0
>
> "Have any of these played out differently than expected?"

**If the user says "a lot has changed":**
Don't try to cover everything. Ask:

> "What's the biggest thing that changed?"

Then follow THAT thread deeply before moving to the next.

### Iterative deepening

For each change the user raises, don't move on after one exchange. Follow the thread:

1. **What changed?** — "What's different from what was written?"
2. **What happened?** — "What did you experience that showed this?"
3. **Why?** — "Why do you think it turned out that way?"
4. **What was the original assumption?** — "Looking back, what were you assuming that turned out wrong?"
5. **What do you know now?** — "If you were writing this section today, what would you say instead?"

Not every change needs all 5. Use judgment. But always go at least to "why" before moving on.

### Checkpoint

Save progress to PROJECT.md frontmatter:
```yaml
status: evolving
evolveProgress: changes-identified
```

After exploring enough changes (the user will signal when they're done, or the conversation will naturally slow):

> "Here's what we've found:"
>
> **Changes:**
> - {{what}}: was {{old}} → now {{new}}
>   - Because: {{root_reason}}
>   - Original assumption: {{what_was_assumed}}
>
> **Still holds:**
> - {{what remains true}}
>
> "Does this capture it? Anything missing?"

Confirmed → STEP 2.

---

## STEP 2: Principles — tested by reality

> **Goal**: Confront each principle against what actually happened.
> **Gate**: Principles reviewed and updated.

### Flow

Present the current principles from PROJECT.md:

> "Let's look at the principles you set. Were they tested? Did they hold?"

For each principle, one at a time:

> "[Principle name]: [rule]"
> "Did you actually follow this? Were there moments where it was hard?"

Then follow the thread based on the answer:

**If kept:**
→ "Did it prove its value? Was there a moment where you were glad this rule existed?"
→ "Has your understanding of WHY this matters deepened?"

**If broken:**
→ "What happened? What forced you to break it?"
→ "Was the principle wrong, or was the situation exceptional?"
→ "Should we change the principle, or keep it and learn from the exception?"

**If untested:**
→ "This hasn't been challenged yet. Do you still believe it? Or was it aspirational?"

**Classification update:**
- NON-NEGOTIABLE that was broken → should it become a GUIDELINE, or be reinforced?
- GUIDELINE that proved critical → promote to NON-NEGOTIABLE?
- Principle that no longer applies → remove with clear reasoning.

**New principles:**
> "Did you learn any new rules from doing the work? Things you'd tell yourself on day 1 if you could go back?"

### Checkpoint

> **Kept:** (unchanged)
> - ...
> **Updated:** (rewording or level change)
> - {{principle}}: {{change}} — because {{reason}}
> **Removed:**
> - {{principle}} — because {{reason}}
> **New:**
> - {{principle}} — learned from {{experience}}

Confirmed → STEP 3.

---

## STEP 3: Insights — what did you learn?

> **Goal**: Capture the meta-learning from this evolution — not just what changed, but what the change teaches.
> **Gate**: At least 1-2 insights articulated.

### Flow

> "Before we update the document — stepping back from the details: what did you learn from this experience?"

Possible prompts if the user needs help:

> "What surprised you most about how this project unfolded?"

> "If you were starting a similar project tomorrow, what would you do differently from the start?"

> "Is there a pattern here — something about how you plan vs how things actually go?"

These insights get recorded in the changelog as lessons learned.

→ `{{insights}}`

---

## STEP 4: Synthesis — Update PROJECT.md

> **Gate**: User confirms the final changes before writing.

### Pre-update

Present a complete summary:

> "Here's what will change in PROJECT.md:"
>
> **Sections being updated:**
> - {{section}}: {{before}} → {{after}}
>
> **Principles:**
> - {{changes_summary}}
>
> **Sections unchanged:**
> - {{list}}
>
> "Ready to update?"

### Apply changes

Use the Edit tool. Preserve the structure and voice of the original. Only modify what changed.

**Update frontmatter:**
```yaml
---
status: complete          # back to complete after evolve
version: {{new_version}}
date: {{date}}
lastEvolve: {{date}}
---
```

**Version increment:**
- Refinements → minor bump (1.0.0 → 1.1.0)
- Fundamental shift in problem or vision → major bump (1.0.0 → 2.0.0)

**Append changelog:**

```markdown
## Changelog

### v{{version}} — {{date}}

**What changed:**
- {{section}}: {{change_summary}}

**Why:**
- {{assumption_or_reason}}: {{what_was_assumed}} → {{what_actually_happened}}

**Principles:**
- {{kept|updated|removed|new}}: {{principle_name}} — {{reason}}

**Insights:**
- {{insight}}
```

### Closing

> "PROJECT.md has been updated."
> "The changelog records not just what changed, but why — so you can look back at this decision later."
> "Run `/know-thy-build-evolve` again whenever the project's direction shifts."
