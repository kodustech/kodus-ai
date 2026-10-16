# thread-actions

> - **Answers:** In a PR thread, does Kody offer the memory or Kody Rule the thread calls for, take it when the developer asks, and write nothing nobody asked for?
> - **Runs:** nightly when the agent or its cases change (`evals/nightly-evals.js`, once per `--kind`: stages `thread-rule` and `thread-memory`), Friday on every tier-0 model, and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/thread-actions/run.js --model=<id> [--kind=rule|memory] [--show]`
> - **Gate:** `--gate` fails below the model's floor for the `--kind` in `evals/thread-actions/targets.json`; it reads the write checks only. Offers are reported, never gated.
> - **Cost:** one conversation agent run per case (16 in all: 10 rule, 6 memory), plus one judge call for each case that is not a request to act.

A developer's reply in a Kody thread reaches `ConversationAgentProvider`
through `chatWithKodyFromGit.use-case.ts`. The eval runs it the way
`evals/conversation` does (`evals/shared/pr-thread.js`): each case is its own
organization with a connected GitHub, the thread context comes from the use
case's own functions, the sandbox is production's local one fetching the PR
head, and the org's Kodus MCP is production's server and tools over in-memory
stores (`evals/shared/kodus-mcp.js`). A case about an existing rule seeds the
org with that rule, and Kody's comment carries the rule's id and link as a
Kody Rules finding does.

`cases.js` holds the cases, written for the eval with invented code, in
pairs that keep the thread and change only the reply:
- the developer states a team convention, a standard the team wants enforced,
  or that the rule behind the finding is too broad: Kody should **offer** the
  memory, the new rule or the change, and write nothing;
- the developer asks Kody to remember, create or change it: Kody should
  **act**, and the write must land in the org's store;
- the control reply calls for nothing: no offer, no write.

The number `--gate` reads counts the write checks, read from the stores
behind production's MCP server, so a write counts only when it went through
production's write gate and tools:
- asked to act, the memory or rule lands (a created memory or rule that names
  the thread's subject, or the change to the existing rule), and nothing else;
- otherwise nothing is written and the agent declared no `act`.

Whether the reply offers the action is judged on the reply (`assertsClaim`,
`evals/investigation/recall-judge.js`) and reported as `reported` in the
result, never gated. The server sends each write tool's `proactiveHint`, but
the MCP SDK (1.29.0) parses `tools/list` with a `ToolAnnotationsSchema` that
drops unknown keys (`libs/mcp-server/mcp-adapter/client.ts` `listTools`), so
`libs/agents/infrastructure/services/ai-sdk/mcp-tools.ts` `readAnnotations`
never sees it and the prompt never carries the offers block. The agent offers
anyway from the decision tool's own description: in the calibration runs every
offer case offered, and the misses were offers in control threads
(`targets.json`). These checks are the proof for that fix; give them a floor
when it lands. A memory or rule the agent wrote where it should only have
offered fails the write check.

The scripted offer contract (a scripted model, a mocked MCP) stays in the unit
suite: `test/integration/agents/kody-proactive-actions.integration.spec.ts`.

`--show` prints the replies (`--show=prompt` also the prompt); the result keeps
each one.
