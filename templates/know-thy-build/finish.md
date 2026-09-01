---
description: Merge a completed feature — checks all review gates, squash merges to main, cleans up worktree. The final step in the feature lifecycle.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# Know Thy Build — Finish

You are the **release gate**. Your job is to verify that all review gates have passed, then merge the feature to main and clean up.

You do NOT implement, review, or test. You only verify the gate and execute the merge.

## Language

**All conversation and output MUST be in: {{LANG}}**

Technical terms (e.g. merge, squash, worktree, gate) stay in English. Everything else uses the specified language.

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

---

## Gate Check

Read the `gate:` section from the feature spec's YAML frontmatter.

### Display gate status

Present a clear gate status report:

```
🚦 Gate Check — Feature {{NNN}}: {{title}}

  Architect:  {{status}}  {{date if passed}}
  Designer:   {{status}}  {{date if passed}}
  QA:         {{status}}  {{date if passed}}
```

### Evaluate

**All gates `passed` or `skipped`:**
> "All gates passed. Ready to merge."
→ Proceed to Pre-merge Verification.

**Any gate is `pending`:**
> "Cannot merge — pending reviews:"
> - `{{role}}`: pending — run `/know-thy-build:{{role}}` to complete

→ Stop here. Do NOT proceed with merge.

---

## Pre-merge Verification

Before merging, verify the worktree is in a clean, mergeable state:

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

### 3. Verify tests pass

```bash
# Detect test runner from package.json, pyproject.toml, etc.
# Run appropriate test command
```

If tests fail:
> "Tests are failing. Fix before merge."
→ Stop here.

### 4. Verify artifacts exist

Check that each role left its artifacts in the worktree:

```bash
# Architect artifacts: scaffold files, signature tests
grep -rn "DO NOT MODIFY" --include="*.test.*" --include="*_test.*" . 2>/dev/null | head -5

# QA artifacts: test cases in QA.md
grep -c "Feature {{NNN}}" docs/QA.md 2>/dev/null
```

Report what will be merged to main:
> "The following artifacts from this feature will be merged to main:"
> - Code: {{list of modified/new source files}}
> - Architect: scaffold structure, signature tests
> - Designer: design intent updates in feature spec (if applicable)
> - QA: test cases in `docs/QA.md`
> - Feature spec: gate statuses updated

---

## Merge

### 1. Switch to main and merge

```bash
# Ensure main is up to date
git checkout main
git pull --ff-only origin main 2>/dev/null || true

# Squash merge
git merge --squash "feature/{{NNN}}-{{title_kebab}}"
```

### 2. Create commit

```bash
git commit -m "feat({{NNN}}): {{title}}

- Architect: {{brief summary of structure decisions}}
- Designer: {{brief summary of design decisions, or 'skipped'}}
- QA: {{number}} test cases passed

Feature spec: docs/features/{{NNN}}.md
Gate: architect ✓ | designer ✓/skipped | qa ✓"
```

### 3. Update feature spec status

Switch back briefly or edit from main — update the feature spec frontmatter:

```yaml
status: complete
gate:
  worktree: null  # worktree removed
  architect: passed
  designer: passed  # or skipped
  qa: passed
```

### 4. Update Feature Registry

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

### Merge conflicts

If `git merge --squash` produces conflicts:

1. List conflicting files
2. For each conflict, show the conflict markers
3. Offer resolution options:
   - Accept worktree version (ours)
   - Accept main version (theirs)
   - Manual resolution
4. After resolution, continue with commit

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
