# conversation

> - **Answers:** When a developer answers a Kody comment, does Kody's reply get the code right — a fix that landed or did not, a decline that holds or does not — in the team's language, without declaring an action nobody asked for?
> - **Runs:** nightly when the agent or its cases change (`evals/nightly-evals.js`), Friday on every tier-0 model, and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/conversation/run.js --model=<id> [--show]`
> - **Gate:** `--gate` fails below the model's floor in `evals/conversation/targets.json`.
> - **Cost:** one conversation agent run per case (8), plus one judge call each.

A developer's answer in a Kody thread reaches `ConversationAgentProvider`
(`libs/agents/infrastructure/services/agents/conversation/conversationAgent.ts`)
through `chatWithKodyFromGit.use-case.ts`, with the PR's head checked out in a
sandbox. The eval builds the same thread context, gives the agent the case's
repository as a git checkout through the production `LocalSandboxService`
(`rg` on the PATH), and runs the class itself: the org has no BYOK config
(`PermissionValidationService` resolves the eval's model) and no MCP servers (the Kodus MCP server needs its tool services booted; not covered),
so writes (memories, rules) are not covered.

`cases.js` holds the cases, written for the eval with invented code after the
replies production threads carry most (`kodus_agent_sessions`): "Fixed in
<sha>", "Declined: …", "Not valid: …", a question, in English and Portuguese.
They come in pairs that differ only in whether the developer is right, so the
reply has to come from reading the code.

Each reply is checked three ways:
- it asserts what the code shows (`golden`), read by the judge's `assertsClaim`
  (`evals/investigation/recall-judge.js`): a reply that only hedges, or says it
  could not check, does not assert it;
- the decision it declared (`kodusDecideAction`) is not `act`: nobody asked for
  an action;
- it is in the team's language.

With the sandbox tools removed, the agent cannot read the code and 7 of the 8
cases go wrong (`targets.json`). `--show` prints the replies; the result keeps
each one, for whoever reads a verdict after the judge.
