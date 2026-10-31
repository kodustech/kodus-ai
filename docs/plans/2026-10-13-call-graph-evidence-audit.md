# Call Graph Evidence Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the private customer-miss corpus able to prove whether captured call-graph XML contains the dependency evidence required by each case, without adding customer code or fabricated graph data to this repository.

**Architecture:** Add a small deterministic XML evidence parser and manifest evaluator under `evals/investigation/`. A private manifest maps a benchmark case to required caller/callee evidence; the recall runner audits the captured graph before it pays for a model run and writes coverage to the result metadata. Missing captured context remains `not measured`, never a passing treatment case.

**Tech Stack:** Node.js CommonJS, Jest, existing finder-recall runner and captured Langfuse replay datasets.

### Task 1: Define and test the evidence contract

**Files:**

- Create: `evals/investigation/callgraph-evidence.js`
- Create: `evals/investigation/callgraph-evidence.spec.ts`

**Step 1: Write the failing tests**

Cover a captured XML graph containing a changed function, production caller, test caller, and callee. Assert the parser preserves relation order and classifies test paths. Add evaluator cases for a matching required callee, a missing relation, and a malformed private manifest.

**Step 2: Run the test to verify it fails**

Run: `pnpm exec jest evals/investigation/callgraph-evidence.spec.ts --runInBand --config jest.config.ts`

Expected: fail because the evidence module does not yet exist.

**Step 3: Implement the minimal parser and evaluator**

Parse only the stable XML fields emitted by `kodus-graph`: changed function name/file, caller name/file/line/confidence, callee name/file/confidence. Evaluate exact required direct relations from a manifest; do not infer dependencies from symbol names.

**Step 4: Run the focused tests**

Run the command from Step 2.

Expected: pass.

### Task 2: Wire auditing into the recall runner

**Files:**

- Modify: `evals/investigation/run-recall.js`
- Test: `evals/investigation/callgraph-evidence.spec.ts`

**Step 1: Write the failing test**

Add a test that applies an expectation manifest to selected cases and reports: captured graph absent, required relations matched, required relations missing, and ordering violations where a test caller precedes production callers.

**Step 2: Run the test to verify it fails**

Run the focused Jest command from Task 1.

Expected: fail because the runner-facing audit helper does not exist.

**Step 3: Implement minimal runner integration**

Add `--call-graph-expectations <path>` / `RECALL_CALL_GRAPH_EXPECTATIONS`. Load the local JSON manifest, audit only selected cases, and serialize the audit summary with the recall result. Invalid manifests exit 2 before any model call. Do not make the audit a recall-quality gate yet.

**Step 4: Run the focused tests**

Run the focused Jest command from Task 1.

Expected: pass.

### Task 3: Document the private-corpus handoff and verify wiring

**Files:**

- Modify: `evals/investigation/README.md`
- Test: `evals/wiring-smoke.js` via `pnpm eval:wiring`

**Step 1: Document the manifest shape**

Document an anonymized example and state explicitly that the private corpus is external, call graph must be captured from a real trace, and unavailable context is not measured.

**Step 2: Run focused verification**

Run:
`pnpm exec jest evals/investigation/callgraph-context.spec.ts evals/investigation/callgraph-evidence.spec.ts libs/code-review/infrastructure/agents/engine/agent-tools.call-graph.spec.ts --runInBand --config jest.config.ts`

Expected: all focused suites pass.

**Step 3: Run eval wiring**

Run: `pnpm eval:wiring`

Expected: the finder-recall engine path passes; report any pre-existing worktree-only failure separately and do not represent it as a passing full run.

**Step 4: Preserve changes for review**

Do not commit. Report modified files, test output and measurement blockers to the user.
