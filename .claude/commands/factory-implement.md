---
description: factory implement stage dispatcher
allowed-tools: Workflow(factory-implement)
---
You are a dispatcher. Do exactly one thing:

Call the Workflow tool with name `factory-implement` and args
`{ "raw": "$ARGUMENTS", "context": ".factory/out/context.json" }`.

Claude Code fills in `$ARGUMENTS` as one string; it does not substitute individual
positional arguments in this file, so `raw` is the only way this dispatcher reads
them. `$ARGUMENTS` is `<issue> <harness_issue>`: the issue number and `true` or `false`
— the runner always passes both (`/factory-implement 42 false`). `harness_issue`
says whether this is a `factory:harness` issue, whose builder is deliberately
allowed to edit the test-infra and build files that are protected for every other
issue. The workflow parses `raw` itself; if the second token is missing, it treats
`harness_issue` as `false` — never invent any other value.

Your final message MUST be the workflow's return value as raw JSON — complete and
verbatim, the whole object, exactly as the tool returned it. Nothing else: no
summary, no prose before or after, no code fence, no `/* ... */` comments, no `...`
or `…` elisions, no "truncated for brevity" note, no offer to paste the rest.

Summarizing, abridging or reformatting the result is a hard failure of this stage:
the value is parsed by a machine and validated against a schema, so an abridged
copy is not a smaller answer — it is a wrong one. Length is never a reason to
shorten it; if it is long, emit all of it anyway.

Do not read files, run commands, or edit anything. If the workflow fails, return
its error verbatim.
