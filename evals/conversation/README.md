# conversation

> - **Answers:** When a developer answers a Kody comment, does Kody's reply get the code right — a fix that landed or did not, a decline that holds or does not — in the team's language, without acting on something nobody asked for?
> - **Runs:** nightly when the agent or its cases change (`evals/nightly-evals.js`), weekly on every tier-0 model against its floor (`evals/weekly.js`), and on every PR in `evals/wiring-smoke.js` against the scripted model.
> - **Run it:** `node evals/conversation/run.js --model=<id> [--show]`
> - **Gate:** `--gate` fails below the model's floor in `evals/conversation/targets.json`.
> - **Cost:** one conversation agent run per case (9), plus one judge call each.

A developer's answer in a Kody thread reaches `ConversationAgentProvider`
(`libs/agents/infrastructure/services/agents/conversation/conversationAgent.ts`)
through `chatWithKodyFromGit.use-case.ts`. The eval builds the thread context
with the use case's own functions (`reply-thread.ts`) and runs the class with
what production gives it, each case as its own organization with a connected
GitHub:
- the sandbox: production's `LocalSandboxService.createSandboxWithRepo`,
  fetching `refs/pull/7/head` and the base branch at depth 1 from a git remote
  that carries both (`evals/shared/pr-remote.js`);
- the org's MCP connections: production's `MCPManagerService` reads them from
  the mcp-manager (here, the row its `createKodusMCPIntegration` stores, with
  the tools its `KodusMCPClient` lists) and signs the Kodus MCP token; the
  agent connects over HTTP to production's MCP server
  (`McpController` → `McpServerFactory`, behind `McpEnabledGuard` and
  `McpAuthGuard`), whose tools run on production's services over in-memory
  stores, and whose GitHub calls go through `GithubService` to the PR's
  remote answering as GitHub's REST API (`evals/shared/kodus-mcp.js`,
  `evals/shared/github-rest.js`);
- the org's model config (`evals/shared/model-route.js`: a stored BYOK config
  holding the model), which production's `PermissionValidationService` routes.

`cases.js` holds the cases, written for the eval with invented code after the
replies production threads carry most (`kodus_agent_sessions`): "Fixed in
<sha>", "Declined: …", "Not valid: …", a question, in English and Portuguese.
They come in pairs that differ only in whether the developer is right, so the
reply has to come from reading the code.

Each reply is checked three ways:
- it asserts what the code shows (`golden`), read by the judge's `assertsClaim`
  (`evals/investigation/recall-judge.js`): a reply that only hedges, or says it
  could not check, does not assert it;
- it acts on nothing: the decision it declared (`kodusDecideAction`) is not
  `act` and the org's stores hold no rule, memory or issue it wrote — nobody
  asked for one;
- it is in the team's language.

The agent reaches the code two ways, the sandbox and the MCP's GitHub tools:
with only the sandbox tools removed it still reads it (26 of 27); with both
removed it cannot, and the run falls below the floor (19 of 27,
`targets.json`). A case where the agent got no MCP tools does not measure.
`--show` prints the replies (`--show=prompt` also the prompt); the result
keeps each one, for whoever reads a verdict after the judge.
