# MCP Skill Architecture Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make MCP failures predictable and user-safe across skills while fixing Docker dev MCP routing.

**Architecture:** Introduce a typed MCP connectivity error in the shared skill layer, throw it from the generic runner when required MCPs are configured but unavailable, and consume it in skill agents via centralized handling. Also fix Docker dev runtime so intra-container MCP calls do not use loopback `localhost`.

**Tech Stack:** NestJS, TypeScript, Jest, Docker Compose

### Task 1: Centralized Skill Error Model

**Files:**
- Modify: `libs/agents/skills/skill.errors.ts`
- Test: `libs/agents/skills/generic-skill-runner.service.spec.ts`

1. Add a typed `McpConnectionUnavailableError` with `skillName`, `availableProviders`, and original `causeMessage`.
2. Add a shared MCP connectivity detector helper for fallback classification.
3. Keep existing `RequiredMcpPreflightError` behavior untouched.

### Task 2: Generic Runner MCP Policy

**Files:**
- Modify: `libs/agents/skills/generic-skill-runner.service.ts`
- Test: `libs/agents/skills/generic-skill-runner.service.spec.ts`

1. On `connectMCP/registerMCPTools` failure:
2. If skill declares `requiredMcps`, throw `McpConnectionUnavailableError`.
3. Otherwise keep degrade behavior (warn and continue without tools).
4. Make provider extraction reusable and robust for logs/errors.

### Task 3: Business Rules Agent Integration

**Files:**
- Modify: `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent.ts`
- Modify: `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/required-mcp-feedback.ts`

1. Replace string-based MCP error detection with typed shared errors.
2. Use centralized MCP connection failure feedback with detected providers.
3. Preserve existing preflight feedback flow.

### Task 4: Docker Dev MCP Routing Fix

**Files:**
- Modify: `docker-compose.dev.yml`

1. Set internal MCP URL for app containers to Docker service host (`kodus_api`) instead of loopback semantics.
2. Ensure variable is available for `kodus-api`, `worker`, and `webhooks` via shared template.

### Task 5: Verification

**Files:**
- Test: `libs/agents/skills/generic-skill-runner.service.spec.ts`
- Test: `libs/agents/infrastructure/services/kodus-flow/business-rules-validation/task-quality.rules.spec.ts`

1. Run focused Jest suites.
2. Validate no regressions in existing behavior.
3. Report constraints (if full lint/test cannot run).
