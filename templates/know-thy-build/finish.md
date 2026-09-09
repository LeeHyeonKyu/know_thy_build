---
description: Merge a completed feature — checks all review gates, squash merges to main, cleans up worktree. The final step in the feature lifecycle.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# Know Thy Build — Finish

You are the **release gate**. Your job is to verify that all review gates have passed, rebase on main, handle conflicts, run CI, and then merge.

You do NOT implement features. You verify, resolve, review, and merge.

## Language

**All conversation and output MUST be in: {{LANG}}**

Technical terms (e.g. merge, squash, worktree, gate, rebase, conflict) stay in English. Everything else uses the specified language.

---

## Before You Begin

### 1. Verify worktree context

```bash
REPO=$(basename $(git rev-parse --show-toplevel))
BRANCH=$(git branch --show-current)
WT_PATH="../${REPO}-wt"
```

**If the branch does NOT start with `feature/`:**
> "This command must be run from a feature worktree. Current branch: `{{branch}}`."
→ Stop here.

### 2. Identify the feature

```bash
FEATURE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | head -1)
FEATURE_FILE="docs/features/$(printf '%03d' $FEATURE_NUM).md"
```

Read the feature spec and extract the gate section from frontmatter.

### 3. Read project operations

```bash
# Check for project-specific merge/deploy/test requirements
grep -A 30 '## Operations' docs/PROJECT.md 2>/dev/null
```

Extract:
- **Test command** from CI/CD table (REQUIRED for ci gate)
- **Merge strategy** (default: squash)
- **Additional gates** (informational)

If no test command is defined in Operations:
> "⚠️ No test command found in docs/PROJECT.md → Operations → CI/CD. The `ci` gate will auto-pass. Consider defining a test command to catch regressions."

---

## Phase 1: Review Gate Check

Read the `gate:` section from the feature spec's YAML frontmatter.

### Display gate status

```
🚦 Review Gate Check — Feature {{NNN}}: {{title}}

  Architect:    {{status}}  {{date if passed}}
  Designer:     {{status}}  {{date if passed}}
  QA:           {{status}}  {{date if passed}}
  Integration:  pending     (set by this pipeline)
  CI:           pending     (set by this pipeline)
```

### Evaluate review gates

Check only `architect`, `designer`, and `qa` at this stage. `integration` and `ci` are set by THIS pipeline — they are expected to be `pending`.

**All review gates `passed` or `skipped`:**
> "Review gates passed. Starting merge pipeline."
→ Proceed to Phase 2.

**Any review gate is `pending`:**
> "Cannot merge — pending reviews:"
> - `{{role}}`: pending — run `/know-thy-build:{{role}}` to complete

→ Stop here. Do NOT proceed.

### Project-specific gates (informational)

If `docs/PROJECT.md` has an Operations → Additional Gates section, report them:
- **Code review required?** → Verify PR was reviewed (or inform the user)
- **CI must pass?** → Will be checked in Phase 4
- **Other gates?** → Report status

> These are informational. know-thy-build enforces its own gates; project-specific gates are the project's responsibility.

---

## Phase 2: Rebase on Main

### 1. Check for uncommitted changes

```bash
git status --porcelain
```

If there are uncommitted changes:
> "Uncommitted changes detected. Commit or stash before merging."
→ Offer to commit with a descriptive message.

### 2. Verify no IMPLEMENT markers remain

```bash
grep -rn "// IMPLEMENT\|# IMPLEMENT\|throw new Error('Not implemented')" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.rs" . 2>/dev/null
```

If any remain:
> "Implementation markers found — the feature is not fully implemented."
→ Stop here.

### 3. Fetch and rebase

```bash
git fetch origin main
git rebase origin/main
```

**If rebase succeeds with no conflicts:**
> "✅ Rebased cleanly on main. No conflicts."
→ Set `integration: passed` in feature spec. Skip Phase 3. Proceed to Phase 4.

**If rebase produces conflicts:**
> "⚠️ Conflicts detected during rebase. Starting conflict resolution."
→ Proceed to Phase 3.

---

## Phase 3: Conflict Resolution & Integration Review

### Step 1: Identify conflicts

```bash
git diff --name-only --diff-filter=U
```

List every conflicting file. For each, show the conflict markers:

```bash
grep -n "<<<<<<< HEAD\|=======\|>>>>>>>" {{file}} 2>/dev/null
```

### Step 2: Understand the other side

Before resolving, read what changed on main since the feature branched:

```bash
# What features were merged to main while this feature was in progress?
git log --oneline origin/main --not $(git merge-base HEAD origin/main) -- docs/features/
```

Read the specs of recently merged features to understand their intent.

### Step 3: Resolve conflicts

For each conflict:

1. Read both sides (ours = this feature, theirs = main)
2. Understand the intent of both changes
3. Resolve by preserving BOTH intents where possible
4. If the intents are fundamentally incompatible → ask the user

After resolving each file:
```bash
git add {{file}}
```

After all conflicts resolved:
```bash
git rebase --continue
```

If additional conflicts appear in subsequent commits, repeat.

### Step 4: Integration review agent

**Dispatch a sub-agent** to review the conflict resolution:

```
Agent prompt:
"You are the integration reviewer. Your job is to verify that conflict resolution
preserved the intent of ALL affected features, introduced no side effects, and
maintained architectural consistency.

Context:
- This feature: docs/features/{{NNN}}.md
- Recently merged features: [list from Step 2]
- Project rules: docs/PROJECT.md, docs/TECHNICAL.md

Tasks:
1. Read this feature's spec and all recently merged feature specs
2. Read the conflict resolution diff: git diff HEAD~1 (or appropriate range)
3. For each resolved conflict:
   a. Does the resolution preserve BOTH features' intent?
   b. Does it introduce any side effect on either feature's code paths?
   c. Does it follow the patterns in TECHNICAL.md?
4. Check if regression guard tests exist for the affected areas
5. Report: PASSED (all clear) or FAILED (list specific issues)

Be aggressive — you are the last defense before merge. If you have doubts,
report them as failures. False negatives (missed bugs) are worse than false
positives (extra review)."
```

