type CategoryPromptKind = 'bug' | 'security' | 'performance';

type PromptBlock = {
    mission: string;
    focus: string[];
    doNotReport: string[];
    reasoningPolicy: string[];
    writingPolicy: string[];
};

const PROMPT_BLOCKS: Record<CategoryPromptKind, PromptBlock> = {
    bug: {
        mission:
            'Find real, verifiable bugs in the changed code by tracing execution and checking surrounding context before making any suggestion.',
        focus: [
            'logic errors and incorrect control flow',
            'null/undefined/nil access without guards (including values returned from lookups like findByKey/findOne that can be null)',
            'race conditions, concurrent state mutation, and TOCTOU windows between a validation check and the write that depends on it',
            'swallowed errors and missing cleanup in catch/finally, including exceptions in non-critical steps that abort a multi-step cleanup mid-way and leave orphan records',
            'unsafe error handling in HTTP streaming responses: unhandled rejections from finalize/pipe/finished after headers are sent (ERR_HTTP_HEADERS_SENT crashes the process when the global exception filter tries to write JSON over an open stream)',
            'resource leaks and missing cleanup',
            'broken invariants and invalid state transitions',
            'async timing bugs and stale captures',
            'wrong function, method, import, identifier, or parameter usage',
            'interface or contract mismatches, including options/params that the caller passes but the callee silently ignores (e.g., new optional field added at the boundary but not threaded through internal calls)',
            'dead or unreachable code that indicates a logic mistake',
            'type mismatches: wrong argument types, incompatible return types, calling a method with a signature that does not match the definition; mapped TypeScript types that flip optional keys to required (e.g., `[K in Enum]: ...` without `?`) are a breaking change to existing call sites',
            'delegation bugs: code that wraps, proxies, or caches another object but calls itself instead of the underlying delegate, causing infinite recursion or stale results',
            'unsafe database migrations: down() that fails because new enum values are still in use, ALTER TYPE without first deleting/migrating rows that reference removed values, schema-qualified DROP paired with unqualified CREATE (or vice-versa), CREATE INDEX inside startTransaction blocking CONCURRENTLY usage',
            'VCS provider API quirks that change PR semantics: passing `oldObjectId` as 40 zeros when a baseBranch is provided creates an orphan commit on Azure DevOps and the resulting PR shows every other file as a deletion; ignoring documented fields like baseBranch when the provider requires them',
            'critical test gaps: when one test in a suite asserts an authorization/security check (e.g., `authorizationService.ensure`) and a sibling test exercising the same code path omits the same assertion, the missing assertion lets the security check be removed without breaking tests',
            'path construction from non-attacker but admin-controlled values that ends up as ZIP entry names or file paths: `..` segments and absolute paths can produce Zip Slip when the archive is later extracted; same archive path generated for two different logical entries silently overwrites one with the other',
            'parsing path/identifier strings by splitting on a separator and taking only the first segment when the identifier itself can contain that separator (e.g., `owner/repo` resolved by reading only `segments[0]`) — match the longest known prefix instead',
            'refactor regressions that drop a fallback: when an `if/else if` chain replaces a single expression like `a?.x || b?.x`, verify each branch still falls back to the parent value when the leaf is missing',
        ],
        doNotReport: [
            'style or cosmetic issues',
            'performance issues',
            'security issues',
            'speculative concerns without evidence',
            'issues that exist only in unchanged code unless this PR makes them worse or newly reachable',
        ],
        reasoningPolicy: [
            'Analyze by tracing execution, not by pattern matching.',
            'For each suspicious change, check:',
            '- actual data flow through assignments, branches, and returns',
            '- edge cases such as null, empty, zero, false, and boundary values',
            '- repeated invocations and persisted state',
            '- parallel or concurrent execution when relevant',
            '- partial failures, cleanup paths, and inconsistent state',
            '- method signatures: does the callsite pass the right number and types of arguments? grep the method definition and compare with the callsite.',
            '- delegation targets: when code wraps, proxies, or caches another object, verify it calls the delegate — not itself. Read the actual implementation being called.',
            'Before reporting, determine if the bug is a regression (introduced by this PR) or pre-existing.',
            'Only report pre-existing bugs if this PR makes them newly reachable, removes a guard that was preventing them, or significantly increases the likelihood of triggering them.',
            'IMPORTANT: Do not stop at the first bug you find in a file. Each changed file may contain multiple independent bugs. Challenge the remaining changed functions in the same file too, but do not keep re-reading the same or highly overlapping ranges unless you have a new, concrete question that the previous reads did not answer. Confidence-seeking rereads are a mistake.',
        ],
        writingPolicy: [
            'Each finding must be technical, direct, and verifiable. Structure every suggestionContent as:',
            '1. WHAT: one sentence naming the exact problem (e.g. "null value is passed to processItem when the collection is empty")',
            '2. WHY: one sentence on the real impact (e.g. "causes a null dereference at runtime when no items are configured")',
            '3. HOW: a concrete fix only if the correct implementation is clear from the code you read — omit if speculative',
            'No filler or conversational phrasing. No vague statements like "this could cause issues".',
        ],
    },
    security: {
        mission:
            'Find real, verifiable security vulnerabilities in the changed code by tracing data flow from untrusted inputs to sensitive sinks.',
        focus: [
            'Injection flaws (SQLi, XSS, Command Injection, SSRF)',
            'Path traversal and Zip Slip: any value used as a file path or archive entry name (`..`, leading `/`, absolute paths) — flag even when the source is admin-controlled if extraction or write happens on a victim machine',
            'Broken Authentication and Session Management',
            'Broken Access Control (IDOR, missing permission checks)',
            'Sensitive Data Exposure (logging secrets, hardcoded credentials)',
            'Insecure Cryptography or hashing',
            'Security misconfigurations (CORS, Headers, insecure defaults)',
            'Missing input validation or bounds checking',
        ],
        doNotReport: [
            'style or cosmetic issues',
            'performance issues',
            'generic logic bugs not related to security',
            'speculative or hypothetical attacks without a clear exploit path in the context',
            'issues that exist only in unchanged code unless this PR makes them worse or newly reachable',
        ],
        reasoningPolicy: [
            'Analyze by tracing execution, not by pattern matching.',
            'For each suspicious change, check:',
            '- Is the input attacker-controlled?',
            '- Does the input reach a sensitive sink without validation/sanitization?',
            '- Are authorization boundaries enforced at the controller/resolver level?',
            '- Could the state be manipulated to bypass security checks?',
        ],
        writingPolicy: [
            'Each finding must be technical, direct, and verifiable. Structure every suggestionContent as:',
            '1. WHAT: one sentence naming the exact vulnerability (e.g. "user-controlled input is passed to buildQuery without sanitization")',
            '2. WHY: one sentence stating the concrete exploit path (e.g. "allows an attacker to inject arbitrary query conditions via the search parameter")',
            '3. HOW: a concrete fix only if the secure implementation is clear from the code you read — omit if speculative',
            'No filler or conversational phrasing. No speculative statements without a concrete exploit path.',
        ],
    },
    performance: {
        mission:
            'Find real, verifiable performance bottlenecks, catastrophic slowdowns, and resource exhaustion risks in the changed code.',
        focus: [
            'N+1 database queries inside loops',
            'Missing pagination or unbound data loading (Full Table Scans)',
            'Memory leaks or excessive allocations in hot paths',
            'Blocking synchronous calls in asynchronous environments',
            'Inefficient algorithms (O(N^2) or worse) operating on unbounded data',
            'Missing or improper caching mechanisms',
            'Excessive or redundant network calls',
            'Blocking DDL on hot tables: CREATE/DROP INDEX without CONCURRENTLY, ALTER TYPE/ALTER TABLE that holds ACCESS EXCLUSIVE on a large table during a deploy — cite the `up` migration if it already used CONCURRENTLY and the `down` does not',
        ],
        doNotReport: [
            'Micro-optimizations (e.g., pre-allocating small arrays, var++ vs ++var)',
            'General logic bugs or security issues',
            'Style or cosmetic issues',
            'Speculative scaling issues (e.g., "this might be slow for 10 million users" if the context implies small data)',
            'Issues that exist only in unchanged code unless this PR makes them newly reachable in a hot path',
        ],
        reasoningPolicy: [
            'Analyze by tracing data volume and loops, not by pattern matching.',
            'For each suspicious change, check:',
            '- What is the upper bound of this loop or collection?',
            '- Is this method called inside another loop?',
            '- Are there hidden database queries inside ORM properties/getters?',
            '- Does this database query efficiently filter/index the data before returning it?',
            '- Could this operation block the main thread or event loop?',
        ],
        writingPolicy: [
            'Each finding must be technical, direct, and verifiable. Structure every suggestionContent as:',
            '1. WHAT: one sentence naming the exact bottleneck (e.g. "fetchRecord is called inside a loop over all active items")',
            '2. WHY: one sentence on the real impact with scale context (e.g. "triggers N database queries per request — O(N) growth with user count")',
            '3. HOW: a concrete fix only if the optimized implementation is clear from the code you read — omit if speculative',
            'No filler or conversational phrasing. Avoid vague statements like "this might be slow".',
        ],
    },
};

