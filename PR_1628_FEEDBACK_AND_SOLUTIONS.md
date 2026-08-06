# PR #1628 Maintainer Feedback: Exact Quotes, Explanations & Solutions

This document quotes the **exact feedback from the maintainer's review** of PR #1628 (`feat(duplicate-logic-finder): duplicates finding agent category`), provides a short & simple explanation of each problem, details the best solution, and highlights what the maintainer specifically requested regarding fixes and benchmarks.

---

## 1. Core Issue: Detection Layer Adds Token Cost & Noise Without Signal

### 💬 Maintainer's Exact Words
> "This doesn't currently address #1602. The issue asked for a finder that detects structurally similar siblings — 'same shape of calls/branches over the same domain entities, not just textual clones' — and was explicit that 'precision matters more than recall here… start with high-similarity structural twins only.'
>
> What's here is a new agent class plus a prompt, and a detection layer that's `similarity(n.name, c.name) > 0.15` — trigram matching on function names, no AST or call-shape comparison at all. On our test repo:
>
> changed file | changed nodes | candidates flagged
> --- | --- | ---
> date.ts | 13 | 437
> slack.service.ts | 27 | 1,429
> github.service.ts | 97 | 2,134 (56% of every function in the repo)
>
> For a PR touching only `slack.service.ts`, 99.5% of the exported graph came back flagged (1429 is_duplicate: true vs 7 false) — first entry was `AxiosAzureBoardsService.get`. That pushes the injected prompt fragment from ~5KB to 222,735 chars (~55k tokens), uncapped, handed to every agent.
>
> And the part that matters most — I ran two e2e legs with planted byte-identical twins:
> - Leg A (0 candidates injected due to read error): 833 chars prompt, 2 findings (both correct), duration 217s
> - Leg B (1,429 candidates injected): 222,735 chars prompt, 2 findings (both correct), duration 223s
>
> The leg that received zero candidate data produced the same results. The agent found the twins using the `grep`/`readFile` tools it already had. So right now the detection layer isn't contributing anything the agent can't already do on its own — the PR is effectively a prompt, and the graph work is adding cost and noise without adding signal. That's the core thing to fix."

### 📝 Simple Explanation
The candidate detector only compares function names letter-by-letter using a loose string match (`similarity > 0.15`). It doesn't check the code structure or parameter shapes. It flagged 2,134 functions (56% of the codebase) as duplicates for a PR touching `github.service.ts`, inflating the prompt by 55k tokens. Benchmark legs proved that injecting 1,429 candidates produced the exact same 2 findings as injecting 0 candidates because the agent uses `grep` and `readFile` on its own.

### ✅ Best Solution
- **What the maintainer requested:** "Start with high-similarity structural twins only... same shape of calls/branches over the same domain entities."
- **Implementation:**
  1. Replace `similarity()` trigram string matching with exact AST structural properties:
     - Match identical function names across different files/classes (`n.name = c.name AND n.qualified_name != c.qualified_name`)
     - Match identical parameter signatures & return types (`n.params = c.params AND n.return_type = c.return_type`)
  2. Hard-cap candidate results at **`LIMIT 15`** per review so prompt injection stays under 1 KB (~200 tokens).

### 💡 Why this solution is best
It fulfills the maintainer's requirement for high precision over recall, eliminates 55k token prompt bloat, and provides high-signal AST structural candidates instead of thousands of false-positive string matches.

---

## 2. Blocker #1: `similarity()` needs missing `pg_trgm` & Unconditional Query

