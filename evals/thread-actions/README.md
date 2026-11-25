# thread-actions

> - **Answers:** In a PR thread, does Kody offer the memory or Kody Rule the thread calls for, take it when the developer asks, and write nothing nobody asked for?
> - **Runs:** nightly when the agent or its cases change (`evals/nightly-evals.js`, once per `--kind` and `--metric`: stages `thread-rule`, `thread-memory`, `thread-rule-offers` and `thread-memory-offers`), weekly on every tier-0 model against its floor (`evals/weekly.js`), and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/thread-actions/run.js --model=<id> [--kind=rule|memory] [--metric=writes|offers] [--show]`
> - **Gate:** `--gate` fails below the model's floor in `evals/thread-actions/targets.json` for the `--kind` (write checks) or for `<kind>-offers` (`--metric=offers`, offer checks). The number not gated is reported beside it.
> - **Cost:** writes: one conversation agent run per case (16 in all: 10 rule, 6 memory), plus one judge call for each case that is not a request to act. Offers: the cases that are not a request to act (8 rule, 5 memory), one agent run and one judge call each.

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

The write stages (`--metric=writes`, the default) count the write checks,
read from the stores behind production's MCP server, so a write counts only
when it went through production's write gate and tools:
- asked to act, the memory or rule lands (a created memory or rule that names
  the thread's subject, or the change to the existing rule), and nothing else;
- otherwise nothing is written and the agent declared no `act`.

The offers stages (`--metric=offers`) count the offer checks, over the
threads that do not ask Kody to act: whether the reply offers the action is
judged on the reply (`assertsClaim`, `evals/investigation/recall-judge.js`),
and it should in the offer threads and should not in the controls. The agent
learns which actions it may offer, and when, from each write tool's proactive
hint, which production's server sends in the tool's `_meta`
(`io.kodus/proactiveHint`) and the conversation agent reads only from the
Kodus MCP servers (`libs/agents/infrastructure/services/ai-sdk/mcp-tools.ts`).

A memory or rule the agent wrote where it should only have offered fails the
write check.

The scripted offer contract (a scripted model, a mocked MCP) stays in the unit
suite: `test/integration/agents/kody-proactive-actions.integration.spec.ts`.

`--show` prints the replies (`--show=prompt` also the prompt); the result keeps
each one.
