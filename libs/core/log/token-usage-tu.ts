/**
 * Token Usage — write-time `tu` derivation (perf, zero logic change).
 *
 * The Token Usage screen aggregates over `observability_telemetry`. The token
 * values live as *dotted-key* attributes (`attributes["gen_ai.usage.*"]`) which
 * Mongo can't index → the aggregation FETCHes ~1.9M fat docs (~92s → 504).
 *
 * Fix: mirror the same values into an *indexable nested* sub-doc `attributes.tu`
 * so the read aggregation is index-covered (docsExamined=0, ~2s). `tu` is a PURE
 * function of the very attributes the old pipeline already reads off the same
 * span — so the numbers are identical, it only swaps "scan fat doc" for "read
 * from index".
 *
 * It MUST live under `attributes.*` (not top-level): the @kodus/flow MongoDB
 * exporter owns the top-level doc shape and only persists what the app sets via
 * `span.setAttributes(...)`. A nested object there survives `deepSanitize`
 * untouched (it only redacts sensitive keys), so `attributes.tu.model` is a real
 * indexable path — not a flattened dotted key.
 */

/**
 * Canonical shape mirrored onto every LLM-usage span. `isByok` / `sys` encode
 * the two Token Usage views WITHOUT changing their logic:
 *   - byok=true  view → spans with `isByok === true` (attributes.type === 'byok')
 *   - byok=false view → spans with `sys === false` (i.e. NOT one of the internal
 *     system-analysis run-names — the "would-be billable" cost simulation)
 * These are two independent predicates over `type` vs `run.name`, so both flags
 * are carried; collapsing them (e.g. `type !== 'byok'`) would change the numbers.
 */
export interface TokenUsageTu {
    isByok: boolean;
    sys: boolean;
    model: string;
    input: number;
    output: number;
    total: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    /** Process area the tokens were spent in — see {@link deriveArea}. */
    area: TokenUsageArea;
}

/**
 * Low-cardinality "where was this token spent" dimension for the Token Usage
 * screen. A small FIXED set — never store raw `gen_ai.run.name` / `agent.name`
 * here (hundreds of values, some dynamic per-file/per-skill).
 */
export type TokenUsageArea =
    | 'review' // generalist code-review agents (incl. verify/dedup)
    | 'kody_rules' // kody-rules analysis, generation and sync
    | 'cross_file' // cross-file context collection + analysis
    | 'suggestions' // suggestion refinement (severity/safeguard/validation)
    | 'summary' // PR summary generation
    | 'conversation' // @kody conversation
    | 'system' // internal system analysis (SYSTEM_RUN_NAMES)
    | 'other';

/**
 * Exact run-names of the suggestion-refinement stages. Kept as a list (not a
 * regex) so the Mongo backfill can mirror it with a plain `$in` — the backfill
 * in libs/core/infrastructure/database/mongo/token-usage/backfill-tu.ts keeps
 * a copy, asserted equal by token-usage-tu.spec.ts.
 */
export const SUGGESTION_RUN_NAMES: ReadonlySet<string> = new Set([
    'severityAnalysis',
    'validateWithLLM',
    'checkSuggestionSimplicity',
    'repeatedCodeReviewSuggestionClustering',
]);

/**
 * Internal analysis operations excluded from the byok=false ("would-be
 * billable") view. Kept in sync with `LLMAnalysisService` method names — the
 * read path historically referenced `LLMAnalysisService.prototype.*.name`, but
 * this low-level core module cannot import from `code-review`, so the literals
 * are pinned here and asserted against the real method names by a unit test in
 * the code-review package.
 */
export const SYSTEM_RUN_NAMES: ReadonlySet<string> = new Set([
    'selectReviewMode',
    'validateImplementedSuggestions',
    'generateCodeSuggestions',
    'analyzeASTWithAI',
]);

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Maps a span's run/agent identifiers onto the fixed {@link TokenUsageArea}
 * set. Driven by `gen_ai.run.name` — the one attribute every usage span
 * carries (the LangChain path sets no `agent.name`/`agent.phase`). Rule order
 * matters: system first (consistent with the `sys` flag), then the most
 * specific name families. Mirrored as an aggregation `$switch` in the Mongo
 * backfill (backfill-tu.ts) — keep the two in sync.
 */
export function deriveArea(
    runName: unknown,
    phase?: unknown,
): TokenUsageArea {
    const rn = typeof runName === 'string' ? runName : '';

    if (SYSTEM_RUN_NAMES.has(rn)) return 'system';
    // kodyRulesAnalyzeCodeWithAI, generateKodyRules.*, prLevelKodyRules*,
    // *KodyRulesAnalyzeCodeWithAI, kodyRulesFileToRules*, kodyMemoryResolution…
    if (/kody.?rules?/i.test(rn) || rn.startsWith('kodyMemory')) {
        return 'kody_rules';
    }
    if (rn.startsWith('crossFile')) return 'cross_file';
    if (rn.startsWith('code-review') || rn.startsWith('analyzeCodeWithAI')) {
        return 'review';
    }
    if (SUGGESTION_RUN_NAMES.has(rn) || rn.startsWith('safeguard')) {
        return 'suggestions';
    }
    if (rn.startsWith('generateSummaryPR')) return 'summary';
    if (rn === 'conversationAgent' || phase === 'conversation') {
        return 'conversation';
    }
    return 'other';
}

/**
 * Derives `tu` from a span's flat dotted-key attribute object. Returns `null`
 * for spans with no LLM usage (wrapper/parent spans) so callers can no-op.
 */
export function deriveTu(
    attrs: Record<string, any> | undefined | null,
): TokenUsageTu | null {
    if (!attrs) {
        return null;
    }
    const total = attrs['gen_ai.usage.total_tokens'];
    if (typeof total !== 'number' || total <= 0) {
        return null;
    }

    const rawModel = attrs['gen_ai.response.model'];
    // Canonical name collapses `google_gemini:gemini-2.5-pro` → `gemini-2.5-pro`
    // (last segment after ':'), identical to the read pipeline.
    const model =
        typeof rawModel === 'string' && rawModel
            ? rawModel.split(':').pop() || ''
            : '';

    const input = n(attrs['gen_ai.usage.input_tokens']);
    const runName = attrs['gen_ai.run.name'];

    return {
        isByok: attrs['type'] === 'byok',
        sys: typeof runName === 'string' && SYSTEM_RUN_NAMES.has(runName),
        model,
        input,
        output: n(attrs['gen_ai.usage.output_tokens']),
        total,
        reasoning: n(attrs['gen_ai.usage.reasoning_tokens']),
        cacheRead: n(attrs['gen_ai.usage.cache_read_input_tokens']),
        cacheWrite: n(attrs['gen_ai.usage.cache_creation_input_tokens']),
        area: deriveArea(runName, attrs['agent.phase']),
    };
}