### 💬 Maintainer's Exact Words
> "1. `similarity()` needs `pg_trgm`, which nothing installs.
>
> `$ psql -c "SELECT extname FROM pg_extension ORDER BY extname;"`
> `plpgsql | uuid-ossp | vector          <- no pg_trgm`
>
> `$ # running your CTE as written`
> `ERROR:  function similarity(text, text) does not exist`
> `LINE 14:             AND similarity(n.name, c.name) > 0.15`
>
> `$ grep -rn "pg_trgm" --include='*.ts' --include='*.sql' --include='*.yml' . | grep -v node_modules`
> `(no matches anywhere in the repo)`
>
> Worse, `duplicate_candidates` is in the CTE unconditionally, not gated on `reviewOptions.duplicate_logic` — so `exportSubgraphJsonString` throws on every review, gets swallowed by the outer try in `graph-context.service.ts:159`, and falls back to `generateContextLegacy`. The DB-baseline call graph would silently stop working repo-wide, for everyone."

### 📝 Simple Explanation
1. `similarity()` needs a Postgres extension (`pg_trgm`) that is not installed in the database or repo migrations, throwing a SQL error every time the query runs.
2. The `duplicate_candidates` CTE was included unconditionally on **all** reviews. Because it threw a SQL error, it broke the DB call-graph baseline for every single code review across the entire platform.

### ✅ Best Solution
- **What the maintainer requested:** Gate `duplicate_candidates` conditionally on `reviewOptions.duplicate_logic`, and remove `similarity()`.
- **Implementation:**
  1. Replace `similarity()` with standard Postgres equality and `EXISTS` queries that require no extensions.
  2. Pass `includeDuplicates: boolean` so `duplicate_candidates` CTE is only appended when `reviewOptions.duplicate_logic === true`.

### 💡 Why this solution is best
It removes uninstalled database dependencies, eliminates SQL runtime errors, and guarantees that normal code reviews are unaffected and keep their fast DB-baseline call graph.

---

## 3. Blocker #2: Missing Import Silently Disables Kody Rules Agent

### 💬 Maintainer's Exact Words
> "2. A missing import silently disables the Kody Rules agent. `review-orchestrator.service.ts:95` still references `KodyRulesAgentProvider` but the import was dropped in `bb051ec`:
>
> `$ bash scripts/typecheck-libs-gate.sh`
> `❌ libs/code-review/infrastructure/agents/review-orchestrator.service.ts(95,43):`
> `   error TS2304: Cannot find name 'KodyRulesAgentProvider'.`
>
> `nest-cli.json` sets `typeCheck: false`, so it builds anyway, the paramtype degrades to `Object`, and `@Optional()` makes Nest inject `undefined`:
>
> `PARAMTYPES: [..., "BaseCodeReviewAgentProvider", "Object"]`
> `kodyRulesAgent injected: UNDEFINED  <-- kody-rules agent will never be dispatched`
>
> Kody Rules stops running entirely — no crash, no log."

### 📝 Simple Explanation
Commit `bb051ec` dropped the import for `KodyRulesAgentProvider` in `review-orchestrator.service.ts`. Because `nest-cli.json` ignores type checks at build time, NestJS DI couldn't resolve the class type and injected `undefined`. Kody Rules completely stopped running system-wide without throwing any errors or logging warnings.

### ✅ Best Solution
- **What the maintainer requested:** Restore the import and verify with `scripts/typecheck-libs-gate.sh`.
- **Implementation:**
  1. Add `import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';` back to `review-orchestrator.service.ts`.
  2. Run `bash scripts/typecheck-libs-gate.sh` to ensure zero compilation errors.

### 💡 Why this solution is best
It restores the TypeScript type reflection metadata so NestJS DI correctly injects `KodyRulesAgentProvider`, re-enabling Kody Rules execution across the pipeline.

---

## 4. Blocker #3: On E2B (Cloud) the Feature is a No-Op

### 💬 Maintainer's Exact Words
> "3. On E2B (cloud) the feature is a no-op. `graph-context.service.ts:116` reads with a relative path while `writeBaseGraphToSandbox` writes to `${sandbox.repoDir}/....` E2B resolves relative reads against `/home/user`, but `repoDir` is `/home/user/repo`:
>
> `19:42:14  Subgraph exported: 243615 chars, writing to sandbox`
> `          at /home/user/repo/.kodus-graph/base-graph.json`
> `19:42:15  FileNotFoundError: path '/home/user/.kodus-graph/base-graph.json' does not exist`
> `19:42:16  Context generated with DB baseline: 833 chars`
>
> Swallowed by the inner catch. We select E2B whenever `API_E2B_KEY` is set, so cloud never gets this. `runContext` right below already does it correctly."

