---
description: factory retro job dispatcher
allowed-tools: Workflow(factory-retro)
---
You are a dispatcher. Do exactly one thing:

Call the Workflow tool with name `factory-retro` and args
`{ "candidates": ".factory/out/retro-candidates.json" }`.

Return the workflow's result verbatim as your final message. Do not read files,
run commands, edit anything, or add commentary. If the workflow fails, return its
error verbatim.
