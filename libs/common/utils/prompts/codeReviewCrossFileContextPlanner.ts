import z from 'zod';

export interface CrossFileContextPlannerPayload {
    diffSummary: string;
    changedFilenames: string[];
    language: string;
}

export const CrossFileContextPlannerSchema = z.object({
    queries: z
        .array(
            z.object({
                pattern: z.string().min(1),
                rationale: z.string().min(1),
                riskLevel: z.enum(['low', 'medium', 'high']),
                symbolName: z.string().min(1),
                fileGlob: z.string().optional(),
                sourceFile: z.string().min(1),
            }),
        )
        .max(10),
});

export type CrossFileContextPlannerSchemaType = z.infer<
    typeof CrossFileContextPlannerSchema
>;

export const prompt_cross_file_context_planner = (
    payload: CrossFileContextPlannerPayload,
) => {
    return `You are a code analysis planner. Your task is to analyze a PR diff and generate targeted ripgrep (rg) search patterns to find call-sites, consumers, and dependents in files OUTSIDE the PR.

## Goal
Given the diff summary and changed filenames below, produce up to 10 search queries that will help find code in the repository that may be affected by these changes.

### Category 1: Consumers & Callers (standard)
- Functions/methods/classes that were modified, renamed, or had their signatures changed
- Exported interfaces/types that changed shape
- Constants or config keys that were renamed or removed
- API endpoints or routes that were modified

### Category 2: Symmetric / Counterpart Operations (CRITICAL — often missed)
Every data operation has a counterpart. If the diff touches ONE side, you MUST search for the OTHER side:
- **Create → Validate**: if code creates/stores a hash, token, key, or ID, search for the code that validates/verifies/looks up that same value
- **Encode → Decode**: if code serializes, encodes, or marshals data, search for the deserialization/decoding counterpart
- **Write → Read**: if code writes to a database, file, cache, or queue, search for the code that reads/consumes from the same source
- **Producer → Consumer**: if code emits events, publishes messages, or dispatches actions, search for listeners/subscribers/handlers
- **Format → Parse**: if code formats/stringifies output, search for the code that parses/interprets that format
- **Map keys**: if code builds a mapping (e.g., severity → label), search for code that reads from that same mapping using the old or new keys

### Category 3: Test ↔ Implementation Verification
- If a changed file is a **test/spec**, search for the **implementation** it tests (the module imported by the test) — the reviewer needs to see how the real code works to validate test assertions
- If a changed file is an **implementation**, search for its **test files** — to check if tests still match the new behavior

### Category 4: Configuration & Limits
- If the diff changes limits, thresholds, sizes, or defaults (e.g., max array size, timeout, retry count), search for where those limits are enforced or depended upon (e.g., server body-size config, rate limiters, pagination consumers)

### Category 5: Upstream Dependencies (reduces false positives)
If the diff imports from LOCAL modules (relative paths like \`./\`, \`../\`, or workspace packages — NOT node_modules or stdlib), search for the implementation of those modules:
- The exported function/class/constant that the changed file uses
- Focus on understanding the API contract: return types, parameter types, error behavior
- This is critical when the changed code CALLS an imported function and the review needs to understand what that function returns or throws

Examples:
- \`import { db } from '../database'\` → search for the \`db\` export and its \`query\` method signature
- \`import { BuildPipeline } from '../../src/deploy/BuildPipeline'\` → search for the \`BuildPipeline\` class and \`toScript\` method
- \`import { validate } from './validators'\` → search for the \`validate\` function signature and return type

## Input

### Changed Files
${JSON.stringify(payload.changedFilenames, null, 2)}

### Diff Summary
${payload.diffSummary}

## Instructions

1. Identify the most impactful symbols (functions, classes, types, constants) changed in the diff.
2. For each symbol, generate a regex pattern suitable for ripgrep that would find usages/call-sites of that symbol across the codebase.
3. **Apply the Symmetric Pair rule**: for every data operation in the diff (hash, encode, write, emit, format), generate at least one query to find the counterpart operation. Ask yourself: "this code CREATES X — where is X CONSUMED or VERIFIED?"
4. **Apply the Test↔Implementation rule**: if any changed file is a test, generate a query to find the implementation source. If any changed file is an implementation, generate a query for its tests.
5. Assign a riskLevel:
   - **high**: Signature changes, removed exports, renamed public APIs, symmetric pair mismatches (create vs validate), broken mappings
   - **medium**: Behavioral changes to widely-used functions, type narrowing, changed limits/thresholds
   - **low**: Internal refactors that might affect nearby consumers
6. Optionally provide a fileGlob to narrow the search (e.g., "*.ts" or "*.py").
7. ALWAYS provide the symbolName — the primary symbol being searched (function name, class name, type name, event name, constant, etc.).

## Query Prioritization
Allocate your 10 queries wisely. Prioritize:
1. **Symmetric counterparts** — #1 source of cross-file bugs when missed
2. **Direct consumers/callers** of changed signatures (use the EXACT exported function/class/type name)
3. **Upstream dependencies** — #1 source of false positives when missed
4. **Test ↔ implementation** pairs (search for the symbol name with glob \`*.spec.ts\`, do NOT guess filenames)
5. **Configuration dependents**

**Quality > Quantity**: 5 precise queries are better than 10 noisy ones. Only generate a query if you're confident the symbol name is correct and the search will return useful cross-file results.

## Constraints
- Maximum 10 queries
- Patterns must be valid ripgrep regex
- Search for CONSUMERS, CALLERS, COUNTERPARTS, VERIFIERS, and UPSTREAM IMPLEMENTATIONS — not just definitions
- Do NOT generate patterns that would only match inside the changed files themselves

## CRITICAL: Query Quality Rules — READ CAREFULLY

Before generating ANY query, verify it passes ALL these checks:

1. **EXACT symbol names only** — The symbolName MUST appear verbatim in the diff code. If the diff shows \`import { triageSuggestion } from './safeguardTriage.service'\`, the symbol is \`triageSuggestion\` (the imported function). Do NOT infer class names like \`SafeguardTriageService\` — that name does not exist in the code. Copy-paste from the diff, do not invent.

2. **Skip deleted symbols** — Lines starting with \`-\` are REMOVALS. If a symbol only appears in removed lines (e.g., \`-import { SPECULATION_FEATURES }\`), it was deleted. Searching for deleted symbols wastes a query because the goal is to find live consumers, not confirm the deletion.

3. **No log/comment strings** — Strings inside \`logger.log()\`, \`console.log()\`, or comments are NOT code symbols. Never search for \`[TIMING]\`, \`error occurred\`, etc.

4. **No generic parameter names** — \`config\`, \`options\`, \`params\`, \`context\`, \`data\` match hundreds of files. Search for the specific TYPE instead (e.g., \`BYOKConfig\` not \`byokConfig\`).

5. **No private/internal symbols** — Constants like \`MAX_AGENT_TURNS\` or methods like \`extractFeatures\` that are private to one file will NOT have consumers outside that file. Skip them.

## CRITICAL: Ripgrep Pattern Rules
ripgrep searches LINE-BY-LINE. Patterns CANNOT span multiple lines.

**DO NOT** generate patterns that try to match multi-line constructs:
- ❌ \`import\\s+{[^}]*\\bsymbol\\b[^}]*}\` — fails because TypeScript imports are often multi-line
- ❌ \`import\\s*\\{[\\s\\S]*symbol\` — multi-line matching is not supported

**DO** use simple single-line patterns:
- ✅ \`\\bsymbolName\\b\` — finds any reference (imports, calls, re-exports, variable assignments)
- ✅ \`symbolName\\(\` — finds function call-sites specifically
- ✅ \`from.*module-path\` — finds import source (the \`from '...'\` part is always on one line)
- ✅ \`symbolName\\s*=\` — finds assignments/definitions

Prefer simple \\b word-boundary patterns. A pattern like \`\\bvalidateInput\\b\` is more reliable than trying to match the full import or call syntax.

## Output Format
Return a JSON object with a "queries" array. Each query has:
- pattern: ripgrep-compatible regex pattern
- rationale: why this search is important
- riskLevel: "low" | "medium" | "high"
- symbolName: the primary symbol being searched (REQUIRED — use the function, class, type, event, or constant name)
- fileGlob: (optional) glob to filter files, e.g. "*.ts"
- sourceFile: ALWAYS the changed file from the "Changed Files" list that triggered this query.
  Even for upstream dependency searches, set sourceFile to the changed file that contains the import.

## Language
All rationale text must be in ${payload.language || 'en-US'}.
`;
};
