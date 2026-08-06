# Progress Report: PR #1628 (`feat(duplicate-logic-finder)`)

**PR Link:** https://github.com/kodustech/kodus-ai/pull/1628  
**Branch:** `duplicate-logic-finder` (base: `main`)  
**Feature:** Issue #1602 — Duplicate Logic Finder & AST Graph Structural Twin Matching  

---

## Executive Summary

PR #1628 introduces a dedicated `DuplicateLogicAgentProvider` category and an AST Graph duplicate candidate detection layer. Maintainer review feedback highlighted 4 critical code blockers (unbounded trigram prompt bloat of ~55k tokens, missing DI imports disabling Kody Rules, E2B cloud container path failures, and SQL index scan regressions) and requested benchmark validation.

All 4 code blockers have been fixed, verified, and cleaned up. TypeScript compilation checks pass with **0 errors**.

---

## Summary of Resolved Maintainer Blockers

### 1. Fixed Unbounded Trigram Prompt Bloat (~55k Tokens → <400 Tokens)
- **Problem**: `similarity(n.name, c.name) > 0.15` ran loose string trigram matching on function names, flagging up to 2,134 candidates (56% of the repo) and inflating the prompt fragment to **222,735 chars (~55,000 tokens)**.
- **Solution**:
  - Replaced name trigram string matching with high-precision AST structural twin detection in `astGraph.repository.ts`:
    - **Tier 1 (High Confidence Twins)**: Matching return types + shared call graph shape ($\ge 2$ common callees).
    - **Tier 2 (High Similarity Twins)**: Name similarity $\ge 0.7$, matching return types, and matching parameter count.
  - Added a strict **`LIMIT 10`** cap on candidates.
  - Gated the `duplicate_candidates` CTE behind `includeDuplicates = true` so standard code reviews never execute it or incur CTE overhead.
  - **Result**: Reduced prompt injection payload from **222,735 chars (~55k tokens)** to **<1,500 chars (<400 tokens)**.

### 2. Restored Missing `KodyRulesAgentProvider` Import
- **Problem**: Commit `bb051ec` dropped the `KodyRulesAgentProvider` import in `review-orchestrator.service.ts`. Because `nest-cli.json` disables build-time typechecking, NestJS DI reflected the constructor param as `Object` and injected `undefined` at runtime via `@Optional()`, silently disabling Kody Rules system-wide.
- **Solution**: Restored `import { KodyRulesAgentProvider }` in `review-orchestrator.service.ts`. Verified clean typechecking via `bash scripts/typecheck-libs-gate.sh`.

### 3. Fixed E2B Cloud Sandbox Path Resolution
- **Problem**: `graph-context.service.ts` read `.kodus-graph/base-graph.json` using a relative path, which resolved to `/home/user/` in E2B cloud containers instead of `/home/user/repo/`, silently failing on every cloud review.
- **Solution**: Updated the read path to absolute `${sandbox.repoDir}/.kodus-graph/base-graph.json`.

### 4. Database & Security Cleanup
- **Migration Added**: Created TypeORM migration `libs/core/infrastructure/database/typeorm/migrations/2026073100000000-addPgTrgmExtension.ts` to ensure `pg_trgm` extension is installed when trigram operations are used.
- **Restored Index Scanning**: Removed `REPLACE(file_path, '\', '/')` in SQL CTEs which was forcing sequential table scans on `ast_nodes`.
- **Restored Sandbox Hardening**: Reverted `libs/sandbox/infrastructure/providers/local-sandbox.service.ts` back to `main` branch state to preserve symlink and TOCTOU security hardening from #1532.
- **Architectural Directory Alignment**: Relocated `duplicate-logic-agent.provider.ts` into `libs/code-review/infrastructure/agents/providers/`.

---

## Benchmark & Evaluation Findings (`eval:finder:recall`)

### Understanding the Benchmark Recall Numbers (~3% Recall)
- **Dataset Context**: The benchmark suite (`evals/investigation/datasets/`) consists of 50 real PR dataset files (Keycloak, Discourse, Sentry, Grafana, Cal.com). 
- **Goldens Target**: 100% of the golden comments in these datasets test **general PR software bugs** (auth bypasses, SSRF vulnerabilities, null pointers, race conditions). Zero goldens target duplicate code or structural twins.
- **Why Recall is 3% for Duplicate Agent**: `DuplicateLogicAgentProvider`'s prompt explicitly restricts its scope to **duplicate code, logic drift, and un-synced clones**. When evaluated against general security and logic bug benchmarks, it intentionally skips general bugs, resulting in a low general-bug recall score.
- **Maintainer Experiment Corroboration**: In `comment.md`, the maintainer noted that injecting 1,429 candidates vs 0 candidates yielded identical twin findings because the agent uses file/grep tools on its own. Capping candidates at 10 high-precision AST structural twins eliminates prompt noise without degrading tool-assisted discovery.

---

## File Modification Breakdown

### Core Platform Fixes
- `libs/code-review/infrastructure/agents/review-orchestrator.service.ts`: Restored `KodyRulesAgentProvider` import.
- `libs/code-review/infrastructure/adapters/repositories/astGraph.repository.ts`: Gated `duplicate_candidates` CTE on `includeDuplicates`, added AST structural twin logic + `LIMIT 10`, removed index-breaking `REPLACE()`.
- `libs/code-review/infrastructure/adapters/services/graph/graph-context.service.ts`: Updated E2B read path to `${sandbox.repoDir}/...`.
- `libs/code-review/infrastructure/agents/providers/duplicate-logic-agent.provider.ts`: Moved to `providers/` folder for architectural consistency.
- `libs/code-review/pipeline/code-review-pipeline.module.ts`: Updated provider imports.
- `libs/sandbox/infrastructure/providers/local-sandbox.service.ts`: Reverted to `main` branch state (security hardening).
- `libs/core/infrastructure/database/typeorm/migrations/2026073100000000-addPgTrgmExtension.ts`: Added `pg_trgm` migration.

### Eval & Helper Files
- `evals/investigation/agent-provider.js`: Dynamic provider loading based on `RECALL_CATEGORY`.
- `evals/investigation/recall-judge.js`: 60s backoff delay for Gemini HTTP 429 rate limit errors.
- `evals/shared/tier0-models.js`: Included `GEMINI_API_KEY` in model environment key list.
- `PR_1628_FEEDBACK_AND_SOLUTIONS.md` & `comment.md`: Comprehensive breakdown of maintainer feedback and solutions.

---

## Verification Commands

Run these to verify the branch before committing:

```bash
# 1. Verify TypeScript compilation (gate script)
bash scripts/typecheck-libs-gate.sh

# 2. Check git status
git status
```

---

## Recommended Next Steps for the Next Agent / Developer

1. **Verify Compilation**: Run `bash scripts/typecheck-libs-gate.sh` to confirm zero TS errors.
2. **Review Diff**: Run `git diff` to inspect changes.
3. **Commit & Push**:
   ```bash
   git add .
   git commit -m "fix(code-review): resolve PR #1628 maintainer review feedback"
   git push origin duplicate-logic-finder
   ```
4. **Respond to Maintainer on PR #1628**: Use the formatted response in `comment.md` or section 2 of this document to post a clear maintainer update.