function renderBulletList(items: string[]): string {
    return items.map((item) => `    - ${item}`).join('\n');
}

function renderParagraphLines(items: string[]): string {
    return items.map((item) => `    ${item}`).join('\n');
}

function renderSinglePrompt(block: PromptBlock): string {
    return `  <Mission>
    ${block.mission}
  </Mission>

  <Focus>
    Report only behavior-affecting issues such as:
${renderBulletList(block.focus)}
  </Focus>

  <DoNotReport>
    Do not report:
${renderBulletList(block.doNotReport)}
  </DoNotReport>

  <ReasoningPolicy>
${renderParagraphLines(block.reasoningPolicy)}
  </ReasoningPolicy>

  <WritingPolicy>
${renderParagraphLines(block.writingPolicy)}
  </WritingPolicy>`;
}

function renderLens(name: string, block: PromptBlock): string {
    return `  <${name}Lens>
    <Mission>
      ${block.mission}
    </Mission>

    <Focus>
      Report only behavior-affecting issues such as:
${block.focus.map((item) => `      - ${item}`).join('\n')}
    </Focus>

    <DoNotReport>
      Do not report:
${block.doNotReport.map((item) => `      - ${item}`).join('\n')}
    </DoNotReport>

    <ReasoningPolicy>
${block.reasoningPolicy.map((item) => `      ${item}`).join('\n')}
    </ReasoningPolicy>

    <WritingPolicy>
${block.writingPolicy.map((item) => `      ${item}`).join('\n')}
    </WritingPolicy>
  </${name}Lens>`;
}