### 📝 Simple Explanation
`graph-context.service.ts` read the base-graph file using a relative path (`.kodus-graph/base-graph.json`), which resolved to `/home/user/` in E2B cloud containers instead of `/home/user/repo/`. This threw a `FileNotFoundError` that was caught silently, making candidate injection a 100% dead feature on all cloud runs.

### ✅ Best Solution
- **What the maintainer requested:** Follow the pattern in `runContext` below it and use `sandbox.repoDir`.
- **Implementation:**
  Update the read path to use absolute paths: `${sandbox.repoDir}/.kodus-graph/base-graph.json`.

### 💡 Why this solution is best
It ensures identical, reliable path resolution in both local Docker environments and E2B cloud containers.

---

## 5. Testing & Evaluation Benchmarks Required

### 💬 Maintainer's Exact Words
> "Please test your changes. All three of the above surface on the first real review you run. #1 means the query never executes anywhere; #3 means the candidate block never reaches the prompt on E2B; #2 is caught by `scripts/typecheck-libs-gate.sh`, which is a required CI gate. A single end-to-end run with the feature enabled and the worker logs open would have shown all of them...
>
> Please run the evals. We have a harness for exactly this, and #1602 specifically asked for benchmark A/B before enabling a new finder:
>
> `pnpm eval:engine:preflight`     # no model/network — validates wiring + datasets
> `pnpm eval:finder:recall:smoke`  # quick recall check
> `pnpm eval:finder:recall`        # scores recall / precision / F1 against golden bugs
>
> `evals/investigation/README.md` explains the recall suite... What we need to see is a before/after: does enabling `duplicate_logic` change precision/recall versus baseline, and does the candidate injection change anything versus the agent running without it?"

### 📝 Simple Explanation
The maintainer requested that before re-submitting, we must:
1. Run the local typecheck script (`scripts/typecheck-libs-gate.sh`).
2. Run the 3 evaluation commands to produce A/B benchmark numbers showing if candidate injection improves recall/precision without regressing baseline F1.

### ✅ Best Solution
Run the typecheck script and evaluation commands, and include the before/after precision/recall/F1 metrics in the PR description:
```bash
bash scripts/typecheck-libs-gate.sh
pnpm eval:engine:preflight
pnpm eval:finder:recall:smoke
pnpm eval:finder:recall
```

---

## 6. Unrelated Changes & Merge Conflict Cleanup

### 💬 Maintainer's Exact Words
> "The branch is conflicting with main. There are several unrelated changes bundled in here too — sandbox write-path changes that drop the symlink/TOCTOU hardening from #1532, lease-manager changes, and some Windows-specific bits (`C:\Program Files\Git\bin\bash.exe`, `REPLACE(file_path,'\','/')` which turns an index scan into a seq scan on `ast_nodes`). Those should come out of this PR."

### 📝 Simple Explanation
The PR contains unrelated edits that need to be reverted:
1. Sandbox write-path changes that accidentally dropped symlink/TOCTOU security from #1532.
2. Unrelated lease-manager changes.
3. Windows-specific paths (`C:\Program Files\Git\bin\bash.exe`).
4. `REPLACE(file_path, '\', '/')` in SQL which broke index scanning on `ast_nodes`.

### ✅ Best Solution
- Revert `local-sandbox.service.ts` and `sandbox-lease-manager.service.ts` back to `main` branch state.
- Remove Windows-specific hardcoded paths and SQL `REPLACE()` functions that break Postgres index scans.
- Resolve merge conflicts with `main`.
