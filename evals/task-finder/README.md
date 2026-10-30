# task-finder — reading a task after its tracker's MCP changed

> - **Answers:** When a tracker's MCP renames a tool, answers in a new shape or requires a new argument, does business-logic validation still read the right task, and never another one?
> - **Runs:** on demand with a real model.
> - **Run it:** `node evals/task-finder/run.js --model=gpt-5.4-mini [--repeats=3] [--case=L2,J1]`
> - **Gate:** a case fails when the expected task isn't read, another one is, or a tool that writes is called. Exit 1 on any failure, 2 on infra.
> - **Cost:** a few short agent runs per case (8 cases).

Each case simulates one tracker server with the tool names and read-only marks
the real one lists (Linear, Atlassian Rovo, Kodus Git Issues, a ClickUp-style
plugin), changed the way servers change. The production tracker reads it
first; when it misses, the production task finder
(`libs/agents/business-validation/trackers/task-finder.ts`) runs on the model.

| Case | Change |
|---|---|
| L1 | none: the direct read finds it, the finder never runs |
| L2 | Linear renamed `get_issue` |
| L3 | Linear `get_issue` takes only the internal id; a list maps the key to it |
| L4 | a typo whose team exists: nothing is read, no other task taken |
| J1 | Rovo renamed `getJiraIssue` |
| J2 | Rovo answers with the key under `issueKey` and the text under `body` |
| G1 | Git Issues renamed its reader; another repository has a `#12` too |
| C1 | a custom task id that needs the workspace id and `custom_task_ids` |

What the finder may accept is pinned by unit tests in `task-finder.spec.ts`
(scripted agent, no model): an exact id match, the whole item, read-only tools
only, a missing task reported only after the server answered. This eval
measures whether a real model gets there.
