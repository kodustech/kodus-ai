# Runtime MCP acceptance

`env-mcp.runtime.integration.spec.ts` uses the installed official MCP SDK
Client and StreamableHTTPClientTransport against an ephemeral Nest endpoint.
It runs the actual controller, authentication/capability guards, env tools,
RuntimeEnvToolsService, EnvironmentViewBuilder, HttpEnvSessionClient, signed
env-session HTTP listener, EnvSessionService and RuntimeSetupRequester.

CellHub and FakeCell exchange decoded protocol frames in process. Product
storage, key/repository/token lookup and the setup outbox use local fixtures;
the six tools do not call a model, Git provider, cloud or existing service.
The `env_fix` acceptance path is `retry_setup`, with a real validated outbox
message. Recipe PR publication remains covered by its separate tests.

Run with the repository's installed dependencies:

```sh
API_NODE_ENV=test node node_modules/jest/bin/jest.js libs/mcp-server/tests/env-mcp.runtime.integration.spec.ts --runInBand --detectOpenHandles
```

The fixture binds only `127.0.0.1` on assigned ephemeral ports. All keys and
JWTs are synthetic and valid only inside its local lookup. Teardown releases
gated work, sessions and claims, then closes SDK clients, HTTP listeners and
the cell connection; each cleanup operation has a deadline.

The suite verifies:

- All six tools, asynchronous acquire/exec polling, stepId before completion,
  scoped setup retry and idempotent release.
- Missing/revoked credentials, revocation after initialization and a valid
  service JWT refused by the team-key-only endpoint.
- Exact capabilities, org/team/key/repository isolation, quota refusal before
  command dispatch and redacted audit records.
- A wrong signature between the product and session listener cannot acquire
  a claim.

This is transport and cell-protocol acceptance. It does not validate mTLS,
the WebSocket listener, database persistence, Go machine drivers, actual app
execution, LLM tool choice or live self-hosted activation. It adds no A2A
endpoint or verified external-finding publication.