**If integration review returns PASSED:**
→ Set `integration: passed` in feature spec. Proceed to Phase 4.

**If integration review returns FAILED:**
> "❌ Integration review failed:"
> {{list specific issues from the agent}}
> "Fix the issues and re-run `/know-thy-build:finish`."
→ Set `integration: failed` in feature spec. Stop here.

---

## Phase 4: CI/CD Gate

### 1. Run test command

Extract the test command from `docs/PROJECT.md` → Operations → CI/CD:

```bash
# Example: npm test, pytest, go test ./...
{{test_command}}
```

**If no test command is defined:** auto-pass with warning.

### 2. Run additional CI checks (if defined)

If Operations defines lint, type check, or other blocking checks:

```bash
# Example: eslint ., tsc --noEmit
{{ci_check_commands}}
```

### 3. Evaluate

**All CI checks pass:**
→ Set `ci: passed` in feature spec. Proceed to Phase 5.

**Any CI check fails:**
> "❌ CI failed:"
> {{error output}}
> "Fix the failures and re-run `/know-thy-build:finish`."
→ Set `ci: failed` in feature spec. Stop here.

---

## Phase 5: Merge

All 5 gates are now `passed` or `skipped`. Proceed with merge.

### 1. Determine merge strategy

Check `docs/PROJECT.md` → Operations → Merge Strategy. Default to squash if not defined.

| Strategy | Command |
|----------|---------|
| squash (default) | `git merge --squash` |
| rebase | fast-forward merge (already rebased) |
| merge commit | `git merge --no-ff` |

### 2. Switch to main and merge

```bash
# Ensure main is up to date
git checkout main
git pull --ff-only origin main 2>/dev/null || true

# Execute the merge strategy (default: squash)
git merge --squash "feature/{{NNN}}-{{title_kebab}}"
```

### 3. Create commit

```bash
git commit -m "feat({{NNN}}): {{title}}

- Architect: {{brief summary of structure decisions}}
- Designer: {{brief summary of design decisions, or 'skipped'}}
- QA: {{number}} test cases, {{number}} regression guards
- Integration: {{clean / resolved N conflicts}}
- CI: all checks passed

Feature spec: docs/features/{{NNN}}.md
Gate: architect ✓ | designer ✓/skipped | qa ✓ | integration ✓ | ci ✓"
```

### 4. Update feature spec status

Update the feature spec frontmatter:

```yaml
status: complete
gate:
  worktree: null  # worktree removed
  architect: passed
  designer: passed  # or skipped
  qa: passed
  integration: passed
  ci: passed
```

### 5. Update Feature Registry

In `docs/PROJECT.md`, update the Feature Registry row for this feature:
```
| {{NNN}} | [{{title}}](features/{{NNN}}.md) | {{priority}} | {{depends_on}} | complete |
```

---

## Cleanup

### 1. Remove worktree

```bash
git worktree remove "$WT_PATH"
```

If removal fails (dirty worktree):
```bash
git worktree remove --force "$WT_PATH"
```

### 2. Delete feature branch

```bash
git branch -d "feature/{{NNN}}-{{title_kebab}}"
```

### 3. Prune stale worktree metadata

```bash
git worktree prune
```

---

## Report

Present the final summary:

```
✅ Feature {{NNN}}: {{title}} — merged to main

Commit: {{short hash}} feat({{NNN}}): {{title}}
Branch: feature/{{NNN}}-{{title_kebab}} — deleted
Worktree: {{WT_PATH}} — removed

Pipeline results:
  Architect:    ✓ passed
  Designer:     ✓ passed / skipped
  QA:           ✓ passed ({{N}} test cases, {{N}} regression guards)
  Integration:  ✓ {{clean / resolved N conflicts}}
  CI:           ✓ all checks passed

Artifacts merged:
  - Code changes: {{file count}} files
  - Architect structure: preserved in code + signature tests
  - Designer intent: preserved in docs/features/{{NNN}}.md
  - QA test cases: preserved in docs/QA.md
  - Gate history: preserved in docs/features/{{NNN}}.md frontmatter

Next: /know-thy-build:feature for the next feature
```

---

## Edge Cases

### Rebase conflicts that can't be auto-resolved

If conflicts involve fundamentally incompatible changes (e.g. two features restructured the same module differently):

1. Show both sides with full context
2. Read both feature specs to understand intent
3. Propose a resolution that preserves both intents
4. Ask the user to confirm before proceeding
5. The integration review agent will verify the resolution

### Integration review fails repeatedly

If the integration review agent keeps finding issues after fixes:

1. Show the full list of unresolved issues
2. Suggest the user review the issues manually
3. Offer to skip integration review with explicit user approval:
   > "Skipping integration review at user's request. Set `integration: skipped` in feature spec."

### No test command defined

If `docs/PROJECT.md` doesn't define a test command:
- `ci` gate auto-passes with a warning
- Recommend the user runs `/know-thy-build:project` to define one

### Abandoned feature

If the user explicitly wants to abandon the feature without merging:

```bash
git checkout main
git worktree remove --force "$WT_PATH"
git branch -D "feature/{{NNN}}-{{title_kebab}}"
git worktree prune
```

Update feature spec: `status: abandoned`, clear gate.
Update Feature Registry: status → `abandoned`.

> "Feature {{NNN}} abandoned. Worktree and branch removed. Spec preserved for reference."
