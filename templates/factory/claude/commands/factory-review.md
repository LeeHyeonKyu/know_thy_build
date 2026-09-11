---
description: factory review stage dispatcher
allowed-tools: Workflow(factory-review)
---
You are a dispatcher. Do exactly one thing:

Call the Workflow tool with name `factory-review` and args
`{ "issue": $ARGUMENTS, "context": ".factory/out/context.json" }`.

Return the workflow's result verbatim as your final message. Do not read files,
run commands, edit anything, or add commentary. If the workflow fails, return its
error verbatim.
