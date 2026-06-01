# MCP Stateless HTTP Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current in-memory stateful MCP HTTP server with a stateless Streamable HTTP implementation that works correctly behind multiple ECS/EC2 instances behind a load balancer.

**Architecture:** The Kodus internal MCP flow already carries tenant and authorization context outside MCP transport session state. The refactor will remove `Map`-based session affinity from `libs/mcp-server`, create a fresh `McpServer` and `StreamableHTTPServerTransport` per POST request, and return `405` for unsupported `GET`/`DELETE` paths in stateless mode. Shared concerns such as tool registration and MCP HTTP response headers will be isolated in reusable helpers to keep the implementation maintainable and symmetric across both MCP entrypoints.

**Tech Stack:** NestJS, TypeScript, `@modelcontextprotocol/sdk`, Jest, Streamable HTTP

### Task 1: Lock the Stateless HTTP Contract in Tests

**Files:**
- Modify: `libs/mcp-server/controllers/__tests__/mcp.controller.spec.ts`
- Create: `libs/mcp-server/services/__tests__/mcp-server.factory.spec.ts`

1. Write failing tests for stateless POST behavior and `405` on `GET`/`DELETE`.
2. Run `yarn test libs/mcp-server/controllers/__tests__/mcp.controller.spec.ts libs/mcp-server/services/__tests__/mcp-server.factory.spec.ts` and confirm failure.
3. Commit test-only changes.

### Task 2: Extract MCP Server Factory

**Files:**
- Create: `libs/mcp-server/services/mcp-server.factory.ts`
- Create: `libs/mcp-server/services/github-issues-mcp-server.factory.ts`
- Modify: `libs/mcp-server/services/mcp-server.service.ts`
- Modify: `libs/mcp-server/services/github-issues-mcp-server.service.ts`

1. Create a fresh `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request.
2. Remove `Map<string, McpSession>`, `hasSession`, `createSession`, `handleServerNotifications`, and `terminateSession`.
3. Close `transport` and `server` on response completion.
4. Run focused tests and commit.

### Task 3: Simplify Controllers to POST-Only Stateless Behavior

**Files:**
- Modify: `libs/mcp-server/controllers/mcp.controller.ts`
- Modify: `libs/mcp-server/controllers/github-issues-mcp.controller.ts`

1. Keep `POST` and delegate directly to a stateless request handler.
2. Return `405` with `Allow: POST` for `GET` and `DELETE`.
3. Update Swagger descriptions to match stateless deployment.
4. Run controller tests and commit.

### Task 4: Validate Internal Client Compatibility

**Files:**
- Modify: `packages/kodus-flow/tests/adapters/mcp/adapter-connection.test.ts`
- Modify: `packages/kodus-flow/tests/adapters/mcp/tools.test.ts`
- Modify: `packages/kodus-flow/src/adapters/mcp/client.ts` only if tests prove a compatibility issue.
- Modify: `packages/kodus-flow/src/adapters/mcp/registry.ts` only if tests prove a compatibility issue.

1. Verify `connect()`, `listTools()`, and `callTool()` against a stateless Streamable HTTP server.
2. Run targeted tests.
3. Apply the smallest client-side fix only if required.

### Task 5: Verification and Cleanup

**Files:**
- Modify: `libs/mcp-server/README.md`

1. Run the focused verification suite for server and internal client.
2. Document the stateless deployment model and why session affinity was removed.
3. Report residual risks for future resumable/sessionful MCP features.