export function buildCategoryReviewPrompt(kind: CategoryPromptKind): string {
    return renderSinglePrompt(PROMPT_BLOCKS[kind]);
}

export function buildGeneralistReviewPrompt(): string {
    return `  <Mission>
    Find real, verifiable issues in the changed code in a single pass. You may report bug, security, or performance findings, but only when the evidence is concrete.
  </Mission>

  <Focus>
    You can report these categories:
    - bug: logic errors, contract breaks, interface/signature mismatches, state bugs, bad error handling, race conditions
    - security: exploit paths, auth/access-control flaws, data exposure, unsafe trust boundaries
    - performance: material slowdowns, N+1s, unbounded loading, hot-path blowups, blocking I/O
  </Focus>

  <DoNotReport>
    Do not report:
    - style or cosmetic issues
    - generic best practices
    - speculative concerns without evidence
    - micro-optimizations
    - the same root cause under multiple categories
  </DoNotReport>

  <ReviewLenses>
${renderLens('Bug', PROMPT_BLOCKS.bug)}

${renderLens('Security', PROMPT_BLOCKS.security)}

${renderLens('Performance', PROMPT_BLOCKS.performance)}
  </ReviewLenses>

  <CoordinationPolicy>
    Investigate broadly, then classify narrowly.
    Run three explicit review lenses before you finalize:
    1. bug lens — correctness, regressions, bad state transitions, wrong contracts
    2. security lens — exploit paths, trust boundaries, auth/access-control, unsafe inputs
    3. performance lens — material slowdowns, query amplification, unbounded loading, blocking or fanout blowups
    Do not stop after finding a bug. You must still run the security and performance lenses against the changed code before finalizing.
    - Start by understanding what the changed code now does differently.
    - Trace callers and callees before making cross-file claims.
    - Prefer concrete findings over speculative theories, but do not let a correctness issue suppress a concrete security or performance issue.
    - Escalate to security only when there is a concrete exploit path or broken authorization boundary.
    - Escalate to performance only when the code creates a material slowdown or resource blowup in a realistic path.
    - For refactors, renames, wrappers, and middleware changes, challenge whether non-obvious behavior was lost: tracing, logging, metrics, cache invalidation, authorization checks, or delegate wiring.
    - For provider/cache/adapter layers, verify that the changed implementation calls the intended delegate and preserves allow/deny semantics instead of accidentally changing trust behavior.
    - If a finding could fit multiple categories, choose the single strongest label.
    - Finish condition: before you stop, you must be able to state in your reasoning which concrete hypothesis you tested for each enabled lens, and why it did or did not produce a finding.
  </CoordinationPolicy>`;
}
